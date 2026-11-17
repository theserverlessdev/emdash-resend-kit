import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPlugin } from "../src/index.js";
import { recordSend } from "../src/plugin/log.js";
import { findSuppression } from "../src/plugin/suppression.js";
import type { EmailRecord, ResendKitOptions } from "../src/plugin/types.js";
import {
	envSources,
	fakeContext,
	routeContext,
	TEST_WEBHOOK_SECRET,
} from "./helpers/fake-context.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

function sign(secret: string, id: string, timestamp: number, payload: string): string {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64")}`;
}

function setup(
	options: ResendKitOptions = {},
	env: Record<string, unknown> = { RESEND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET },
) {
	const fake = fakeContext();
	const plugin = createPlugin(options, { env: envSources(env), now: () => NOW });
	const route = plugin.routes.webhook!;
	const post = (
		event: unknown,
		extra: {
			id?: string;
			secret?: string;
			timestamp?: number;
			body?: string;
			headers?: Record<string, string>;
		} = {},
	) => {
		const payload = typeof event === "string" ? event : JSON.stringify(event);
		const id = extra.id ?? "msg_1";
		const timestamp = extra.timestamp ?? NOW / 1000;
		const headers = extra.headers ?? {
			"svix-id": id,
			"svix-timestamp": String(timestamp),
			"svix-signature": sign(extra.secret ?? TEST_WEBHOOK_SECRET, id, timestamp, payload),
		};
		return route.handler(routeContext(fake, extra.body ?? payload, { headers })) as Promise<{
			received: boolean;
			type: string;
			outcome: string;
		}>;
	};
	return { fake, route, post };
}

async function routeError(
	promise: Promise<unknown>,
): Promise<{ name: string; code: string; status: number; message: string }> {
	try {
		await promise;
	} catch (error) {
		return error as { name: string; code: string; status: number; message: string };
	}
	throw new Error("The route did not fail.");
}

const delivered = {
	type: "email.delivered",
	created_at: "2026-11-17T12:00:00.000Z",
	data: { email_id: "re-1", to: ["person@example.com"], subject: "Hello" },
};

describe("webhook route", () => {
	it("is public, accepts POST only, and reads the raw text body", () => {
		const { route } = setup();
		expect(route.public).toBe(true);
		expect((route as { methods?: string[] }).methods).toEqual(["POST"]);
		expect((route as { request?: unknown }).request).toEqual({
			body: "text",
			maxBytes: 262_144,
			headers: ["svix-id", "svix-timestamp", "svix-signature"],
		});
	});

	it("records a verified event on the log record", async () => {
		const { fake, post } = setup();
		await recordSend(
			fake.ctx,
			"full",
			true,
			{
				to: "person@example.com",
				subject: "Hello",
				source: "system",
				resendId: "re-1",
				status: "sent",
			},
			NOW - 1000,
		);
		expect(await post(delivered)).toEqual({
			received: true,
			type: "email.delivered",
			outcome: "recorded",
		});
		expect((fake.emails.docs.get("re-1")!.data as unknown as EmailRecord).status).toBe("delivered");
		expect(await post(delivered)).toMatchObject({ outcome: "duplicate" });
		expect(await post(delivered, { id: "msg_2" })).toMatchObject({ outcome: "recorded" });
	});

	it("rejects a bad signature with 401 and stores nothing", async () => {
		const { fake, post } = setup();
		const wrongSecret = `whsec_${Buffer.from("some-other-secret-value").toString("base64")}`;
		const error = await routeError(post(delivered, { secret: wrongSecret }));
		expect(error).toMatchObject({
			name: "PluginRouteError",
			code: "WEBHOOK_SIGNATURE_INVALID",
			status: 401,
		});
		expect(fake.emails.docs.size).toBe(0);
		expect(fake.logs.at(-1)).toMatchObject({
			level: "warn",
			data: { code: "no_matching_signature" },
		});
	});

	it("rejects a tampered body with 401", async () => {
		const { post } = setup();
		const body = JSON.stringify(delivered).replace("delivered", "bounced");
		expect((await routeError(post(delivered, { body }))).status).toBe(401);
	});

	it("rejects an old webhook with 401 and honours the tolerance option", async () => {
		expect(
			(await routeError(setup().post(delivered, { timestamp: NOW / 1000 - 301 }))).status,
		).toBe(401);
		const strict = setup({ webhookToleranceSeconds: 10 });
		expect((await routeError(strict.post(delivered, { timestamp: NOW / 1000 - 11 }))).status).toBe(
			401,
		);
		await expect(strict.post(delivered, { timestamp: NOW / 1000 - 9 })).resolves.toMatchObject({
			received: true,
		});
	});

	it("rejects a request without signature headers with 400", async () => {
		const { post } = setup();
		expect(await routeError(post(delivered, { headers: {} }))).toMatchObject({ status: 400 });
	});

	it("rejects a body that is not text with 400", async () => {
		const { route, fake } = setup();
		const error = await routeError(
			route.handler(routeContext(fake, { parsed: true })) as Promise<unknown>,
		);
		expect(error).toMatchObject({ code: "WEBHOOK_INVALID", status: 400 });
	});

	it("does not tell the caller that the stored secret is not valid", async () => {
		const { post, fake } = setup({}, { RESEND_WEBHOOK_SECRET: "whsec_not base64 !!" });
		const error = await routeError(post(delivered));
		expect(error.status).toBe(401);
		expect(error.message).toBe("The webhook signature does not match the signing secret.");
		expect(fake.logs.at(-1)).toMatchObject({ data: { code: "invalid_secret" } });
	});

	it("answers 503 when the signing secret is not set", async () => {
		const { post } = setup({}, {});
		expect(await routeError(post(delivered))).toMatchObject({
			code: "WEBHOOK_NOT_CONFIGURED",
			status: 503,
		});
	});

	it("uses the secret from the variable that the options name", async () => {
		const secret = `whsec_${Buffer.from("custom-variable-secret").toString("base64")}`;
		const { post } = setup({ webhookSecretEnv: "HOOK" }, { HOOK: secret });
		await expect(post(delivered, { secret })).resolves.toMatchObject({ outcome: "recorded" });
	});

	it("acknowledges an event that is not an email event", async () => {
		const { fake, post } = setup();
		expect(await post({ type: "contact.created", created_at: "", data: { id: "c1" } })).toEqual({
			received: true,
			type: "contact.created",
			outcome: "ignored",
		});
		expect(fake.emails.docs.size).toBe(0);
	});

	it("adds a hard bounce and a complaint to the suppression list when suppression is on", async () => {
		const { fake, post } = setup({ suppression: true });
		await post({
			type: "email.bounced",
			created_at: "2026-11-17T12:00:00.000Z",
			data: {
				email_id: "re-1",
				to: ["bounce@example.com"],
				bounce: { type: "Permanent", message: "No mailbox" },
			},
		});
		await post(
			{
				type: "email.complained",
				created_at: "2026-11-17T12:00:00.000Z",
				data: { email_id: "re-2", to: ["spam@example.com"] },
			},
			{ id: "msg_2" },
		);
		await post(
			{
				type: "email.bounced",
				created_at: "2026-11-17T12:00:00.000Z",
				data: { email_id: "re-3", to: ["soft@example.com"], bounce: { type: "Temporary" } },
			},
			{ id: "msg_3" },
		);
		expect(await findSuppression(fake.ctx, "bounce@example.com")).toMatchObject({
			reason: "bounced",
			emailId: "re-1",
			detail: "No mailbox",
		});
		expect(await findSuppression(fake.ctx, "spam@example.com")).toMatchObject({
			reason: "complained",
		});
		expect(await findSuppression(fake.ctx, "soft@example.com")).toBeNull();
	});

	it("adds nothing to the suppression list when suppression is off", async () => {
		const { fake, post } = setup({ suppression: false });
		await post({
			type: "email.complained",
			created_at: "",
			data: { email_id: "re-2", to: ["spam@example.com"] },
		});
		expect(fake.suppressions.docs.size).toBe(0);
	});

	it("stores no log record when logging is off, and still suppresses", async () => {
		const { fake, post } = setup({ logging: false, suppression: true });
		const result = await post({
			type: "email.complained",
			created_at: "",
			data: { email_id: "re-2", to: ["spam@example.com"] },
		});
		expect(result.outcome).toBe("ignored");
		expect(fake.emails.docs.size).toBe(0);
		expect(fake.suppressions.docs.size).toBe(1);
	});
});
