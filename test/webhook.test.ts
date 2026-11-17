import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	extractWebhookHeaders,
	signWebhook,
	verifyWebhook,
	WebhookVerificationError,
	type VerifyWebhookInput,
} from "../src/webhook.js";

/**
 * Test vector from the Svix documentation for manual verification.
 * https://docs.svix.com/receiving/verifying-payloads/how-manual
 */
const SVIX = {
	secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
	id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
	timestamp: "1614265330",
	payload: '{"test": 2432232314}',
	signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const SVIX_NOW = 1614265330 * 1000;

/** Independent reference implementation with node:crypto. */
function referenceSign(
	secret: string,
	id: string,
	timestamp: string | number,
	payload: string,
): string {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	return `v1,${createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64")}`;
}

const SECRET = `whsec_${Buffer.from("a-32-byte-test-signing-secret!!!!").toString("base64")}`;
const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const TIMESTAMP = String(NOW / 1000);
const PAYLOAD = JSON.stringify({
	type: "email.delivered",
	created_at: "2026-11-17T12:00:00.000Z",
	data: { email_id: "56761188-7520-42d8-8898-ff6fc54ce618", to: ["delivered@resend.dev"] },
});

function input(overrides: Partial<VerifyWebhookInput> = {}): VerifyWebhookInput {
	return {
		payload: PAYLOAD,
		secret: SECRET,
		now: NOW,
		headers: {
			"svix-id": "msg_1",
			"svix-timestamp": TIMESTAMP,
			"svix-signature": referenceSign(SECRET, "msg_1", TIMESTAMP, PAYLOAD),
		},
		...overrides,
	};
}

async function code(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof WebhookVerificationError) return error.code;
		throw error;
	}
	return "no error";
}

describe("signWebhook", () => {
	it("matches the test vector of the Svix documentation", async () => {
		expect(await signWebhook(SVIX.secret, SVIX.id, SVIX.timestamp, SVIX.payload)).toBe(
			SVIX.signature,
		);
	});

	it("matches the node:crypto reference for other inputs", async () => {
		for (const payload of ["", "{}", PAYLOAD, "unicode: äöü 日本語 🎉"]) {
			expect(await signWebhook(SECRET, "msg_x", 1700000000, payload)).toBe(
				referenceSign(SECRET, "msg_x", 1700000000, payload),
			);
		}
	});

	it("accepts a secret without the whsec_ prefix", async () => {
		const bare = SVIX.secret.slice("whsec_".length);
		expect(await signWebhook(bare, SVIX.id, SVIX.timestamp, SVIX.payload)).toBe(SVIX.signature);
	});
});

describe("verifyWebhook", () => {
	it("accepts the Svix test vector", async () => {
		const event = await verifyWebhook({
			payload: '{"type":"email.sent","data":{"email_id":"x"}}',
			secret: SVIX.secret,
			now: SVIX_NOW,
			headers: {
				id: SVIX.id,
				timestamp: SVIX.timestamp,
				signature: referenceSign(
					SVIX.secret,
					SVIX.id,
					SVIX.timestamp,
					'{"type":"email.sent","data":{"email_id":"x"}}',
				),
			},
		});
		expect(event.type).toBe("email.sent");
		expect(event.data).toEqual({ email_id: "x" });
		expect(typeof event.created_at).toBe("string");
	});

	it("accepts a valid webhook and returns the event", async () => {
		const event = await verifyWebhook(input());
		expect(event).toEqual(JSON.parse(PAYLOAD));
	});

	it("accepts Headers objects, mixed case names, and webhook- header names", async () => {
		const signature = referenceSign(SECRET, "msg_1", TIMESTAMP, PAYLOAD);
		const headers = new Headers({
			"Svix-Id": "msg_1",
			"Svix-Timestamp": TIMESTAMP,
			"Svix-Signature": signature,
		});
		await expect(verifyWebhook(input({ headers }))).resolves.toBeTruthy();
		await expect(
			verifyWebhook(
				input({
					headers: { "SVIX-ID": "msg_1", "Svix-Timestamp": TIMESTAMP, "svix-signature": signature },
				}),
			),
		).resolves.toBeTruthy();
		await expect(
			verifyWebhook(
				input({
					headers: new Headers({
						"webhook-id": "msg_1",
						"webhook-timestamp": TIMESTAMP,
						"webhook-signature": signature,
					}),
				}),
			),
		).resolves.toBeTruthy();
	});

	it("accepts a header with more than one signature", async () => {
		const good = referenceSign(SECRET, "msg_1", TIMESTAMP, PAYLOAD);
		const other = referenceSign(
			`whsec_${Buffer.from("old-secret-old-secret").toString("base64")}`,
			"msg_1",
			TIMESTAMP,
			PAYLOAD,
		);
		for (const signature of [
			`${other} ${good}`,
			`${good} ${other}`,
			`v2,ignored ${other} ${good}`,
		]) {
			await expect(
				verifyWebhook(input({ headers: { id: "msg_1", timestamp: TIMESTAMP, signature } })),
			).resolves.toBeTruthy();
		}
	});

	it("rejects a tampered body", async () => {
		expect(
			await code(verifyWebhook(input({ payload: PAYLOAD.replace("delivered", "bounced") }))),
		).toBe("no_matching_signature");
		expect(await code(verifyWebhook(input({ payload: `${PAYLOAD} ` })))).toBe(
			"no_matching_signature",
		);
	});

	it("rejects a tampered ID and a tampered timestamp", async () => {
		const signature = referenceSign(SECRET, "msg_1", TIMESTAMP, PAYLOAD);
		expect(
			await code(
				verifyWebhook(input({ headers: { id: "msg_2", timestamp: TIMESTAMP, signature } })),
			),
		).toBe("no_matching_signature");
		expect(
			await code(
				verifyWebhook(
					input({ headers: { id: "msg_1", timestamp: String(NOW / 1000 + 1), signature } }),
				),
			),
		).toBe("no_matching_signature");
	});

	it("rejects a signature from another secret, and malformed signatures", async () => {
		const wrong = referenceSign(
			`whsec_${Buffer.from("another-secret-value").toString("base64")}`,
			"msg_1",
			TIMESTAMP,
			PAYLOAD,
		);
		const good = referenceSign(SECRET, "msg_1", TIMESTAMP, PAYLOAD);
		for (const signature of [
			wrong,
			"v1,",
			"v1",
			"garbage",
			good.replace("v1,", "v2,"),
			good.slice(0, -2),
			`${good}x`,
		]) {
			expect(
				await code(
					verifyWebhook(input({ headers: { id: "msg_1", timestamp: TIMESTAMP, signature } })),
				),
			).toBe("no_matching_signature");
		}
	});

	it("rejects an old webhook and accepts one at the limit", async () => {
		const sign = (timestamp: number) => ({
			id: "msg_1",
			timestamp: String(timestamp),
			signature: referenceSign(SECRET, "msg_1", timestamp, PAYLOAD),
		});
		const nowSeconds = NOW / 1000;
		expect(await code(verifyWebhook(input({ headers: sign(nowSeconds - 301) })))).toBe(
			"timestamp_too_old",
		);
		await expect(verifyWebhook(input({ headers: sign(nowSeconds - 300) }))).resolves.toBeTruthy();
		expect(await code(verifyWebhook(input({ headers: sign(nowSeconds + 301) })))).toBe(
			"timestamp_too_new",
		);
		await expect(verifyWebhook(input({ headers: sign(nowSeconds + 300) }))).resolves.toBeTruthy();
		expect(
			await code(verifyWebhook(input({ headers: sign(nowSeconds - 61), toleranceSeconds: 60 }))),
		).toBe("timestamp_too_old");
	});

	it("uses the current time when `now` is not set", async () => {
		const timestamp = Math.floor(Date.now() / 1000);
		const headers = {
			id: "msg_1",
			timestamp: String(timestamp),
			signature: referenceSign(SECRET, "msg_1", timestamp, PAYLOAD),
		};
		await expect(
			verifyWebhook({ payload: PAYLOAD, secret: SECRET, headers }),
		).resolves.toBeTruthy();
	});

	it("rejects an invalid timestamp", async () => {
		for (const timestamp of ["abc", "-5", "1.5", "", "9".repeat(13)]) {
			const result = await code(
				verifyWebhook(
					input({ headers: { id: "msg_1", timestamp: timestamp || " ", signature: "v1,x" } }),
				),
			);
			expect(result).toBe("invalid_timestamp");
		}
	});

	it("rejects missing headers", async () => {
		expect(await code(verifyWebhook(input({ headers: {} })))).toBe("missing_headers");
		expect(await code(verifyWebhook(input({ headers: new Headers({ "svix-id": "msg_1" }) })))).toBe(
			"missing_headers",
		);
		expect(extractWebhookHeaders({ "svix-id": "a", "svix-timestamp": "1" })).toBeNull();
	});

	it("rejects a missing secret and an invalid secret", async () => {
		expect(await code(verifyWebhook(input({ secret: undefined })))).toBe("missing_secret");
		expect(await code(verifyWebhook(input({ secret: "  " })))).toBe("missing_secret");
		expect(await code(verifyWebhook(input({ secret: "whsec_not base64 !!" })))).toBe(
			"invalid_secret",
		);
		expect(await code(verifyWebhook(input({ secret: "whsec_" })))).toBe("invalid_secret");
	});

	it("rejects a signed body that is not an event", async () => {
		const verifyBody = (payload: string) =>
			code(
				verifyWebhook(
					input({
						payload,
						headers: {
							id: "msg_1",
							timestamp: TIMESTAMP,
							signature: referenceSign(SECRET, "msg_1", TIMESTAMP, payload),
						},
					}),
				),
			);
		expect(await verifyBody("not json")).toBe("invalid_payload");
		expect(await verifyBody('"text"')).toBe("invalid_payload");
		expect(await verifyBody('{"data":{}}')).toBe("invalid_payload");
		expect(await verifyBody("null")).toBe("invalid_payload");
	});

	it("fills defaults for an event without data", async () => {
		const payload = '{"type":"domain.created"}';
		const event = await verifyWebhook(
			input({
				payload,
				headers: {
					id: "msg_1",
					timestamp: TIMESTAMP,
					signature: referenceSign(SECRET, "msg_1", TIMESTAMP, payload),
				},
			}),
		);
		expect(event.data).toEqual({});
	});
});
