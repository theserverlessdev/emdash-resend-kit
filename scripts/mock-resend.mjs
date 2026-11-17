/**
 * A local mock of the Resend API for the integration test.
 *
 * The mock records each request, can return queued failures, and can send a
 * signed webhook. The signature code here uses `node:crypto`. It is
 * independent of the Web Crypto code in `src/webhook.ts`.
 */

import { createHmac, randomUUID } from "node:crypto";
import { createServer } from "node:http";

/**
 * Compute a Svix signature with `node:crypto`.
 *
 * @param {string} secret Signing secret that starts with `whsec_`.
 * @param {string} id Webhook message ID.
 * @param {number} timestamp Unix time in seconds.
 * @param {string} payload Raw body.
 * @returns {string} The signature as `v1,<base64>`.
 */
export function svixSign(secret, id, timestamp, payload) {
	const key = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
	const digest = createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
	return `v1,${digest}`;
}

/**
 * Start the mock server.
 *
 * @param {{ port?: number }} [options]
 */
export async function startMockResend(options = {}) {
	/** @type {Array<{ method: string, path: string, headers: Record<string, string>, body: any }>} */
	const requests = [];
	/** @type {Array<{ status: number, body: unknown, headers?: Record<string, string> }>} */
	const failures = [];
	/** @type {Map<string, string>} */
	const idempotency = new Map();
	/** @type {Map<string, any>} */
	const emails = new Map();

	const domain = {
		id: "d91cd9bd-1176-453e-8fc1-35364d380206",
		name: "mail.example.com",
		status: "verified",
		created_at: "2026-04-26 20:21:26.347412+00",
		region: "eu-west-1",
	};
	const records = [
		{
			record: "SPF",
			name: "send.mail",
			type: "MX",
			ttl: "Auto",
			status: "verified",
			value: "feedback-smtp.eu-west-1.amazonses.com",
			priority: 10,
		},
		{
			record: "SPF",
			name: "send.mail",
			type: "TXT",
			ttl: "Auto",
			status: "verified",
			value: "v=spf1 include:amazonses.com ~all",
		},
		{
			record: "DKIM",
			name: "resend._domainkey.mail",
			type: "TXT",
			ttl: "Auto",
			status: "verified",
			value: "p=MIGfMA0GCSq",
		},
	];

	const server = createServer(async (request, response) => {
		const chunks = [];
		for await (const chunk of request) chunks.push(chunk);
		const raw = Buffer.concat(chunks).toString("utf8");
		let body = null;
		try {
			body = raw ? JSON.parse(raw) : null;
		} catch {
			body = raw;
		}
		const path = new URL(request.url ?? "/", "http://mock").pathname;
		const headers = Object.fromEntries(
			Object.entries(request.headers).map(([key, value]) => [key, String(value)]),
		);
		requests.push({ method: request.method ?? "GET", path, headers, body });

		const send = (status, payload, extra = {}) => {
			response.writeHead(status, { "content-type": "application/json", ...extra });
			response.end(JSON.stringify(payload));
		};

		if (!headers["user-agent"]) return send(403, { message: "error code: 1010" });
		const key = (headers.authorization ?? "").replace(/^Bearer\s+/i, "");
		if (!key)
			return send(401, { statusCode: 401, name: "missing_api_key", message: "Missing API Key" });
		if (key === "re_invalid") {
			return send(401, {
				statusCode: 401,
				name: "validation_error",
				message: "API key is invalid",
			});
		}

		const failure = failures.shift();
		if (failure) return send(failure.status, failure.body, failure.headers ?? {});

		if (request.method === "POST" && path === "/emails") {
			const idempotencyKey = headers["idempotency-key"];
			if (idempotencyKey && idempotency.has(idempotencyKey)) {
				return send(200, { id: idempotency.get(idempotencyKey) });
			}
			const id = randomUUID();
			if (idempotencyKey) idempotency.set(idempotencyKey, id);
			emails.set(id, { ...body, id, last_event: "sent" });
			return send(200, { id });
		}
		if (request.method === "POST" && path === "/emails/batch") {
			return send(200, { data: body.map(() => ({ id: randomUUID() })) });
		}
		const emailMatch = /^\/emails\/([^/]+)(\/cancel)?$/.exec(path);
		if (emailMatch) {
			const id = emailMatch[1];
			if (request.method === "GET") {
				const email = emails.get(id);
				if (!email)
					return send(404, { statusCode: 404, name: "not_found", message: "Email not found" });
				return send(200, {
					object: "email",
					created_at: "2026-04-03 22:13:42.674981+00",
					...email,
				});
			}
			return send(200, { object: "email", id });
		}
		if (request.method === "GET" && path === "/domains") {
			return send(200, { object: "list", has_more: false, data: [domain] });
		}
		if (request.method === "GET" && path === `/domains/${domain.id}`) {
			return send(200, { object: "domain", ...domain, records });
		}
		return send(404, {
			statusCode: 404,
			name: "not_found",
			message: "The requested endpoint does not exist.",
		});
	});

	await new Promise((resolve) => server.listen(options.port ?? 0, "127.0.0.1", resolve));
	const address = server.address();
	const port = typeof address === "object" && address ? address.port : 0;

	return {
		url: `http://127.0.0.1:${port}`,
		requests,
		/** Requests that sent an email. */
		sends: () => requests.filter((item) => item.method === "POST" && item.path === "/emails"),
		/** Queue one failure for the next API request. */
		failNext: (status, body, headers) => failures.push({ status, body, headers }),
		reset: () => {
			requests.length = 0;
			failures.length = 0;
		},
		/**
		 * Send a signed webhook to a URL.
		 *
		 * @param {string} url
		 * @param {string} secret
		 * @param {unknown} event
		 * @param {{ tamper?: boolean, timestampOffset?: number, id?: string }} [extra]
		 */
		sendWebhook: async (url, secret, event, extra = {}) => {
			const payload = JSON.stringify(event);
			const id = extra.id ?? `msg_${randomUUID().replace(/-/g, "")}`;
			const timestamp = Math.floor(Date.now() / 1000) + (extra.timestampOffset ?? 0);
			const signature = svixSign(secret, id, timestamp, payload);
			const result = await fetch(url, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"svix-id": id,
					"svix-timestamp": String(timestamp),
					"svix-signature": signature,
					"user-agent": "Svix-Webhooks/1.0 (mock)",
				},
				body: extra.tamper
					? payload.replace(/"type":"[^"]+"/, '"type":"email.delivered"') + " "
					: payload,
			});
			return { status: result.status, body: await result.text(), id };
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}
