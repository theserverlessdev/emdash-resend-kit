/**
 * Validation of the plugin options and resolution of the runtime configuration.
 */

import type { PluginContext } from "emdash";

import { formatAddress, normaliseTags } from "../client.js";
import {
	API_KEY_ENV_NAMES,
	envNames,
	resolveEnvSecret,
	WEBHOOK_SECRET_ENV_NAMES,
	type EnvSources,
	type ResolvedSecret,
} from "../secrets.js";
import {
	DEFAULTS,
	type RecipientPrivacy,
	type ResendKitOptions,
	type RuntimeConfig,
} from "./types.js";

const PREFIX = "[emdash-resend-kit]";
const FORBIDDEN_OPTION_KEYS = [
	"apiKey",
	"api_key",
	"key",
	"webhookSecret",
	"signingSecret",
	"secret",
] as const;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const EMAIL_PATTERN = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const PRIVACY_VALUES: ReadonlyArray<RecipientPrivacy> = ["full", "masked", "hashed"];

/** Names of the plugin settings in EmDash. */
export const SETTING_KEYS = {
	apiKey: "apiKey",
	webhookSecret: "webhookSecret",
	fromEmail: "fromEmail",
	fromName: "fromName",
	replyTo: "replyTo",
	logging: "logging",
	recipientPrivacy: "recipientPrivacy",
	retentionDays: "retentionDays",
	suppression: "suppression",
} as const;

export function isEmailAddress(value: string): boolean {
	return EMAIL_PATTERN.test(value.trim());
}

/** Return the host of the API base URL. `allowedHosts` uses this value. */
export function apiHost(baseUrl: string | undefined): string {
	return new URL(baseUrl ?? DEFAULTS.baseUrl).hostname;
}

/**
 * Validate the plugin options. Throw an `Error` with a clear message.
 *
 * The check runs when Astro loads the configuration, so a mistake stops the
 * build and not the first send.
 */
export function validateOptions(options: ResendKitOptions | undefined): ResendKitOptions {
	const value = options ?? {};
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${PREFIX} The options must be an object.`);
	}
	for (const key of FORBIDDEN_OPTION_KEYS) {
		if (key in value) {
			throw new Error(
				`${PREFIX} Do not put a secret in the plugin options ("${key}"). EmDash writes the options into the server bundle. Set the RESEND_API_KEY and RESEND_WEBHOOK_SECRET environment variables, or use "apiKeyEnv" and "webhookSecretEnv" to name other variables.`,
			);
		}
	}
	if (value.from !== undefined) {
		const email = typeof value.from === "string" ? value.from : value.from?.email;
		const bare = /<([^<>]+)>\s*$/.exec(email ?? "")?.[1] ?? email ?? "";
		if (!isEmailAddress(bare)) {
			throw new Error(
				`${PREFIX} "from" is not a valid sender. Use "website@mail.example.com", "Website <website@mail.example.com>", or { email, name }.`,
			);
		}
	}
	if (value.replyTo !== undefined && !isEmailAddress(value.replyTo)) {
		throw new Error(`${PREFIX} "replyTo" is not a valid email address.`);
	}
	for (const name of ["apiKeyEnv", "webhookSecretEnv"] as const) {
		const envName = value[name];
		if (envName !== undefined && !ENV_NAME_PATTERN.test(envName)) {
			throw new Error(
				`${PREFIX} "${name}" must be the name of an environment variable, for example "RESEND_API_KEY". Do not put the secret itself here.`,
			);
		}
	}
	if (value.baseUrl !== undefined) {
		let url: URL;
		try {
			url = new URL(value.baseUrl);
		} catch {
			throw new Error(`${PREFIX} "baseUrl" is not a valid URL.`);
		}
		const local = url.hostname === "localhost" || url.hostname === "127.0.0.1";
		if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
			throw new Error(`${PREFIX} "baseUrl" must use https. Plain http is for localhost only.`);
		}
	}
	if (value.tags) {
		try {
			normaliseTags(value.tags);
		} catch (error) {
			throw new Error(`${PREFIX} ${(error as Error).message}`, { cause: error });
		}
	}
	if (typeof value.sourceTag === "string") {
		try {
			normaliseTags({ [value.sourceTag]: "x" });
		} catch {
			throw new Error(`${PREFIX} "sourceTag" is not a valid tag name.`);
		}
	}
	if (value.recipientPrivacy !== undefined && !PRIVACY_VALUES.includes(value.recipientPrivacy)) {
		throw new Error(`${PREFIX} "recipientPrivacy" must be "full", "masked", or "hashed".`);
	}
	const numbers: Array<[keyof ResendKitOptions, number, number]> = [
		["timeoutMs", 100, 60_000],
		["maxRetries", 0, 5],
		["idempotencyWindowSeconds", 0, 86_400],
		["retentionDays", 1, 3650],
		["webhookToleranceSeconds", 1, 3600],
	];
	for (const [name, min, max] of numbers) {
		const number = value[name];
		if (number === undefined) continue;
		if (typeof number !== "number" || !Number.isFinite(number) || number < min || number > max) {
			throw new Error(`${PREFIX} "${name}" must be a number from ${min} to ${max}.`);
		}
	}
	return value;
}

function asString(value: unknown): string | null {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asBoolean(value: unknown): boolean | null {
	return typeof value === "boolean" ? value : null;
}

function asNumber(value: unknown): number | null {
	const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
	return typeof number === "number" && Number.isFinite(number) ? number : null;
}

interface StoredSettings {
	values: Map<string, unknown>;
	secretError: string | null;
}

/** Read all settings. A secret that EmDash cannot decrypt does not stop the read. */
async function readSettings(ctx: PluginContext): Promise<StoredSettings> {
	const values = new Map<string, unknown>();
	try {
		for (const entry of await ctx.settings.list()) values.set(entry.key, entry.value);
		return { values, secretError: null };
	} catch {
		// One secret is unreadable. Read each setting alone to keep the others.
	}
	let secretError: string | null = null;
	for (const key of Object.values(SETTING_KEYS)) {
		try {
			const value = await ctx.settings.get<unknown>(key);
			if (value !== null) values.set(key, value);
		} catch {
			secretError =
				"EmDash cannot decrypt a stored secret. Make sure that EMDASH_ENCRYPTION_KEY is set and correct, then save the secret again.";
		}
	}
	return { values, secretError };
}

function pickSecret(env: ResolvedSecret | null, setting: string | null): ResolvedSecret | null {
	if (env) return env;
	return setting ? { value: setting, source: { kind: "setting" } } : null;
}

/**
 * Merge options, admin settings, and secrets to one configuration.
 *
 * - An admin setting has priority over an option.
 * - An environment variable has priority over a stored secret.
 */
export async function resolveConfig(
	ctx: PluginContext,
	options: ResendKitOptions,
	envSources?: EnvSources,
): Promise<RuntimeConfig> {
	const { values, secretError } = await readSettings(ctx);

	const settingEmail = asString(values.get(SETTING_KEYS.fromEmail));
	const settingName = asString(values.get(SETTING_KEYS.fromName));
	let from: string | null = null;
	if (settingEmail && isEmailAddress(settingEmail)) {
		from = formatAddress({ email: settingEmail, name: settingName ?? undefined });
	} else if (options.from) {
		from = formatAddress(options.from);
	}

	const settingReplyTo = asString(values.get(SETTING_KEYS.replyTo));
	const privacySetting = asString(values.get(SETTING_KEYS.recipientPrivacy));
	const retentionSetting = asNumber(values.get(SETTING_KEYS.retentionDays));

	const [apiKeyEnv, webhookSecretEnv] = await Promise.all([
		resolveEnvSecret(envNames(options.apiKeyEnv, API_KEY_ENV_NAMES), envSources),
		resolveEnvSecret(envNames(options.webhookSecretEnv, WEBHOOK_SECRET_ENV_NAMES), envSources),
	]);

	return {
		from,
		replyTo:
			settingReplyTo && isEmailAddress(settingReplyTo) ? settingReplyTo : (options.replyTo ?? null),
		baseUrl: (options.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ""),
		tags: options.tags ?? {},
		headers: options.headers ?? {},
		sourceTag: options.sourceTag ?? DEFAULTS.sourceTag,
		timeoutMs: options.timeoutMs ?? DEFAULTS.timeoutMs,
		maxRetries: options.maxRetries ?? DEFAULTS.maxRetries,
		idempotencyWindowSeconds: options.idempotencyWindowSeconds ?? DEFAULTS.idempotencyWindowSeconds,
		logging: asBoolean(values.get(SETTING_KEYS.logging)) ?? options.logging ?? DEFAULTS.logging,
		recipientPrivacy:
			privacySetting && PRIVACY_VALUES.includes(privacySetting as RecipientPrivacy)
				? (privacySetting as RecipientPrivacy)
				: (options.recipientPrivacy ?? DEFAULTS.recipientPrivacy),
		retentionDays:
			retentionSetting !== null && retentionSetting >= 1
				? Math.floor(retentionSetting)
				: (options.retentionDays ?? DEFAULTS.retentionDays),
		suppression:
			asBoolean(values.get(SETTING_KEYS.suppression)) ??
			options.suppression ??
			DEFAULTS.suppression,
		webhookToleranceSeconds: options.webhookToleranceSeconds ?? DEFAULTS.webhookToleranceSeconds,
		apiKey: pickSecret(apiKeyEnv, asString(values.get(SETTING_KEYS.apiKey))),
		webhookSecret: pickSecret(webhookSecretEnv, asString(values.get(SETTING_KEYS.webhookSecret))),
		storedApiKey: asString(values.get(SETTING_KEYS.apiKey)) !== null,
		storedWebhookSecret: asString(values.get(SETTING_KEYS.webhookSecret)) !== null,
		secretSettingError: secretError,
	};
}
