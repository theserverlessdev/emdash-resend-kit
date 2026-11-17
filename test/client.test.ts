import { describe, expect, it, vi } from "vitest";

import {
	buildEmailPayload,
	createResendClient,
	extractEmail,
	formatAddress,
	isResendError,
	normaliseTags,
	toTagValue,
	type ResendClientOptions,
} from "../src/client.js";
import { ResendError } from "../src/errors.js";
import { VERSION } from "../src/version.js";
import { envSources, fakeFetch, TEST_KEY, type FetchReply } from "./helpers/fake-context.js";

function setup(replies: FetchReply[] = [], options: ResendClientOptions = {}) {
	const http = fakeFetch(replies);
	const sleeps: number[] = [];
	const client = createResendClient({
		apiKey: TEST_KEY,
		fetch: http.fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		random: () => 0.5,
		...options,
	});
	return { client, http, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<ResendError> {
	try {
		await promise;
	} catch (error) {
		if (isResendError(error)) return error;
		throw error;
	}
	throw new Error("The call did not fail.");
}

describe("request shape", () => {
	it("sends a minimal email to POST /emails", async () => {
		const { client, http } = setup([{ status: 200, body: { id: "abc" } }]);
		const result = await client.send({
			from: "site@mail.example.com",
			to: "person@example.com",
			subject: "Hello",
			text: "Body",
		});
		expect(result).toEqual({ id: "abc" });
		expect(http.calls).toHaveLength(1);
		const call = http.calls[0]!;
		expect(call.url).toBe("https://api.resend.com/emails");
		expect(call.method).toBe("POST");
		expect(call.headers.authorization).toBe(`Bearer ${TEST_KEY}`);
		expect(call.headers["content-type"]).toBe("application/json");
		expect(call.headers.accept).toBe("application/json");
		expect(call.headers["user-agent"]).toBe(`emdash-resend-kit/${VERSION}`);
		expect(call.body).toEqual({
			from: "site@mail.example.com",
			to: ["person@example.com"],
			subject: "Hello",
			text: "Body",
		});
	});

	it("maps each option to the Resend field name", async () => {
		const { client, http } = setup();
		const scheduledAt = new Date("2026-12-01T10:00:00.000Z");
		await client.send({
			from: { email: "site@mail.example.com", name: "My Site" },
			to: ["a@example.com", "b@example.com"],
			cc: "c@example.com",
			bcc: ["d@example.com", "e@example.com"],
			replyTo: ["reply@example.com"],
			subject: "All options",
			html: "<p>Hi</p>",
			text: "Hi",
			headers: { "X-Entity-Ref-ID": "42" },
			tags: [{ name: "category", value: "welcome" }],
			attachments: [
				{ filename: "a.txt", content: "aGVsbG8=" },
				{ filename: "b.bin", content: new Uint8Array([104, 105]), contentType: "text/plain" },
				{ filename: "c.bin", content: new Uint8Array([1, 2, 3]).buffer },
				{ filename: "logo.png", path: "https://example.com/logo.png", contentId: "logo" },
			],
			scheduledAt,
			topicId: "topic-1",
		});
		expect(http.calls[0]!.body).toEqual({
			from: "My Site <site@mail.example.com>",
			to: ["a@example.com", "b@example.com"],
			cc: ["c@example.com"],
			bcc: ["d@example.com", "e@example.com"],
			reply_to: ["reply@example.com"],
			subject: "All options",
			html: "<p>Hi</p>",
			text: "Hi",
			headers: { "X-Entity-Ref-ID": "42" },
			tags: [{ name: "category", value: "welcome" }],
			attachments: [
				{ filename: "a.txt", content: "aGVsbG8=" },
				{ filename: "b.bin", content: "aGk=", content_type: "text/plain" },
				{ filename: "c.bin", content: "AQID" },
				{ filename: "logo.png", path: "https://example.com/logo.png", content_id: "logo" },
			],
			scheduled_at: "2026-12-01T10:00:00.000Z",
			topic_id: "topic-1",
		});
	});

	it("sends a template without html and text", async () => {
		const { client, http } = setup();
		await client.send({
			from: "site@mail.example.com",
			to: "a@example.com",
			template: { id: "welcome", variables: { NAME: "Sam", COUNT: 3 } },
			scheduledAt: "in 1 hour",
		});
		expect(http.calls[0]!.body).toEqual({
			from: "site@mail.example.com",
			to: ["a@example.com"],
			template: { id: "welcome", variables: { NAME: "Sam", COUNT: 3 } },
			scheduled_at: "in 1 hour",
		});
		await client.send({ from: "s@mail.example.com", to: "a@example.com", template: { id: "t" } });
		expect((http.calls[1]!.body as { template: unknown }).template).toEqual({ id: "t" });
	});

	it("applies the client defaults and lets the email replace them", async () => {
		const { client, http } = setup([], {
			from: { email: "default@mail.example.com", name: "Default" },
			replyTo: "default-reply@example.com",
			headers: { "X-A": "1", "X-B": "2" },
			tags: { env: "test", team: "web" },
		});
		await client.send({ to: "a@example.com", subject: "S", text: "T" });
		expect(http.calls[0]!.body).toMatchObject({
			from: "Default <default@mail.example.com>",
			reply_to: ["default-reply@example.com"],
			headers: { "X-A": "1", "X-B": "2" },
			tags: [
				{ name: "env", value: "test" },
				{ name: "team", value: "web" },
			],
		});
		await client.send({
			from: "other@mail.example.com",
			to: "a@example.com",
			subject: "S",
			text: "T",
			replyTo: "other-reply@example.com",
			headers: { "X-B": "3" },
			tags: { team: "ops" },
		});
		expect(http.calls[1]!.body).toMatchObject({
			from: "other@mail.example.com",
			reply_to: ["other-reply@example.com"],
			headers: { "X-A": "1", "X-B": "3" },
			tags: [
				{ name: "env", value: "test" },
				{ name: "team", value: "ops" },
			],
		});
	});

	it("uses the base URL without a trailing slash and a custom user agent", async () => {
		const { client, http } = setup([], {
			baseUrl: "https://proxy.example.com/resend/",
			userAgent: "my-app/1.0",
		});
		await client.send({ from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" });
		expect(http.calls[0]!.url).toBe("https://proxy.example.com/resend/emails");
		expect(http.calls[0]!.headers["user-agent"]).toBe("my-app/1.0");
	});

	it("sends a batch to POST /emails/batch", async () => {
		const { client, http } = setup([{ status: 200, body: { data: [{ id: "1" }, { id: "2" }] } }], {
			from: "s@mail.example.com",
		});
		const result = await client.sendBatch(
			[
				{ to: "a@example.com", subject: "A", text: "A" },
				{ to: "b@example.com", subject: "B", html: "<b>B</b>" },
			],
			{ idempotencyKey: "batch-1" },
		);
		expect(result).toEqual([{ id: "1" }, { id: "2" }]);
		expect(http.calls[0]!.url).toBe("https://api.resend.com/emails/batch");
		expect(http.calls[0]!.headers["idempotency-key"]).toBe("batch-1");
		expect(http.calls[0]!.body).toEqual([
			{ from: "s@mail.example.com", to: ["a@example.com"], subject: "A", text: "A" },
			{ from: "s@mail.example.com", to: ["b@example.com"], subject: "B", html: "<b>B</b>" },
		]);
	});

	it("gets, updates, and cancels an email", async () => {
		const raw = {
			id: "e1",
			from: "s@mail.example.com",
			to: ["a@example.com"],
			cc: [],
			bcc: null,
			reply_to: "r@example.com",
			subject: "S",
			html: "<p>x</p>",
			text: null,
			created_at: "2026-04-03 22:13:42.674981+00",
			scheduled_at: null,
			last_event: "delivered",
			tags: [{ name: "category", value: "x" }],
		};
		const { client, http } = setup([
			{ status: 200, body: raw },
			{ status: 200, body: { object: "email", id: "e1" } },
			{ status: 200, body: { object: "email", id: "e1" } },
			{ status: 200, body: { object: "email", id: "e1" } },
		]);
		expect(await client.getEmail("e1")).toEqual({
			id: "e1",
			from: "s@mail.example.com",
			to: ["a@example.com"],
			cc: [],
			bcc: [],
			replyTo: ["r@example.com"],
			subject: "S",
			html: "<p>x</p>",
			text: null,
			createdAt: "2026-04-03 22:13:42.674981+00",
			scheduledAt: null,
			lastEvent: "delivered",
			tags: [{ name: "category", value: "x" }],
		});
		expect(http.calls[0]).toMatchObject({ method: "GET", url: "https://api.resend.com/emails/e1" });
		expect(http.calls[0]!.headers["content-type"]).toBeUndefined();

		await client.updateEmail("e1", { scheduledAt: new Date("2026-12-02T00:00:00.000Z") });
		expect(http.calls[1]).toMatchObject({
			method: "PATCH",
			url: "https://api.resend.com/emails/e1",
			body: { scheduled_at: "2026-12-02T00:00:00.000Z" },
		});
		await client.updateEmail("e1", { scheduledAt: "2026-12-03T00:00:00.000Z" });
		expect(http.calls[2]!.body).toEqual({ scheduled_at: "2026-12-03T00:00:00.000Z" });

		expect(await client.cancelEmail("e 1/x")).toEqual({ id: "e1" });
		expect(http.calls[3]).toMatchObject({
			method: "POST",
			url: "https://api.resend.com/emails/e%201%2Fx/cancel",
		});
	});

	it("lists and gets domains", async () => {
		const { client, http } = setup([
			{
				status: 200,
				body: {
					data: [{ id: "d1", name: "mail.example.com", status: "verified", region: "eu-west-1" }],
				},
			},
			{
				status: 200,
				body: {
					id: "d1",
					name: "mail.example.com",
					status: "pending",
					created_at: "2026-01-01",
					records: [
						{
							record: "SPF",
							name: "send",
							type: "MX",
							value: "mx",
							status: "verified",
							ttl: "Auto",
							priority: 10,
						},
						{
							record: "DKIM",
							name: "resend._domainkey",
							type: "TXT",
							value: "p=",
							status: "pending",
						},
					],
				},
			},
			{ status: 200, body: { object: "list" } },
		]);
		expect(await client.listDomains()).toEqual([
			{
				id: "d1",
				name: "mail.example.com",
				status: "verified",
				region: "eu-west-1",
				createdAt: null,
			},
		]);
		const domain = await client.getDomain("d1");
		expect(domain.records).toEqual([
			{
				record: "SPF",
				name: "send",
				type: "MX",
				value: "mx",
				status: "verified",
				ttl: "Auto",
				priority: 10,
			},
			{ record: "DKIM", name: "resend._domainkey", type: "TXT", value: "p=", status: "pending" },
		]);
		expect(http.calls[1]!.url).toBe("https://api.resend.com/domains/d1");
		expect(await client.listDomains()).toEqual([]);
	});
});

describe("validation before the network call", () => {
	const base = { from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" };

	it.each([
		["no sender", { ...base, from: undefined }, "no sender"],
		["no recipient", { ...base, to: [] }, "no recipient"],
		["no subject", { ...base, subject: undefined }, "no subject"],
		["no content", { ...base, text: undefined }, "no content"],
		["template with html", { ...base, template: { id: "t" }, html: "<p>x</p>" }, "Do not combine"],
		["invalid tag", { ...base, tags: { "bad name": "x" } }, "Invalid tag"],
		["invalid tag value", { ...base, tags: [{ name: "ok", value: "no spaces" }] }, "Invalid tag"],
	])("rejects an email with %s", async (_name, email, text) => {
		const { client, http } = setup();
		const error = await failure(client.send(email as never));
		expect(error.code).toBe("validation");
		expect(error.message).toContain(text);
		expect(http.calls).toHaveLength(0);
	});

	it("rejects more than 50 recipients", async () => {
		const { client } = setup();
		const to = Array.from({ length: 51 }, (_, index) => `p${index}@example.com`);
		expect((await failure(client.send({ ...base, to }))).message).toContain("limit is 50");
	});

	it("rejects an attachment without content and path, or with the two", async () => {
		const { client } = setup();
		expect((await failure(client.send({ ...base, attachments: [{ filename: "x" }] }))).code).toBe(
			"invalid_attachment",
		);
		expect(
			(
				await failure(
					client.send({ ...base, attachments: [{ content: "eA==", path: "https://x.example/y" }] }),
				)
			).code,
		).toBe("invalid_attachment");
	});

	it("rejects an empty batch, a large batch, and a batch with attachments", async () => {
		const { client, http } = setup();
		expect((await failure(client.sendBatch([]))).message).toContain("empty");
		expect(
			(await failure(client.sendBatch(Array.from({ length: 101 }, () => base)))).message,
		).toContain("limit is 100");
		expect(
			(await failure(client.sendBatch([{ ...base, attachments: [{ content: "eA==" }] }]))).message,
		).toContain("does not accept attachments");
		expect(http.calls).toHaveLength(0);
	});

	it("rejects a missing ID and a missing schedule time", async () => {
		const { client } = setup();
		expect((await failure(client.getEmail(""))).code).toBe("validation");
		expect((await failure(client.updateEmail("e1", { scheduledAt: "" }))).code).toBe("validation");
	});
});

describe("idempotency", () => {
	const email = { from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" };

	it("sends the given idempotency key", async () => {
		const { client, http } = setup();
		await client.send(email, { idempotencyKey: "welcome-user/123" });
		expect(http.calls[0]!.headers["idempotency-key"]).toBe("welcome-user/123");
	});

	it("creates a random key when the caller gives none", async () => {
		const { client, http } = setup();
		await client.send(email);
		await client.send(email);
		const first = http.calls[0]!.headers["idempotency-key"];
		const second = http.calls[1]!.headers["idempotency-key"];
		expect(first).toMatch(/^[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	it("keeps the same key and the same body for each retry", async () => {
		const { client, http } = setup([
			{ status: 500, body: { name: "application_error", message: "x" } },
			{ status: 503, body: { name: "service_unavailable", message: "x" } },
			{ status: 200, body: { id: "ok" } },
		]);
		expect(await client.send(email)).toEqual({ id: "ok" });
		expect(http.calls).toHaveLength(3);
		const keys = new Set(http.calls.map((call) => call.headers["idempotency-key"]));
		expect(keys.size).toBe(1);
		expect(http.calls[2]!.body).toEqual(http.calls[0]!.body);
	});

	it("does not add a key to a GET request", async () => {
		const { client, http } = setup([{ status: 200, body: { data: [] } }]);
		await client.listDomains();
		expect(http.calls[0]!.headers["idempotency-key"]).toBeUndefined();
	});
});

describe("retries", () => {
	const email = { from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" };
	const rateLimit = {
		status: 429,
		body: { name: "rate_limit_exceeded", message: "Too many requests" },
	};

	it("retries a 429 response with exponential backoff and jitter", async () => {
		const { client, http, sleeps } = setup(
			[rateLimit, rateLimit, { status: 200, body: { id: "ok" } }],
			{
				retryBaseDelayMs: 1000,
				retryMaxDelayMs: 8000,
			},
		);
		await client.send(email);
		expect(http.calls).toHaveLength(3);
		// Equal jitter with random = 0.5: 75% of 1000, then 75% of 2000.
		expect(sleeps).toEqual([750, 1500]);
	});

	it("keeps the delay under the maximum", async () => {
		const { client, sleeps } = setup(
			[rateLimit, rateLimit, rateLimit, { status: 200, body: { id: "ok" } }],
			{
				maxRetries: 3,
				retryBaseDelayMs: 1000,
				retryMaxDelayMs: 1500,
				random: () => 1,
			},
		);
		await client.send(email);
		expect(sleeps).toEqual([1000, 1500, 1500]);
	});

	it("honours the retry-after header", async () => {
		const { client, sleeps } = setup(
			[
				{ ...rateLimit, headers: { "retry-after": "3" } },
				{ status: 200, body: { id: "ok" } },
			],
			{ retryBaseDelayMs: 100 },
		);
		await client.send(email);
		expect(sleeps).toEqual([3000]);
	});

	it("honours a retry-after header with a date", async () => {
		vi.useFakeTimers({ now: new Date("2026-01-01T00:00:00.000Z"), toFake: ["Date"] });
		try {
			const { client, sleeps } = setup(
				[
					{ ...rateLimit, headers: { "retry-after": "Thu, 01 Jan 2026 00:00:02 GMT" } },
					{ status: 200, body: { id: "ok" } },
				],
				{ retryBaseDelayMs: 100 },
			);
			await client.send(email);
			expect(sleeps).toEqual([2000]);
		} finally {
			vi.useRealTimers();
		}
	});

	it("fails at once when retry-after is longer than the maximum delay", async () => {
		const { client, http, sleeps } = setup([{ ...rateLimit, headers: { "retry-after": "120" } }]);
		const error = await failure(client.send(email));
		expect(error.code).toBe("rate_limited");
		expect(error.retryAfter).toBe(120);
		expect(http.calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	it("stops after the maximum number of retries and reports the attempts", async () => {
		const { client, http } = setup([rateLimit, rateLimit, rateLimit, rateLimit], { maxRetries: 2 });
		const error = await failure(client.send(email));
		expect(error.code).toBe("rate_limited");
		expect(error.attempts).toBe(3);
		expect(http.calls).toHaveLength(3);
	});

	it("does not retry when maxRetries is 0", async () => {
		const { client, http } = setup([rateLimit], { maxRetries: 0 });
		await failure(client.send(email));
		expect(http.calls).toHaveLength(1);
	});

	it("retries a network error", async () => {
		const { client, http } = setup([
			new TypeError("fetch failed"),
			{ status: 200, body: { id: "ok" } },
		]);
		expect(await client.send(email)).toEqual({ id: "ok" });
		expect(http.calls).toHaveLength(2);
	});

	it("reports a network error after the last retry, without the API key", async () => {
		const { client } = setup(
			[new TypeError(`connect failed for Bearer ${TEST_KEY}`), new TypeError("again")],
			{ maxRetries: 1 },
		);
		const error = await failure(client.send(email));
		expect(error.code).toBe("network_error");
		expect(error.retryable).toBe(true);
		expect(error.attempts).toBe(2);
		expect(error.message).not.toContain(TEST_KEY);
	});

	it("retries a busy idempotency key", async () => {
		const { client, http } = setup([
			{ status: 409, body: { name: "concurrent_idempotent_requests", message: "in progress" } },
			{ status: 200, body: { id: "ok" } },
		]);
		await client.send(email);
		expect(http.calls).toHaveLength(2);
	});

	it.each([
		[400, { name: "validation_error", message: "Invalid `to` field." }, "validation"],
		[401, { name: "validation_error", message: "API key is invalid" }, "invalid_api_key"],
		[
			403,
			{ name: "validation_error", message: "The x.com domain is not verified." },
			"domain_not_verified",
		],
		[422, { name: "missing_required_field", message: "Missing `subject`." }, "validation"],
		[429, { name: "daily_quota_exceeded", message: "Quota." }, "quota_exceeded"],
		[429, { name: "monthly_quota_exceeded", message: "Quota." }, "quota_exceeded"],
		[409, { name: "invalid_idempotent_request", message: "Body changed." }, "idempotency_conflict"],
	])("does not retry a %i response (%o)", async (status, body, code) => {
		const { client, http } = setup([{ status, body }]);
		const error = await failure(client.send(email));
		expect(error.code).toBe(code);
		expect(error.status).toBe(status);
		expect(error.attempts).toBe(1);
		expect(http.calls).toHaveLength(1);
	});

	it("stops when the deadline does not allow the next delay", async () => {
		let time = 0;
		const { client, http } = setup([rateLimit, rateLimit], {
			deadlineMs: 1000,
			retryBaseDelayMs: 2000,
			now: () => time,
		});
		const error = await failure(client.send(email));
		expect(error.code).toBe("rate_limited");
		expect(http.calls).toHaveLength(1);
		time = 0;
	});

	it("limits an attempt to the time that is left before the deadline", async () => {
		const { client, http } = setup(["hang"], { deadlineMs: 30, timeoutMs: 60_000, maxRetries: 0 });
		const started = Date.now();
		const error = await failure(client.send(email));
		expect(error.code).toBe("timeout");
		expect(error.message).toContain("30 ms");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(http.calls).toHaveLength(1);
	});

	it("starts no attempt after the deadline", async () => {
		let time = 0;
		const { client, http } = setup([rateLimit, { status: 200, body: { id: "late" } }], {
			deadlineMs: 1000,
			retryBaseDelayMs: 100,
			now: () => time,
			sleep: async () => {
				time = 5000;
			},
		});
		const error = await failure(client.send(email));
		expect(error.code).toBe("timeout");
		expect(http.calls).toHaveLength(1);
	});

	it("applies the timeout to the read of the response body", async () => {
		const stalled = new Response(new ReadableStream({ start() {} }), { status: 200 });
		const client = createResendClient({
			apiKey: TEST_KEY,
			timeoutMs: 20,
			maxRetries: 0,
			fetch: async () => stalled,
		});
		expect((await failure(client.send(email))).code).toBe("timeout");
	});
});

describe("timeout", () => {
	const email = { from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" };

	it("aborts an attempt after the timeout and retries", async () => {
		const { client, http } = setup(["hang", { status: 200, body: { id: "ok" } }], {
			timeoutMs: 20,
		});
		expect(await client.send(email)).toEqual({ id: "ok" });
		expect(http.calls).toHaveLength(2);
	});

	it("reports a timeout when each attempt hangs", async () => {
		const { client, http } = setup(["hang", "hang"], { timeoutMs: 10, maxRetries: 1 });
		const error = await failure(client.send(email));
		expect(error.code).toBe("timeout");
		expect(error.message).toContain("10 ms");
		expect(error.attempts).toBe(2);
		expect(http.calls).toHaveLength(2);
	});

	it("reports a timeout when fetch ignores the abort signal", async () => {
		const client = createResendClient({
			apiKey: TEST_KEY,
			timeoutMs: 10,
			maxRetries: 0,
			fetch: () => new Promise<Response>(() => {}),
		});
		expect((await failure(client.send(email))).code).toBe("timeout");
	});

	it("maps an abort error from fetch to a timeout", async () => {
		const abort = Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
		const { client } = setup([abort], { maxRetries: 0 });
		const error = await failure(client.send(email));
		expect(error.code).toBe("timeout");
		expect(error.retryable).toBe(true);
	});

	it("stops without a retry when the caller aborts", async () => {
		const controller = new AbortController();
		const { client, http } = setup(["hang", { status: 200, body: { id: "late" } }], {
			timeoutMs: 5000,
		});
		const pending = failure(client.send(email, { signal: controller.signal }));
		setTimeout(() => controller.abort(), 5);
		const error = await pending;
		expect(error.code).toBe("timeout");
		expect(error.retryable).toBe(false);
		expect(http.calls).toHaveLength(1);
	});

	it("fails at once for a signal that is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		const { client } = setup(["hang"]);
		expect((await failure(client.send(email, { signal: controller.signal }))).retryable).toBe(
			false,
		);
	});
});

describe("responses", () => {
	const email = { from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" };

	it("rejects a success response without an ID", async () => {
		const { client } = setup([{ status: 200, body: {} }]);
		expect((await failure(client.send(email))).code).toBe("server_error");
	});

	it("rejects a success response that is not JSON", async () => {
		const { client, http } = setup([{ status: 200, body: "<html>" }]);
		const error = await failure(client.send(email));
		expect(error.code).toBe("server_error");
		expect(http.calls).toHaveLength(1);
	});

	it("rejects a batch response without data", async () => {
		const { client } = setup([{ status: 200, body: { id: "x" } }]);
		expect((await failure(client.sendBatch([email]))).code).toBe("server_error");
	});

	it("accepts an empty success body for a cancel as a server error without an ID", async () => {
		const { client } = setup([{ status: 200 }]);
		expect((await failure(client.cancelEmail("e1"))).code).toBe("server_error");
	});

	it("passes an unknown error from fetch to the caller", async () => {
		const client = createResendClient({
			apiKey: TEST_KEY,
			fetch: () => {
				throw "not an error object";
			},
			maxRetries: 0,
		});
		const error = await failure(client.send(email));
		expect(error.code).toBe("network_error");
		expect(error.message).toContain("not an error object");
	});
});

describe("API key resolution", () => {
	const email = { from: "s@mail.example.com", to: "a@example.com", subject: "S", text: "T" };

	it("reads the key from the environment at request time", async () => {
		const http = fakeFetch();
		const processEnv: Record<string, unknown> = {};
		const client = createResendClient({ fetch: http.fetch, env: envSources(processEnv) });
		expect((await failure(client.send(email))).code).toBe("missing_api_key");
		expect(http.calls).toHaveLength(0);
		processEnv.RESEND_API_KEY = "re_from_env";
		await client.send(email);
		expect(http.calls[0]!.headers.authorization).toBe("Bearer re_from_env");
	});

	it("reads a custom environment variable first", async () => {
		const http = fakeFetch();
		const client = createResendClient({
			fetch: http.fetch,
			apiKeyEnv: "MY_KEY",
			env: envSources({ RESEND_API_KEY: "re_default", MY_KEY: "re_custom" }),
		});
		await client.send(email);
		expect(http.calls[0]!.headers.authorization).toBe("Bearer re_custom");
	});

	it("uses getApiKey before apiKey and does not read the environment", async () => {
		const http = fakeFetch();
		const client = createResendClient({
			fetch: http.fetch,
			apiKey: "re_static",
			getApiKey: async () => "re_dynamic",
			env: envSources({ RESEND_API_KEY: "re_env" }),
		});
		await client.send(email);
		expect(http.calls[0]!.headers.authorization).toBe("Bearer re_dynamic");

		const empty = createResendClient({
			fetch: http.fetch,
			getApiKey: () => undefined,
			env: envSources({ RESEND_API_KEY: "re_env" }),
		});
		expect((await failure(empty.send(email))).code).toBe("missing_api_key");
	});

	it("uses the global fetch when no fetch option is set", async () => {
		const original = globalThis.fetch;
		const spy = vi.fn(async () => new Response(JSON.stringify({ id: "global" }), { status: 200 }));
		globalThis.fetch = spy as unknown as typeof fetch;
		try {
			const client = createResendClient({ apiKey: TEST_KEY });
			expect(await client.send(email)).toEqual({ id: "global" });
			expect(spy).toHaveBeenCalledOnce();
		} finally {
			globalThis.fetch = original;
		}
	});
});

describe("helpers", () => {
	it("formats an address", () => {
		expect(formatAddress(" a@example.com ")).toBe("a@example.com");
		expect(formatAddress({ email: "a@example.com" })).toBe("a@example.com");
		expect(formatAddress({ email: "a@example.com", name: "Site" })).toBe("Site <a@example.com>");
		expect(formatAddress({ email: "a@example.com", name: 'Smith, "Sam"' })).toBe(
			'"Smith, \\"Sam\\"" <a@example.com>',
		);
	});

	it("extracts the bare address", () => {
		expect(extractEmail("Site <A@Example.com>")).toBe("a@example.com");
		expect(extractEmail(" a@example.com ")).toBe("a@example.com");
	});

	it("normalises tags and tag values", () => {
		expect(normaliseTags(undefined)).toEqual([]);
		expect(normaliseTags({ a: "1" })).toEqual([{ name: "a", value: "1" }]);
		expect(toTagValue("@scope/plugin name")).toBe("_scope_plugin_name");
		expect(toTagValue("")).toBe("_");
	});

	it("builds a payload without a network call", () => {
		expect(buildEmailPayload({ from: "s@x.co", to: " a@x.co ", subject: "S", html: "" })).toEqual({
			from: "s@x.co",
			to: ["a@x.co"],
			subject: "S",
			html: "",
		});
	});
});
