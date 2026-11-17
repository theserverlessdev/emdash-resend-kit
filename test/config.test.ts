import { describe, expect, it } from "vitest";

import {
	apiHost,
	isEmailAddress,
	resolveConfig,
	SETTING_KEYS,
	validateOptions,
} from "../src/plugin/config.js";
import { envSources, fakeContext, TEST_KEY, TEST_WEBHOOK_SECRET } from "./helpers/fake-context.js";

describe("validateOptions", () => {
	it("accepts no options and valid options", () => {
		expect(validateOptions(undefined)).toEqual({});
		const options = {
			from: "Site <site@mail.example.com>",
			replyTo: "hello@example.com",
			apiKeyEnv: "MY_RESEND_KEY",
			webhookSecretEnv: "MY_SECRET",
			baseUrl: "https://proxy.example.com",
			tags: { env: "production" },
			headers: { "X-Site": "1" },
			sourceTag: "source",
			timeoutMs: 5000,
			maxRetries: 0,
			idempotencyWindowSeconds: 0,
			logging: false,
			recipientPrivacy: "hashed" as const,
			retentionDays: 7,
			suppression: true,
			webhookToleranceSeconds: 60,
		};
		expect(validateOptions(options)).toBe(options);
		expect(
			validateOptions({ from: { email: "site@mail.example.com", name: "Site" } }),
		).toBeTruthy();
		expect(validateOptions({ baseUrl: "http://localhost:8787" })).toBeTruthy();
		expect(validateOptions({ baseUrl: "http://127.0.0.1:8787" })).toBeTruthy();
		expect(validateOptions({ sourceTag: false })).toBeTruthy();
	});

	it.each(["apiKey", "api_key", "key", "webhookSecret", "signingSecret", "secret"])(
		"rejects a secret in the options (%s)",
		(key) => {
			expect(() => validateOptions({ [key]: "re_123" } as never)).toThrow(
				/Do not put a secret in the plugin options/,
			);
		},
	);

	it.each([
		[{ from: "not-an-address" }, /"from" is not a valid sender/],
		[{ from: { email: "nope" } }, /"from" is not a valid sender/],
		[{ replyTo: "nope" }, /"replyTo" is not a valid email address/],
		[
			{ apiKeyEnv: "re_live_secret-value" },
			/"apiKeyEnv" must be the name of an environment variable/,
		],
		[{ webhookSecretEnv: "whsec_abc=" }, /"webhookSecretEnv" must be the name/],
		[{ baseUrl: "not a url" }, /"baseUrl" is not a valid URL/],
		[{ baseUrl: "http://proxy.example.com" }, /"baseUrl" must use https/],
		[{ tags: { "bad tag": "x" } }, /Invalid tag/],
		[{ sourceTag: "bad tag" }, /"sourceTag" is not a valid tag name/],
		[{ recipientPrivacy: "none" }, /"recipientPrivacy" must be/],
		[{ timeoutMs: 5 }, /"timeoutMs" must be a number from 100 to 60000/],
		[{ maxRetries: 9 }, /"maxRetries" must be a number from 0 to 5/],
		[{ retentionDays: 0 }, /"retentionDays"/],
		[{ idempotencyWindowSeconds: -1 }, /"idempotencyWindowSeconds"/],
		[{ webhookToleranceSeconds: "60" }, /"webhookToleranceSeconds"/],
	])("rejects %o", (options, message) => {
		expect(() => validateOptions(options as never)).toThrow(message);
	});

	it("rejects options that are not an object", () => {
		expect(() => validateOptions([] as never)).toThrow(/must be an object/);
		expect(() => validateOptions("x" as never)).toThrow(/must be an object/);
	});
});

describe("helpers", () => {
	it("checks an email address", () => {
		expect(isEmailAddress("a@example.com")).toBe(true);
		expect(isEmailAddress(" a@example.com ")).toBe(true);
		expect(isEmailAddress("a@example")).toBe(false);
		expect(isEmailAddress("a b@example.com")).toBe(false);
		expect(isEmailAddress("Name <a@example.com>")).toBe(false);
	});

	it("returns the API host", () => {
		expect(apiHost(undefined)).toBe("api.resend.com");
		expect(apiHost("http://127.0.0.1:9999/x")).toBe("127.0.0.1");
	});
});

describe("resolveConfig", () => {
	it("uses the defaults when nothing is set", async () => {
		const { ctx } = fakeContext();
		const config = await resolveConfig(ctx, {}, envSources());
		expect(config).toEqual({
			from: null,
			replyTo: null,
			baseUrl: "https://api.resend.com",
			tags: {},
			headers: {},
			sourceTag: "emdash_source",
			timeoutMs: 10_000,
			maxRetries: 2,
			idempotencyWindowSeconds: 60,
			logging: true,
			recipientPrivacy: "full",
			retentionDays: 30,
			suppression: false,
			webhookToleranceSeconds: 300,
			apiKey: null,
			webhookSecret: null,
			storedApiKey: false,
			storedWebhookSecret: false,
			secretSettingError: null,
		});
	});

	it("uses the options", async () => {
		const { ctx } = fakeContext();
		const config = await resolveConfig(
			ctx,
			{
				from: { email: "site@mail.example.com", name: "Site" },
				replyTo: "hello@example.com",
				baseUrl: "https://proxy.example.com/",
				tags: { env: "test" },
				headers: { "X-A": "1" },
				sourceTag: false,
				timeoutMs: 2000,
				maxRetries: 1,
				idempotencyWindowSeconds: 0,
				logging: false,
				recipientPrivacy: "hashed",
				retentionDays: 5,
				suppression: true,
				webhookToleranceSeconds: 30,
			},
			envSources(),
		);
		expect(config).toMatchObject({
			from: "Site <site@mail.example.com>",
			replyTo: "hello@example.com",
			baseUrl: "https://proxy.example.com",
			tags: { env: "test" },
			headers: { "X-A": "1" },
			sourceTag: false,
			timeoutMs: 2000,
			maxRetries: 1,
			idempotencyWindowSeconds: 0,
			logging: false,
			recipientPrivacy: "hashed",
			retentionDays: 5,
			suppression: true,
			webhookToleranceSeconds: 30,
		});
	});

	it("lets an admin setting replace an option", async () => {
		const { ctx, settings } = fakeContext();
		settings.values.set(SETTING_KEYS.fromEmail, "news@mail.example.com");
		settings.values.set(SETTING_KEYS.fromName, "News");
		settings.values.set(SETTING_KEYS.replyTo, "editor@example.com");
		settings.values.set(SETTING_KEYS.logging, false);
		settings.values.set(SETTING_KEYS.recipientPrivacy, "masked");
		settings.values.set(SETTING_KEYS.retentionDays, "14");
		settings.values.set(SETTING_KEYS.suppression, true);
		const config = await resolveConfig(
			ctx,
			{
				from: "site@mail.example.com",
				replyTo: "hello@example.com",
				logging: true,
				retentionDays: 90,
			},
			envSources(),
		);
		expect(config).toMatchObject({
			from: "News <news@mail.example.com>",
			replyTo: "editor@example.com",
			logging: false,
			recipientPrivacy: "masked",
			retentionDays: 14,
			suppression: true,
		});
	});

	it("ignores an invalid admin setting", async () => {
		const { ctx, settings } = fakeContext();
		settings.values.set(SETTING_KEYS.fromEmail, "broken");
		settings.values.set(SETTING_KEYS.replyTo, "broken");
		settings.values.set(SETTING_KEYS.recipientPrivacy, "none");
		settings.values.set(SETTING_KEYS.retentionDays, 0);
		settings.values.set(SETTING_KEYS.logging, "yes");
		const config = await resolveConfig(ctx, { from: "site@mail.example.com" }, envSources());
		expect(config).toMatchObject({
			from: "site@mail.example.com",
			replyTo: null,
			recipientPrivacy: "full",
			retentionDays: 30,
			logging: true,
		});
	});

	it("reads the secrets from the environment", async () => {
		const { ctx } = fakeContext();
		const config = await resolveConfig(
			ctx,
			{},
			envSources({ RESEND_API_KEY: TEST_KEY, EMDASH_RESEND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET }),
		);
		expect(config.apiKey).toEqual({
			value: TEST_KEY,
			source: { kind: "env", name: "RESEND_API_KEY", runtime: "process" },
		});
		expect(config.webhookSecret?.source).toEqual({
			kind: "env",
			name: "EMDASH_RESEND_WEBHOOK_SECRET",
			runtime: "process",
		});
		expect(config.storedApiKey).toBe(false);
	});

	it("reads the variable that the options name", async () => {
		const { ctx } = fakeContext();
		const config = await resolveConfig(
			ctx,
			{ apiKeyEnv: "MAIL_KEY", webhookSecretEnv: "MAIL_HOOK" },
			envSources({
				MAIL_KEY: "re_custom",
				MAIL_HOOK: "whsec_custom",
				RESEND_API_KEY: "re_default",
			}),
		);
		expect(config.apiKey?.value).toBe("re_custom");
		expect(config.webhookSecret?.value).toBe("whsec_custom");
	});

	it("reads the secrets from the settings when the environment has none", async () => {
		const { ctx, settings } = fakeContext();
		settings.values.set(SETTING_KEYS.apiKey, "re_stored");
		settings.values.set(SETTING_KEYS.webhookSecret, "whsec_stored");
		const config = await resolveConfig(ctx, {}, envSources());
		expect(config.apiKey).toEqual({ value: "re_stored", source: { kind: "setting" } });
		expect(config.webhookSecret).toEqual({ value: "whsec_stored", source: { kind: "setting" } });
		expect(config.storedApiKey).toBe(true);
		expect(config.storedWebhookSecret).toBe(true);
	});

	it("gives the environment priority over a stored secret", async () => {
		const { ctx, settings } = fakeContext();
		settings.values.set(SETTING_KEYS.apiKey, "re_stored");
		const config = await resolveConfig(
			ctx,
			{},
			envSources({ RESEND_API_KEY: "re_process" }, { RESEND_API_KEY: "re_worker" }),
		);
		expect(config.apiKey).toEqual({
			value: "re_worker",
			source: { kind: "env", name: "RESEND_API_KEY", runtime: "worker" },
		});
		expect(config.storedApiKey).toBe(true);
	});

	it("keeps the other settings when a stored secret is unreadable", async () => {
		const { ctx, settings } = fakeContext();
		settings.values.set(SETTING_KEYS.apiKey, { $emdash: "plugin-setting" });
		settings.values.set(SETTING_KEYS.fromEmail, "news@mail.example.com");
		settings.unreadable.add(SETTING_KEYS.apiKey);
		const config = await resolveConfig(ctx, {}, envSources());
		expect(config.from).toBe("news@mail.example.com");
		expect(config.apiKey).toBeNull();
		expect(config.secretSettingError).toContain("EMDASH_ENCRYPTION_KEY");

		const withEnv = await resolveConfig(ctx, {}, envSources({ RESEND_API_KEY: TEST_KEY }));
		expect(withEnv.apiKey?.value).toBe(TEST_KEY);
	});
});
