/**
 * Typed errors for the Resend API.
 *
 * The Resend API reports many different problems with the same `name`
 * (`validation_error`). This module maps each response to one stable `code`
 * and one clear message.
 */

/** Stable error codes of this package. */
export type ResendErrorCode =
	| "missing_api_key"
	| "invalid_api_key"
	| "restricted_api_key"
	| "domain_not_verified"
	| "testing_recipients_only"
	| "validation"
	| "invalid_attachment"
	| "not_found"
	| "idempotency_conflict"
	| "rate_limited"
	| "quota_exceeded"
	| "server_error"
	| "network_error"
	| "timeout"
	| "suppressed"
	| "not_configured";

export interface ResendErrorInit {
	code: ResendErrorCode;
	message: string;
	/** HTTP status of the response. `0` when no response arrived. */
	status?: number;
	/** The `name` field of the Resend error body. */
	resendName?: string;
	/** The `message` field of the Resend error body, with secrets removed. */
	resendMessage?: string;
	/** True when a later attempt can succeed. */
	retryable?: boolean;
	/** Seconds from the `retry-after` header. */
	retryAfter?: number;
	/** Number of HTTP attempts that the client made. */
	attempts?: number;
	cause?: unknown;
}

/** Error class for all failures of this package. */
export class ResendError extends Error {
	override readonly name = "ResendError";
	readonly code: ResendErrorCode;
	readonly status: number;
	readonly resendName?: string;
	readonly resendMessage?: string;
	readonly retryable: boolean;
	readonly retryAfter?: number;
	attempts: number;

	constructor(init: ResendErrorInit) {
		super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
		this.code = init.code;
		this.status = init.status ?? 0;
		this.resendName = init.resendName;
		this.resendMessage = init.resendMessage;
		this.retryable = init.retryable ?? false;
		this.retryAfter = init.retryAfter;
		this.attempts = init.attempts ?? 1;
	}
}

/** Type guard that also works across duplicate module instances. */
export function isResendError(error: unknown): error is ResendError {
	if (error instanceof ResendError) return true;
	return (
		error instanceof Error &&
		error.name === "ResendError" &&
		typeof (error as Partial<ResendError>).code === "string"
	);
}

const API_KEY_PATTERN = /\bre_[A-Za-z0-9_-]{4,}/g;
const WEBHOOK_SECRET_PATTERN = /\bwhsec_[A-Za-z0-9+/=_-]{4,}/g;
const BEARER_PATTERN = /Bearer\s+[A-Za-z0-9._~+/=-]{4,}/gi;

/**
 * Remove secrets from a text.
 *
 * The function removes Resend API keys, webhook secrets, bearer tokens, and
 * each literal secret in `secrets`.
 */
export function redactSecrets(text: string, secrets: ReadonlyArray<string | undefined> = []): string {
	let result = text;
	for (const secret of secrets) {
		if (secret && secret.length >= 4) result = result.split(secret).join("[redacted]");
	}
	return result
		.replace(BEARER_PATTERN, "Bearer [redacted]")
		.replace(API_KEY_PATTERN, "re_[redacted]")
		.replace(WEBHOOK_SECRET_PATTERN, "whsec_[redacted]");
}

interface ResendErrorBody {
	name?: unknown;
	message?: unknown;
	statusCode?: unknown;
}

function parseRetryAfter(value: string | null): number | undefined {
	if (!value) return undefined;
	const seconds = Number(value);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds;
	const date = Date.parse(value);
	if (Number.isNaN(date)) return undefined;
	return Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

const NOT_VERIFIED_PATTERN = /domain is not verified|not verified/i;
const TESTING_ONLY_PATTERN = /only send testing emails/i;
const INVALID_KEY_PATTERN = /api key is invalid/i;

/**
 * Convert a failed Resend API response to a `ResendError`.
 *
 * @param status HTTP status of the response.
 * @param bodyText Raw response body.
 * @param headers Response headers.
 * @param secrets Literal secrets to remove from the message.
 */
export function errorFromResponse(
	status: number,
	bodyText: string,
	headers: Headers,
	secrets: ReadonlyArray<string | undefined> = [],
): ResendError {
	let body: ResendErrorBody = {};
	try {
		const parsed: unknown = JSON.parse(bodyText);
		if (typeof parsed === "object" && parsed !== null) body = parsed as ResendErrorBody;
	} catch {
		// The body is not JSON. The status code decides the error.
	}
	const resendName = typeof body.name === "string" ? body.name : undefined;
	const rawMessage =
		typeof body.message === "string" ? body.message : bodyText.slice(0, 300).trim() || undefined;
	const resendMessage = rawMessage ? redactSecrets(rawMessage, secrets) : undefined;
	const retryAfter = parseRetryAfter(headers.get("retry-after"));
	const base = { status, resendName, resendMessage, retryAfter };
	const detail = resendMessage ? ` Resend says: ${resendMessage}` : "";

	if (resendName === "missing_api_key") {
		return new ResendError({
			...base,
			code: "missing_api_key",
			message: "Resend did not receive an API key. Set RESEND_API_KEY.",
		});
	}
	if (
		resendName === "restricted_api_key" ||
		resendName === "suspended_api_key" ||
		resendName === "invalid_permission"
	) {
		return new ResendError({
			...base,
			code: "restricted_api_key",
			message:
				status === 401
					? "This Resend API key can only send email. This action needs a key with full access."
					: `Resend refused this API key.${detail}`,
		});
	}
	if (resendMessage && INVALID_KEY_PATTERN.test(resendMessage)) {
		return new ResendError({
			...base,
			code: "invalid_api_key",
			message:
				"The Resend API key is invalid. Create a new key at https://resend.com/api-keys and update RESEND_API_KEY.",
		});
	}
	if (status === 403 && resendMessage && TESTING_ONLY_PATTERN.test(resendMessage)) {
		return new ResendError({
			...base,
			code: "testing_recipients_only",
			message:
				"Resend accepts only your own address until you verify a domain. Verify a domain at https://resend.com/domains and send from an address on that domain.",
		});
	}
	if (status === 403 && resendMessage && NOT_VERIFIED_PATTERN.test(resendMessage)) {
		return new ResendError({
			...base,
			code: "domain_not_verified",
			message: `The sender domain is not verified in Resend. Verify the domain at https://resend.com/domains.${detail}`,
		});
	}
	if (resendName === "daily_quota_exceeded" || resendName === "monthly_quota_exceeded") {
		return new ResendError({
			...base,
			code: "quota_exceeded",
			message: `The Resend sending quota is used up.${detail}`,
		});
	}
	if (status === 429) {
		return new ResendError({
			...base,
			code: "rate_limited",
			retryable: true,
			message: "Resend rate limit reached. Send fewer requests per second.",
		});
	}
	if (resendName === "concurrent_idempotent_requests" || resendName === "resource_locked") {
		return new ResendError({
			...base,
			code: "idempotency_conflict",
			retryable: true,
			message: `Resend is busy with the same request.${detail}`,
		});
	}
	if (resendName === "invalid_idempotent_request" || resendName === "invalid_idempotency_key") {
		return new ResendError({
			...base,
			code: "idempotency_conflict",
			message: `Resend rejected the idempotency key.${detail}`,
		});
	}
	if (resendName === "invalid_attachment") {
		return new ResendError({
			...base,
			code: "invalid_attachment",
			message: `Resend rejected an attachment.${detail}`,
		});
	}
	if (status === 404) {
		return new ResendError({
			...base,
			code: "not_found",
			message: `Resend did not find the resource.${detail}`,
		});
	}
	if (status >= 500) {
		return new ResendError({
			...base,
			code: "server_error",
			retryable: true,
			message: `Resend returned a server error (${status}). Try again later.`,
		});
	}
	if (status === 401) {
		return new ResendError({
			...base,
			code: "invalid_api_key",
			message: `Resend refused the API key.${detail}`,
		});
	}
	return new ResendError({
		...base,
		code: "validation",
		message: `Resend rejected the request (${status}).${detail}`,
	});
}
