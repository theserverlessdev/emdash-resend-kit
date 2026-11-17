/**
 * Verification of Resend webhooks.
 *
 * Resend signs each webhook with Svix. The signature is an HMAC SHA-256 of
 * `id.timestamp.body` with the signing secret as the key. This module uses
 * Web Crypto only, so it runs on Cloudflare Workers and on Node.
 *
 * @example
 * ```ts
 * import { verifyWebhook } from "emdash-resend-kit/webhook";
 *
 * const event = await verifyWebhook({
 *   payload: await request.text(),
 *   headers: request.headers,
 *   secret: env.RESEND_WEBHOOK_SECRET,
 * });
 * ```
 */

import { base64ToBytes, bytesToBase64, timingSafeEqual, utf8 } from "./encoding.js";

/** Default limit for the age of a webhook, in seconds. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

export type WebhookErrorCode =
	| "missing_secret"
	| "invalid_secret"
	| "missing_headers"
	| "invalid_timestamp"
	| "timestamp_too_old"
	| "timestamp_too_new"
	| "no_matching_signature"
	| "invalid_payload";

/** Error for a webhook that fails verification. */
export class WebhookVerificationError extends Error {
	override readonly name = "WebhookVerificationError";
	readonly code: WebhookErrorCode;

	constructor(code: WebhookErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/** A verified Resend webhook event. */
export interface ResendWebhookEvent {
	/** Event type, for example `email.delivered`. */
	type: string;
	/** Time of the event, as ISO 8601 text. */
	created_at: string;
	data: Record<string, unknown>;
}

export interface WebhookHeaders {
	id: string;
	timestamp: string;
	signature: string;
}

export interface VerifyWebhookInput {
	/** Raw request body. Do not parse and serialise the body again. */
	payload: string;
	/** Request headers, or the three Svix header values. */
	headers: Headers | Record<string, string | undefined> | WebhookHeaders;
	/** Signing secret from the Resend dashboard. It starts with `whsec_`. */
	secret: string | undefined;
	/** Limit for the age of the webhook, in seconds. Default: 300. */
	toleranceSeconds?: number;
	/** Current time in milliseconds. Tests use this field. */
	now?: number;
}

function readHeader(
	headers: VerifyWebhookInput["headers"],
	name: "id" | "timestamp" | "signature",
): string | undefined {
	if (typeof Headers !== "undefined" && headers instanceof Headers) {
		return headers.get(`svix-${name}`) ?? headers.get(`webhook-${name}`) ?? undefined;
	}
	const record = headers as Record<string, string | undefined>;
	const direct = record[name] ?? record[`svix-${name}`] ?? record[`webhook-${name}`];
	if (direct !== undefined) return direct;
	for (const [key, value] of Object.entries(record)) {
		const lower = key.toLowerCase();
		if (lower === `svix-${name}` || lower === `webhook-${name}`) return value;
	}
	return undefined;
}

/** Read the three signature headers. Return `null` when one is missing. */
export function extractWebhookHeaders(
	headers: VerifyWebhookInput["headers"],
): WebhookHeaders | null {
	const id = readHeader(headers, "id");
	const timestamp = readHeader(headers, "timestamp");
	const signature = readHeader(headers, "signature");
	return id && timestamp && signature ? { id, timestamp, signature } : null;
}

function decodeSecret(secret: string): Uint8Array<ArrayBuffer> {
	const body = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
	try {
		const bytes = base64ToBytes(body);
		if (bytes.length === 0) throw new TypeError("empty");
		return bytes;
	} catch {
		throw new WebhookVerificationError(
			"invalid_secret",
			"The webhook signing secret is not valid Base64 text.",
		);
	}
}

/**
 * Compute the Svix signature for a webhook.
 *
 * @returns The signature as `v1,<base64>`.
 */
export async function signWebhook(
	secret: string,
	id: string,
	timestampSeconds: number | string,
	payload: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		decodeSecret(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signed = await crypto.subtle.sign(
		"HMAC",
		key,
		utf8(`${id}.${timestampSeconds}.${payload}`),
	);
	return `v1,${bytesToBase64(new Uint8Array(signed))}`;
}

/**
 * Verify the signature and the age of a webhook, then parse the body.
 *
 * @throws {WebhookVerificationError} when the verification fails.
 */
export async function verifyWebhook(input: VerifyWebhookInput): Promise<ResendWebhookEvent> {
	const secret = input.secret?.trim();
	if (!secret) {
		throw new WebhookVerificationError(
			"missing_secret",
			"The webhook signing secret is missing. Set RESEND_WEBHOOK_SECRET.",
		);
	}
	const headers = extractWebhookHeaders(input.headers);
	if (!headers) {
		throw new WebhookVerificationError(
			"missing_headers",
			"The request has no svix-id, svix-timestamp, or svix-signature header.",
		);
	}

	if (!/^\d{1,12}$/.test(headers.timestamp)) {
		throw new WebhookVerificationError(
			"invalid_timestamp",
			"The svix-timestamp header is invalid.",
		);
	}
	const timestamp = Number(headers.timestamp);
	const tolerance = input.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
	const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
	if (timestamp < nowSeconds - tolerance) {
		throw new WebhookVerificationError("timestamp_too_old", "The webhook is too old.");
	}
	if (timestamp > nowSeconds + tolerance) {
		throw new WebhookVerificationError(
			"timestamp_too_new",
			"The webhook timestamp is in the future.",
		);
	}

	const expected = await signWebhook(secret, headers.id, headers.timestamp, input.payload);
	const expectedBytes = utf8(expected.slice("v1,".length));
	let matched = false;
	// Check each candidate. Do not stop at the first match, so the time does
	// not show which candidate matched.
	for (const candidate of headers.signature.split(/\s+/)) {
		const [version, value] = candidate.split(",", 2);
		if (version !== "v1" || !value) continue;
		if (timingSafeEqual(utf8(value), expectedBytes)) matched = true;
	}
	if (!matched) {
		throw new WebhookVerificationError(
			"no_matching_signature",
			"The webhook signature does not match the signing secret.",
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(input.payload);
	} catch {
		throw new WebhookVerificationError("invalid_payload", "The webhook body is not JSON.");
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		typeof (parsed as { type?: unknown }).type !== "string"
	) {
		throw new WebhookVerificationError("invalid_payload", "The webhook body has no event type.");
	}
	const event = parsed as { type: string; created_at?: unknown; data?: unknown };
	return {
		type: event.type,
		created_at: typeof event.created_at === "string" ? event.created_at : new Date().toISOString(),
		data:
			typeof event.data === "object" && event.data !== null
				? (event.data as Record<string, unknown>)
				: {},
	};
}
