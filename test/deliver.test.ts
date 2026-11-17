import { describe, expect, it } from "vitest";

import { createPlugin } from "../src/index.js";
import { isResendError } from "../src/errors.js";
import { SETTING_KEYS } from "../src/plugin/config.js";
import { addSuppression } from "../src/plugin/suppression.js";
import type { EmailRecord, ResendKitOptions } from "../src/plugin/types.js";
import { envSources, fakeContext, TEST_KEY, type FetchReply } from "./helpers/fake-context.js";

const NOW = Date.parse("2026-11-17T12:00:30.000Z");
const MESSAGE = {
	to: "person@example.com",
	subject: "Your invite",
	text: "Open the link.",
	html: "<p>Open the link.</p>",
};

function setup(
	options: ResendKitOptions = { from: "Site <site@mail.example.com>" },
	replies: FetchReply[] = [],
	env: Record<string, unknown> = { RESEND_API_KEY: TEST_KEY },
) {
	const fake = fakeContext(replies);
	const sleeps: number[] = [];
	const plugin = createPlugin(options, {
		env: envSources(env),
		now: () => NOW,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0,
	});
	const hook = plugin.hooks["email:deliver"]!;
	const deliver = (message: Record<string, unknown> = MESSAGE, source = "system") =>
		hook.handler({ message, source } as never, fake.ctx);
	const records = () =>
		[...fake.emails.docs.values()].map((item) => item.data as unknown as EmailRecord);
	return { fake, plugin, hook, deliver, records, sleeps };
}

async function failure(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (isResendError(error)) return error;
		throw error;
	}
	throw new Error("The call did not fail.");
}

describe("email:deliver hook", () => {
	it("is exclusive and has a timeout that is longer than the send deadline", () => {
		const { hook } = setup();
		expect(hook.exclusive).toBe(true);
		expect(hook.timeout).toBe(30_000);
	});

	it("sends each field of the EmDash message to Resend", async () => {
		const { fake, deliver } = setup({
			from: "Site <site@mail.example.com>",
			replyTo: "hello@example.com",
		});
		await deliver(
			{ ...MESSAGE, cc: ["cc1@example.com", "cc2@example.com"], replyTo: "author@example.com" },
			"emdash-forms",
		);
		expect(fake.http.calls).toHaveLength(1);
		const call = fake.http.calls[0]!;
		expect(call.url).toBe("https://api.resend.com/emails");
		expect(call.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
		expect(call.headers["user-agent"]).toContain("emdash-resend-kit/");
		expect(call.body).toEqual({
			from: "Site <site@mail.example.com>",
			to: ["person@example.com"],
			cc: ["cc1@example.com", "cc2@example.com"],
			reply_to: ["author@example.com"],
			subject: "Your invite",
			text: "Open the link.",
			html: "<p>Open the link.</p>",
			tags: [{ name: "emdash_source", value: "emdash-forms" }],
		});
	});

	it("uses the default reply-to, the default tags, and the default headers", async () => {
		const { fake, deliver } = setup({
			from: "site@mail.example.com",
			replyTo: "hello@example.com",
			tags: { env: "test" },
			headers: { "X-Site": "example" },
			sourceTag: "origin",
		});
		await deliver({ to: "person@example.com", subject: "S", text: "T" }, "@scope/plugin");
		expect(fake.http.calls[0]!.body).toEqual({
			from: "site@mail.example.com",
			to: ["person@example.com"],
			reply_to: ["hello@example.com"],
			subject: "S",
			text: "T",
			headers: { "X-Site": "example" },
			tags: [
				{ name: "env", value: "test" },
				{ name: "origin", value: "_scope_plugin" },
			],
		});
	});

	it("sends no source tag when the option is false", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", sourceTag: false });
		await deliver();
		expect((fake.http.calls[0]!.body as Record<string, unknown>).tags).toBeUndefined();
	});

	it("uses a deterministic idempotency key in one time window", async () => {
		const { fake, deliver } = setup();
		await deliver();
		await deliver();
		await deliver({ ...MESSAGE, subject: "Other" });
		const keys = fake.http.calls.map((call) => call.headers["idempotency-key"]);
		expect(keys[0]).toMatch(/^emdash\/\d+\/[0-9a-f]{64}$/);
		expect(keys[1]).toBe(keys[0]);
		expect(keys[2]).not.toBe(keys[0]);
	});

	it("uses a random idempotency key when the window is 0", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", idempotencyWindowSeconds: 0 });
		await deliver();
		await deliver();
		expect(fake.http.calls[0]!.headers["idempotency-key"]).not.toBe(
			fake.http.calls[1]!.headers["idempotency-key"],
		);
	});

	it("records a sent email and writes a log line without the address", async () => {
		const { fake, deliver, records } = setup({ from: "site@mail.example.com" }, [
			{ status: 200, body: { id: "re-123" } },
		]);
		await deliver();
		expect(records()).toEqual([
			expect.objectContaining({
				resendId: "re-123",
				to: "person@example.com",
				subject: "Your invite",
				status: "sent",
				source: "system",
				createdAt: "2026-11-17T12:00:30.000Z",
			}),
		]);
		expect(fake.emails.docs.has("re-123")).toBe(true);
		const info = fake.logs.find((line) => line.level === "info");
		expect(info?.data).toEqual({ to: "p***@example.com", source: "system", id: "re-123" });
		expect(JSON.stringify(fake.logs)).not.toContain(TEST_KEY);
	});

	it("retries a 429 response and a 5xx response with the same key", async () => {
		const { fake, deliver, sleeps, records } = setup({ from: "site@mail.example.com" }, [
			{
				status: 429,
				body: { name: "rate_limit_exceeded", message: "slow down" },
				headers: { "retry-after": "1" },
			},
			{ status: 500, body: { name: "application_error", message: "oops" } },
			{ status: 200, body: { id: "re-ok" } },
		]);
		await deliver();
		expect(fake.http.calls).toHaveLength(3);
		expect(new Set(fake.http.calls.map((call) => call.headers["idempotency-key"])).size).toBe(1);
		expect(sleeps).toEqual([1000, 500]);
		expect(records()[0]?.status).toBe("sent");
	});

	it("honours the maxRetries option", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", maxRetries: 0 }, [
			{ status: 500, body: { name: "application_error", message: "oops" } },
		]);
		expect((await failure(deliver())).code).toBe("server_error");
		expect(fake.http.calls).toHaveLength(1);
	});

	it("throws a typed error, records the failure, and logs no secret", async () => {
		const { fake, deliver, records } = setup({ from: "site@mail.example.com" }, [
			{
				status: 403,
				body: {
					name: "validation_error",
					message:
						"The mail.example.com domain is not verified. Please, add and verify your domain.",
				},
			},
		]);
		const error = await failure(deliver());
		expect(error.code).toBe("domain_not_verified");
		expect(error.message).toContain("The sender domain is not verified in Resend.");
		expect(records()).toEqual([
			expect.objectContaining({
				resendId: null,
				status: "failed",
				errorCode: "domain_not_verified",
				error: expect.stringContaining("not verified"),
			}),
		]);
		const line = fake.logs.find((item) => item.level === "error");
		expect(line?.data).toMatchObject({
			to: "p***@example.com",
			code: "domain_not_verified",
			status: 403,
		});
		expect(JSON.stringify(fake.logs)).not.toContain(TEST_KEY);
		expect(fake.stats.docs.get("2026-11-17")?.data).toMatchObject({ failed: 1, sent: 0 });
	});

	it("fails with a clear message when the API key is missing", async () => {
		const { fake, deliver, records } = setup({ from: "site@mail.example.com" }, [], {});
		const error = await failure(deliver());
		expect(error.code).toBe("not_configured");
		expect(error.message).toContain("The Resend API key is missing.");
		expect(fake.http.calls).toHaveLength(0);
		expect(records()[0]).toMatchObject({ status: "failed", errorCode: "not_configured" });
	});

	it("adds the decryption problem to the missing key message", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com" }, [], {});
		fake.settings.values.set(SETTING_KEYS.apiKey, { encrypted: true });
		fake.settings.unreadable.add(SETTING_KEYS.apiKey);
		expect((await failure(deliver())).message).toContain("EMDASH_ENCRYPTION_KEY");
	});

	it("fails with a clear message when the sender is missing", async () => {
		const { fake, deliver } = setup({});
		const error = await failure(deliver());
		expect(error.code).toBe("not_configured");
		expect(error.message).toContain("The sender address is missing.");
		expect(fake.http.calls).toHaveLength(0);
	});

	it("uses the key and the sender from the admin settings", async () => {
		const { fake, deliver } = setup({}, [], {});
		fake.settings.values.set(SETTING_KEYS.apiKey, "re_from_settings");
		fake.settings.values.set(SETTING_KEYS.fromEmail, "news@mail.example.com");
		fake.settings.values.set(SETTING_KEYS.fromName, "News");
		await deliver();
		expect(fake.http.calls[0]!.headers.authorization).toBe("Bearer re_from_settings");
		expect((fake.http.calls[0]!.body as Record<string, unknown>).from).toBe(
			"News <news@mail.example.com>",
		);
	});

	it("reads the key again for each send", async () => {
		const env: Record<string, unknown> = { RESEND_API_KEY: "re_first_key" };
		const { fake, deliver } = setup(
			{ from: "site@mail.example.com", idempotencyWindowSeconds: 0 },
			[],
			env,
		);
		await deliver();
		env.RESEND_API_KEY = "re_second_key";
		await deliver();
		expect(fake.http.calls.map((call) => call.headers.authorization)).toEqual([
			"Bearer re_first_key",
			"Bearer re_second_key",
		]);
	});

	it("stores no record when logging is off, and still sends", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", logging: false });
		await deliver();
		expect(fake.http.calls).toHaveLength(1);
		expect(fake.emails.docs.size).toBe(0);
	});

	it("still sends when the delivery log fails", async () => {
		const { fake, deliver } = setup();
		fake.stats.updateIf = async () => {
			throw new Error("database is down");
		};
		await expect(deliver()).resolves.toBeUndefined();
		expect(fake.http.calls).toHaveLength(1);
		expect(fake.logs.some((line) => line.level === "warn")).toBe(true);
	});

	it("maps an unknown error from the HTTP access to a network error", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", maxRetries: 0 });
		(fake.ctx.http as { fetch: unknown }).fetch = async () => {
			throw new Error(`blocked fetch with Bearer ${TEST_KEY}`);
		};
		const error = await failure(deliver());
		expect(error.code).toBe("network_error");
		expect(error.message).not.toContain(TEST_KEY);
	});

	it("uses the global fetch for a local base URL", async () => {
		const { fake, deliver } = setup({
			from: "site@mail.example.com",
			baseUrl: "http://127.0.0.1:9",
			maxRetries: 0,
			timeoutMs: 500,
		});
		const error = await failure(deliver());
		expect(["network_error", "timeout"]).toContain(error.code);
		expect(fake.http.calls).toHaveLength(0);
	});
});

describe("suppression in the send path", () => {
	it("does not send to a suppressed address and records the skip", async () => {
		const { fake, deliver, records } = setup({ from: "site@mail.example.com", suppression: true });
		await addSuppression(fake.ctx, "full", { address: "person@example.com", reason: "bounced" });
		const error = await failure(deliver());
		expect(error.code).toBe("suppressed");
		expect(error.message).toContain("suppression list (bounced)");
		expect(fake.http.calls).toHaveLength(0);
		expect(records()[0]).toMatchObject({ status: "suppressed", errorCode: "suppressed" });
		expect(fake.stats.docs.get("2026-11-17")?.data.suppressed).toBe(1);
	});

	it("removes a suppressed cc address and sends to the others", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", suppression: true });
		await addSuppression(fake.ctx, "full", {
			address: "blocked@example.com",
			reason: "complained",
		});
		await deliver({ ...MESSAGE, cc: ["blocked@example.com", "ok@example.com", " "] });
		expect((fake.http.calls[0]!.body as Record<string, unknown>).cc).toEqual(["ok@example.com"]);
		await deliver({ ...MESSAGE, subject: "Second", cc: ["blocked@example.com"] });
		expect((fake.http.calls[1]!.body as Record<string, unknown>).cc).toBeUndefined();
	});

	it("sends to a listed address when suppression is off", async () => {
		const { fake, deliver } = setup({ from: "site@mail.example.com", suppression: false });
		await addSuppression(fake.ctx, "full", { address: "person@example.com", reason: "bounced" });
		await deliver();
		expect(fake.http.calls).toHaveLength(1);
	});
});
