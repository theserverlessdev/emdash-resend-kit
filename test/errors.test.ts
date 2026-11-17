import { describe, expect, it } from "vitest";

import { errorFromResponse, isResendError, redactSecrets, ResendError } from "../src/errors.js";

function map(
	status: number,
	body: unknown,
	headers: Record<string, string> = {},
	secrets: string[] = [],
) {
	return errorFromResponse(
		status,
		typeof body === "string" ? body : JSON.stringify(body),
		new Headers(headers),
		secrets,
	);
}

describe("errorFromResponse", () => {
	it.each([
		[401, { name: "missing_api_key", message: "Missing API Key" }, "missing_api_key", false],
		[401, { name: "validation_error", message: "API key is invalid" }, "invalid_api_key", false],
		[400, { name: "validation_error", message: "API key is invalid" }, "invalid_api_key", false],
		[
			401,
			{ name: "restricted_api_key", message: "This API key is restricted to only send emails." },
			"restricted_api_key",
			false,
		],
		[
			403,
			{ name: "restricted_api_key", message: "API key is not active" },
			"restricted_api_key",
			false,
		],
		[
			403,
			{ name: "suspended_api_key", message: "This API key is suspended" },
			"restricted_api_key",
			false,
		],
		[
			403,
			{ name: "invalid_permission", message: "Access token is missing required scopes." },
			"restricted_api_key",
			false,
		],
		[
			403,
			{
				name: "validation_error",
				message: "The example.com domain is not verified. Please, add and verify your domain.",
			},
			"domain_not_verified",
			false,
		],
		[
			403,
			{
				name: "validation_error",
				message: "You can only send testing emails to your own email address (you@x.com).",
			},
			"testing_recipients_only",
			false,
		],
		[
			403,
			{ name: "validation_error", message: "The example.com domain has been registered already." },
			"validation",
			false,
		],
		[400, { name: "validation_error", message: "Invalid `from` field." }, "validation", false],
		[422, { name: "missing_required_field", message: "Missing fields." }, "validation", false],
		[
			422,
			{ name: "invalid_attachment", message: "Attachment must have either a `content` or `path`." },
			"invalid_attachment",
			false,
		],
		[404, { name: "not_found", message: "Email not found" }, "not_found", false],
		[
			409,
			{ name: "concurrent_idempotent_requests", message: "In progress." },
			"idempotency_conflict",
			true,
		],
		[409, { name: "resource_locked", message: "Locked." }, "idempotency_conflict", true],
		[
			409,
			{ name: "invalid_idempotent_request", message: "Body changed." },
			"idempotency_conflict",
			false,
		],
		[400, { name: "invalid_idempotency_key", message: "Bad key." }, "idempotency_conflict", false],
		[429, { name: "rate_limit_exceeded", message: "Too many requests." }, "rate_limited", true],
		[429, { name: "daily_quota_exceeded", message: "Daily quota." }, "quota_exceeded", false],
		[429, { name: "monthly_quota_exceeded", message: "Monthly quota." }, "quota_exceeded", false],
		[500, { name: "application_error", message: "Unexpected." }, "server_error", true],
		[503, { name: "service_unavailable", message: "Down." }, "server_error", true],
		[401, { name: "something_new", message: "Unknown." }, "invalid_api_key", false],
	])("maps %i %o to %s", (status, body, code, retryable) => {
		const error = map(status, body);
		expect(error).toBeInstanceOf(ResendError);
		expect(error.code).toBe(code);
		expect(error.status).toBe(status);
		expect(error.retryable).toBe(retryable);
		expect(error.resendName).toBe((body as { name: string }).name);
		expect(error.message.length).toBeGreaterThan(10);
	});

	it("gives clear messages for the common problems", () => {
		expect(map(401, { name: "validation_error", message: "API key is invalid" }).message).toContain(
			"The Resend API key is invalid.",
		);
		expect(
			map(403, { name: "validation_error", message: "The x.com domain is not verified." }).message,
		).toContain("The sender domain is not verified in Resend.");
		expect(map(429, { name: "rate_limit_exceeded", message: "x" }).message).toContain(
			"Resend rate limit reached.",
		);
		expect(
			map(401, { name: "restricted_api_key", message: "restricted to only send emails" }).message,
		).toContain("can only send email");
	});

	it("reads retry-after as seconds", () => {
		expect(map(429, { name: "rate_limit_exceeded" }, { "retry-after": "7" }).retryAfter).toBe(7);
		expect(
			map(429, { name: "rate_limit_exceeded" }, { "retry-after": "soon" }).retryAfter,
		).toBeUndefined();
		expect(map(429, { name: "rate_limit_exceeded" }).retryAfter).toBeUndefined();
	});

	it("handles a body that is not JSON", () => {
		const error = map(403, "error code: 1010");
		expect(error.code).toBe("validation");
		expect(error.resendMessage).toBe("error code: 1010");
		expect(map(502, "<html>Bad gateway</html>").code).toBe("server_error");
		expect(map(400, "").resendMessage).toBeUndefined();
		expect(map(400, "null").code).toBe("validation");
	});

	it("removes secrets from the Resend message", () => {
		const error = map(
			400,
			{
				name: "validation_error",
				message: "Key re_abcdef123456 and custom-secret-value are wrong",
			},
			{},
			["custom-secret-value"],
		);
		expect(error.message).not.toContain("re_abcdef123456");
		expect(error.message).not.toContain("custom-secret-value");
		expect(error.resendMessage).toContain("re_[redacted]");
	});
});

describe("redactSecrets", () => {
	it("removes API keys, webhook secrets, bearer tokens, and literal secrets", () => {
		const text =
			"Authorization: Bearer re_live_abc123XYZ key=re_live_abc123XYZ secret=whsec_AbC+/123= other=topsecretvalue";
		const result = redactSecrets(text, ["topsecretvalue", undefined, "abc"]);
		expect(result).not.toContain("re_live_abc123XYZ");
		expect(result).not.toContain("whsec_AbC");
		expect(result).not.toContain("topsecretvalue");
		expect(result).toContain("Bearer [redacted]");
		expect(result).toContain("whsec_[redacted]");
		// A literal with fewer than 4 characters stays, to keep the text readable.
		expect(redactSecrets("abc", ["abc"])).toBe("abc");
	});
});

describe("ResendError", () => {
	it("has defaults and keeps the cause", () => {
		const cause = new Error("inner");
		const error = new ResendError({ code: "network_error", message: "outer", cause });
		expect(error.name).toBe("ResendError");
		expect(error.status).toBe(0);
		expect(error.retryable).toBe(false);
		expect(error.attempts).toBe(1);
		expect(error.cause).toBe(cause);
	});

	it("is recognised by shape across module copies", () => {
		const foreign = Object.assign(new Error("x"), { name: "ResendError", code: "validation" });
		expect(isResendError(foreign)).toBe(true);
		expect(isResendError(new ResendError({ code: "validation", message: "x" }))).toBe(true);
		expect(isResendError(new Error("x"))).toBe(false);
		expect(isResendError("x")).toBe(false);
	});
});
