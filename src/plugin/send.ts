/**
 * The send path of the plugin: suppression check, Resend call, delivery log.
 */

import type { PluginContext } from "emdash";

import { createResendClient, toTagValue, type ResendClient } from "../client.js";
import { isResendError, redactSecrets, ResendError } from "../errors.js";
import { messageIdempotencyKey } from "./idempotency.js";
import { recordSend } from "./log.js";
import { maskAddress } from "./privacy.js";
import { findSuppression } from "./suppression.js";
import type { RuntimeConfig } from "./types.js";

/** Time limit for one send with all retries. The hook timeout is longer. */
export const SEND_DEADLINE_MS = 25_000;

/** Timeout of the `email:deliver` hook in EmDash. */
export const HOOK_TIMEOUT_MS = 30_000;

export interface KitMessage {
	to: string;
	cc?: string[];
	replyTo?: string;
	subject: string;
	text: string;
	html?: string;
	/** Origin of the message: `system`, a plugin ID, `admin`, or `test`. */
	source: string;
}

export interface SendDeps {
	/** Factory for the client. Tests replace it. */
	createClient?: typeof createResendClient;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

/** Create a client that uses the HTTP access of the plugin context. */
export function clientForContext(
	ctx: PluginContext,
	config: RuntimeConfig,
	overrides: { timeoutMs?: number; maxRetries?: number; deadlineMs?: number } = {},
	deps: SendDeps = {},
): ResendClient {
	const http = ctx.http;
	return (deps.createClient ?? createResendClient)({
		getApiKey: () => config.apiKey?.value,
		baseUrl: config.baseUrl,
		timeoutMs: overrides.timeoutMs ?? config.timeoutMs,
		maxRetries: overrides.maxRetries ?? config.maxRetries,
		deadlineMs: overrides.deadlineMs ?? SEND_DEADLINE_MS,
		userAgent: `emdash-resend-kit/${ctx.plugin.version} (emdash plugin)`,
		...(http ? { fetch: (url: string, init?: RequestInit) => http.fetch(url, init) } : {}),
		...(deps.sleep ? { sleep: deps.sleep } : {}),
		...(deps.random ? { random: deps.random } : {}),
		...(deps.now ? { now: deps.now } : {}),
	});
}

/**
 * Send one message through Resend and record the result.
 *
 * @throws {ResendError} when the configuration is incomplete, when the
 * recipient is on the suppression list, or when Resend rejects the email.
 */
export async function sendMessage(
	ctx: PluginContext,
	config: RuntimeConfig,
	message: KitMessage,
	deps: SendDeps = {},
): Promise<{ id: string }> {
	const now = deps.now ?? Date.now;
	const secrets = [config.apiKey?.value, config.webhookSecret?.value];
	const base = { to: message.to, subject: message.subject, source: message.source, secrets };

	const fail = async (error: ResendError): Promise<never> => {
		await recordSend(
			ctx,
			config.recipientPrivacy,
			config.logging,
			{
				...base,
				resendId: null,
				status: error.code === "suppressed" ? "suppressed" : "failed",
				error: error.message,
				errorCode: error.code,
				attempts: error.attempts,
			},
			now(),
		);
		ctx.log.error("Resend did not accept an email.", {
			to: maskAddress(message.to),
			source: message.source,
			code: error.code,
			status: error.status,
			attempts: error.attempts,
			reason: redactSecrets(error.message, secrets),
		});
		throw error;
	};

	if (!config.apiKey) {
		return fail(
			new ResendError({
				code: "not_configured",
				message:
					"The Resend API key is missing. Set the RESEND_API_KEY environment variable or secret, or enter the key in the Resend settings of the admin." +
					(config.secretSettingError ? ` ${config.secretSettingError}` : ""),
			}),
		);
	}
	if (!config.from) {
		return fail(
			new ResendError({
				code: "not_configured",
				message:
					"The sender address is missing. Set `from` in the plugin options or in the Resend settings of the admin.",
			}),
		);
	}

	let cc = message.cc?.filter((address) => address.trim().length > 0) ?? [];
	if (config.suppression) {
		const suppressed = await findSuppression(ctx, message.to);
		if (suppressed) {
			return fail(
				new ResendError({
					code: "suppressed",
					message: `The recipient is on the suppression list (${suppressed.reason}). The plugin did not send the email.`,
				}),
			);
		}
		const kept: string[] = [];
		for (const address of cc) {
			if (!(await findSuppression(ctx, address))) kept.push(address);
		}
		cc = kept;
	}

	const replyTo = message.replyTo ?? config.replyTo ?? undefined;
	const tags: Record<string, string> = { ...config.tags };
	if (config.sourceTag) tags[config.sourceTag] = toTagValue(message.source);

	const idempotencyKey = await messageIdempotencyKey(
		{
			from: config.from,
			to: message.to,
			cc,
			replyTo,
			subject: message.subject,
			text: message.text,
			html: message.html,
			source: message.source,
		},
		config.idempotencyWindowSeconds,
		now(),
	);

	let result: { id: string };
	try {
		result = await clientForContext(ctx, config, {}, deps).send(
			{
				from: config.from,
				to: message.to,
				...(cc.length > 0 ? { cc } : {}),
				...(replyTo ? { replyTo } : {}),
				subject: message.subject,
				text: message.text,
				...(message.html ? { html: message.html } : {}),
				...(Object.keys(config.headers).length > 0 ? { headers: config.headers } : {}),
				tags,
			},
			{ idempotencyKey },
		);
	} catch (error) {
		if (isResendError(error)) return fail(error);
		const reason = error instanceof Error ? error.message : String(error);
		return fail(
			new ResendError({
				code: "network_error",
				message: `The request to Resend failed: ${redactSecrets(reason, secrets)}`,
				cause: error,
			}),
		);
	}

	await recordSend(
		ctx,
		config.recipientPrivacy,
		config.logging,
		{ ...base, resendId: result.id, status: "sent" },
		now(),
	);
	ctx.log.info("Resend accepted an email.", {
		to: maskAddress(message.to),
		source: message.source,
		id: result.id,
	});
	return result;
}
