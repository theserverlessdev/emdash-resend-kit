/**
 * A typed Resend client that uses `fetch` only.
 *
 * The client has no dependencies. It runs on Cloudflare Workers, on Node, and
 * in each runtime that has `fetch` and Web Crypto.
 *
 * @example
 * ```ts
 * import { createResendClient } from "emdash-resend-kit/client";
 *
 * const resend = createResendClient({ from: "Website <website@mail.example.com>" });
 * const { id } = await resend.send({
 *   to: "person@example.com",
 *   subject: "Hello",
 *   text: "This is a message.",
 * });
 * ```
 */

import { bytesToBase64 } from "./encoding.js";
import { errorFromResponse, redactSecrets, ResendError } from "./errors.js";
import { API_KEY_ENV_NAMES, envNames, resolveEnvSecret, type EnvSources } from "./secrets.js";
import { VERSION } from "./version.js";

export { ResendError, isResendError, redactSecrets } from "./errors.js";
export type { ResendErrorCode } from "./errors.js";

export const DEFAULT_BASE_URL = "https://api.resend.com";
export const MAX_RECIPIENTS = 50;
export const MAX_BATCH_SIZE = 100;

const TAG_PATTERN = /^[A-Za-z0-9_-]{1,256}$/;

/** A sender or a recipient: a plain address, or an address with a name. */
export type AddressInput = string | { email: string; name?: string };

export interface AttachmentInput {
	/** File name that the recipient sees. */
	filename?: string;
	/** File content: Base64 text or bytes. Use `content` or `path`. */
	content?: string | Uint8Array | ArrayBuffer;
	/** URL of a hosted file. Resend downloads the file. */
	path?: string;
	/** MIME type. Resend derives the type from `filename` when you omit it. */
	contentType?: string;
	/** Content ID for an inline image. Use `<img src="cid:ID">` in the HTML. */
	contentId?: string;
}

export interface TagInput {
	name: string;
	value: string;
}

export interface TemplateInput {
	/** ID or alias of a published Resend template. */
	id: string;
	variables?: Record<string, string | number>;
}

export interface SendEmailInput {
	/** Sender. The client default applies when you omit this field. */
	from?: AddressInput;
	/** One recipient, or a list of 1 to 50 recipients. */
	to: string | string[];
	cc?: string | string[];
	bcc?: string | string[];
	replyTo?: string | string[];
	/** Subject. Required unless the template supplies a subject. */
	subject?: string;
	html?: string;
	text?: string;
	/** Custom email headers. */
	headers?: Record<string, string>;
	/** Tags as a list, or as a record of name and value. */
	tags?: TagInput[] | Record<string, string>;
	attachments?: AttachmentInput[];
	/** Time of the send: a `Date`, ISO 8601 text, or text such as `in 1 hour`. */
	scheduledAt?: string | Date;
	/** A published Resend template. Do not combine with `html` or `text`. */
	template?: TemplateInput;
	/** Resend topic ID for subscription preferences. */
	topicId?: string;
}

export interface RequestOptions {
	/**
	 * Idempotency key for a send. The client creates a random key when you omit
	 * this field, so a retry does not send the email twice.
	 */
	idempotencyKey?: string;
	/** Abort signal for the full call, including retries. */
	signal?: AbortSignal;
}

export interface SendEmailResult {
	/** Resend email ID. */
	id: string;
}

export interface ResendEmail {
	id: string;
	from: string;
	to: string[];
	cc: string[];
	bcc: string[];
	replyTo: string[];
	subject: string;
	html: string | null;
	text: string | null;
	createdAt: string;
	scheduledAt: string | null;
	/** Last delivery event, for example `delivered`. */
	lastEvent: string | null;
	tags: TagInput[];
}

export interface ResendDnsRecord {
	record: string;
	name: string;
	type: string;
	value: string;
	status: string;
	ttl?: string;
	priority?: number;
}

export interface ResendDomain {
	id: string;
	name: string;
	/** For example `verified`, `pending`, `not_started`, `failed`. */
	status: string;
	region: string | null;
	createdAt: string | null;
	/** DNS records. Present on `getDomain` only. */
	records?: ResendDnsRecord[];
}

export interface ResendClientOptions {
	/**
	 * API key. When you omit this field, the client reads the key at request
	 * time from the Worker environment or from `process.env`.
	 */
	apiKey?: string;
	/** Name of the environment variable with the API key. */
	apiKeyEnv?: string;
	/** Async source of the API key. This option has priority over `apiKey`. */
	getApiKey?: () => Promise<string | undefined> | string | undefined;
	/** Base URL of the API. Default: `https://api.resend.com`. */
	baseUrl?: string;
	/** Default sender for `send` and `sendBatch`. */
	from?: AddressInput;
	/** Default reply-to address. */
	replyTo?: string | string[];
	/** Default headers for each email. */
	headers?: Record<string, string>;
	/** Default tags for each email. */
	tags?: TagInput[] | Record<string, string>;
	/** Timeout of one HTTP attempt in milliseconds. Default: 10000. */
	timeoutMs?: number;
	/** Number of retries after the first attempt. Default: 2. */
	maxRetries?: number;
	/** First retry delay in milliseconds. Default: 500. */
	retryBaseDelayMs?: number;
	/** Longest retry delay in milliseconds. Default: 8000. */
	retryMaxDelayMs?: number;
	/** Time limit for one call with all retries, in milliseconds. */
	deadlineMs?: number;
	/** `fetch` implementation. Default: the global `fetch`. */
	fetch?: (url: string, init?: RequestInit) => Promise<Response>;
	/** `User-Agent` header. Resend rejects a request that has none. */
	userAgent?: string;
	/** Overrides for tests. */
	env?: EnvSources;
	sleep?: (ms: number) => Promise<void>;
	random?: () => number;
	now?: () => number;
}

export interface ResendClient {
	/** Send one email. */
	send(email: SendEmailInput, options?: RequestOptions): Promise<SendEmailResult>;
	/** Send 1 to 100 emails in one request. Attachments are not available. */
	sendBatch(emails: SendEmailInput[], options?: RequestOptions): Promise<SendEmailResult[]>;
	/** Get one email with its last delivery event. */
	getEmail(id: string, options?: RequestOptions): Promise<ResendEmail>;
	/** Change the time of a scheduled email. */
	updateEmail(
		id: string,
		update: { scheduledAt: string | Date },
		options?: RequestOptions,
	): Promise<SendEmailResult>;
	/** Cancel a scheduled email. */
	cancelEmail(id: string, options?: RequestOptions): Promise<SendEmailResult>;
	/** List the domains of the account. This call needs a full-access key. */
	listDomains(options?: RequestOptions): Promise<ResendDomain[]>;
	/** Get one domain with its DNS records. This call needs a full-access key. */
	getDomain(id: string, options?: RequestOptions): Promise<ResendDomain>;
}

function validationError(message: string): ResendError {
	return new ResendError({ code: "validation", message });
}

/** Format an address as `Name <email>`. */
export function formatAddress(address: AddressInput): string {
	if (typeof address === "string") return address.trim();
	const email = address.email.trim();
	const name = address.name?.trim();
	if (!name) return email;
	const safeName = /[",<>@:;()[\]\\]/.test(name) ? `"${name.replace(/["\\]/g, "\\$&")}"` : name;
	return `${safeName} <${email}>`;
}

/** Extract the bare email address from `Name <email>` text. */
export function extractEmail(address: string): string {
	const match = /<([^<>]+)>\s*$/.exec(address);
	return (match?.[1] ?? address).trim().toLowerCase();
}

function toList(value: string | string[] | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	const list = (Array.isArray(value) ? value : [value]).map((item) => item.trim()).filter(Boolean);
	return list.length > 0 ? list : undefined;
}

/** Convert tags to the list form. Throw for a name or value that Resend rejects. */
export function normaliseTags(tags: TagInput[] | Record<string, string> | undefined): TagInput[] {
	if (!tags) return [];
	const list = Array.isArray(tags)
		? tags
		: Object.entries(tags).map(([name, value]) => ({ name, value }));
	for (const tag of list) {
		if (!TAG_PATTERN.test(tag.name) || !TAG_PATTERN.test(String(tag.value))) {
			throw validationError(
				`Invalid tag "${tag.name}". A tag name and a tag value can contain only ASCII letters, numbers, underscores, and dashes (1 to 256 characters).`,
			);
		}
	}
	return list.map((tag) => ({ name: tag.name, value: String(tag.value) }));
}

/** Change a text to a valid tag value. Each invalid character becomes `_`. */
export function toTagValue(text: string): string {
	const value = text.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 256);
	return value.length > 0 ? value : "_";
}

function attachmentToPayload(attachment: AttachmentInput): Record<string, unknown> {
	const hasContent = attachment.content !== undefined;
	const hasPath = typeof attachment.path === "string" && attachment.path.length > 0;
	if (hasContent === hasPath) {
		throw new ResendError({
			code: "invalid_attachment",
			message: "An attachment must have `content` or `path`, and not the two together.",
		});
	}
	const payload: Record<string, unknown> = {};
	if (attachment.filename) payload.filename = attachment.filename;
	if (hasPath) payload.path = attachment.path;
	if (hasContent) {
		const content = attachment.content as string | Uint8Array | ArrayBuffer;
		payload.content =
			typeof content === "string"
				? content
				: bytesToBase64(content instanceof Uint8Array ? content : new Uint8Array(content));
	}
	if (attachment.contentType) payload.content_type = attachment.contentType;
	if (attachment.contentId) payload.content_id = attachment.contentId;
	return payload;
}

export interface PayloadDefaults {
	from?: AddressInput;
	replyTo?: string | string[];
	headers?: Record<string, string>;
	tags?: TagInput[] | Record<string, string>;
}

/**
 * Build the JSON body for `POST /emails` from a `SendEmailInput`.
 *
 * The function validates the input and throws a `ResendError` with the code
 * `validation` before a network call.
 */
export function buildEmailPayload(
	email: SendEmailInput,
	defaults: PayloadDefaults = {},
): Record<string, unknown> {
	const from = email.from ?? defaults.from;
	if (!from) {
		throw validationError("The email has no sender. Set `from` on the email or on the client.");
	}
	const to = toList(email.to);
	if (!to) throw validationError("The email has no recipient. Set `to`.");
	if (to.length > MAX_RECIPIENTS) {
		throw validationError(`The email has ${to.length} recipients. The limit is ${MAX_RECIPIENTS}.`);
	}
	if (email.template && (email.html !== undefined || email.text !== undefined)) {
		throw validationError("Do not combine `template` with `html` or `text`.");
	}
	if (!email.template && !email.subject) {
		throw validationError("The email has no subject. Set `subject`.");
	}
	if (!email.template && email.html === undefined && email.text === undefined) {
		throw validationError("The email has no content. Set `html`, `text`, or `template`.");
	}

	const payload: Record<string, unknown> = { from: formatAddress(from), to };
	if (email.subject) payload.subject = email.subject;
	const cc = toList(email.cc);
	if (cc) payload.cc = cc;
	const bcc = toList(email.bcc);
	if (bcc) payload.bcc = bcc;
	const replyTo = toList(email.replyTo) ?? toList(defaults.replyTo);
	if (replyTo) payload.reply_to = replyTo;
	if (email.html !== undefined) payload.html = email.html;
	if (email.text !== undefined) payload.text = email.text;

	const headers = { ...defaults.headers, ...email.headers };
	if (Object.keys(headers).length > 0) payload.headers = headers;

	const tags = new Map<string, string>();
	for (const tag of normaliseTags(defaults.tags)) tags.set(tag.name, tag.value);
	for (const tag of normaliseTags(email.tags)) tags.set(tag.name, tag.value);
	if (tags.size > 0) payload.tags = [...tags].map(([name, value]) => ({ name, value }));

	if (email.attachments && email.attachments.length > 0) {
		payload.attachments = email.attachments.map(attachmentToPayload);
	}
	if (email.scheduledAt !== undefined) {
		payload.scheduled_at =
			email.scheduledAt instanceof Date ? email.scheduledAt.toISOString() : email.scheduledAt;
	}
	if (email.template) {
		payload.template = email.template.variables
			? { id: email.template.id, variables: email.template.variables }
			: { id: email.template.id };
	}
	if (email.topicId) payload.topic_id = email.topicId;
	return payload;
}

function asStringArray(value: unknown): string[] {
	if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
	return typeof value === "string" ? [value] : [];
}

function asNullableString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

function mapEmail(raw: Record<string, unknown>): ResendEmail {
	return {
		id: String(raw.id ?? ""),
		from: String(raw.from ?? ""),
		to: asStringArray(raw.to),
		cc: asStringArray(raw.cc),
		bcc: asStringArray(raw.bcc),
		replyTo: asStringArray(raw.reply_to),
		subject: String(raw.subject ?? ""),
		html: asNullableString(raw.html),
		text: asNullableString(raw.text),
		createdAt: String(raw.created_at ?? ""),
		scheduledAt: asNullableString(raw.scheduled_at),
		lastEvent: asNullableString(raw.last_event),
		tags: Array.isArray(raw.tags) ? (raw.tags as TagInput[]) : [],
	};
}

function mapDomain(raw: Record<string, unknown>): ResendDomain {
	const domain: ResendDomain = {
		id: String(raw.id ?? ""),
		name: String(raw.name ?? ""),
		status: String(raw.status ?? "unknown"),
		region: asNullableString(raw.region),
		createdAt: asNullableString(raw.created_at),
	};
	if (Array.isArray(raw.records)) {
		domain.records = (raw.records as Array<Record<string, unknown>>).map((record) => ({
			record: String(record.record ?? ""),
			name: String(record.name ?? ""),
			type: String(record.type ?? ""),
			value: String(record.value ?? ""),
			status: String(record.status ?? "unknown"),
			...(typeof record.ttl === "string" ? { ttl: record.ttl } : {}),
			...(typeof record.priority === "number" ? { priority: record.priority } : {}),
		}));
	}
	return domain;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/** Create a Resend client. */
export function createResendClient(options: ResendClientOptions = {}): ResendClient {
	const baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
	const timeoutMs = options.timeoutMs ?? 10_000;
	const maxRetries = Math.max(0, options.maxRetries ?? 2);
	const retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
	const retryMaxDelayMs = options.retryMaxDelayMs ?? 8_000;
	const userAgent = options.userAgent ?? `emdash-resend-kit/${VERSION}`;
	const sleep = options.sleep ?? defaultSleep;
	const random = options.random ?? Math.random;
	const now = options.now ?? Date.now;
	const defaults: PayloadDefaults = {
		from: options.from,
		replyTo: options.replyTo,
		headers: options.headers,
		tags: options.tags,
	};

	async function resolveApiKey(): Promise<string> {
		const fromGetter = options.getApiKey ? await options.getApiKey() : undefined;
		const direct = fromGetter ?? options.apiKey;
		if (direct && direct.trim()) return direct.trim();
		if (!options.getApiKey) {
			const resolved = await resolveEnvSecret(
				envNames(options.apiKeyEnv, API_KEY_ENV_NAMES),
				options.env,
			);
			if (resolved) return resolved.value;
		}
		throw new ResendError({
			code: "missing_api_key",
			message:
				"The Resend API key is missing. Set the RESEND_API_KEY environment variable or secret.",
		});
	}

	function backoffDelay(attempt: number): number {
		const ceiling = Math.min(retryMaxDelayMs, retryBaseDelayMs * 2 ** attempt);
		// Equal jitter: one half is fixed, and one half is random.
		return Math.round(ceiling / 2 + (random() * ceiling) / 2);
	}

	async function attemptFetch(
		url: string,
		init: RequestInit,
		apiKey: string,
		signal: AbortSignal | undefined,
		limitMs: number,
	): Promise<{ response: Response; text: string }> {
		const doFetch = options.fetch ?? ((input: string, init_?: RequestInit) => fetch(input, init_));
		if (signal?.aborted) {
			throw new ResendError({
				code: "timeout",
				message: "The caller aborted the request to Resend.",
			});
		}
		const controller = new AbortController();
		const onAbort = () => controller.abort(signal?.reason);
		signal?.addEventListener("abort", onAbort, { once: true });
		let timer: ReturnType<typeof setTimeout> | undefined;
		// The race makes the timeout work even when `fetch` ignores the signal.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(
					new ResendError({
						code: "timeout",
						retryable: true,
						message: `Resend did not answer in ${limitMs} ms.`,
					}),
				);
			}, limitMs);
		});
		try {
			// The timeout also covers the read of the body.
			const exchange = (async () => {
				const response = await doFetch(url, { ...init, signal: controller.signal });
				return { response, text: await response.text() };
			})();
			return await Promise.race([exchange, timeout]);
		} catch (error) {
			if (error instanceof ResendError) throw error;
			if (signal?.aborted) {
				throw new ResendError({
					code: "timeout",
					message: "The caller aborted the request to Resend.",
					cause: error,
				});
			}
			if (isAbortError(error)) {
				throw new ResendError({
					code: "timeout",
					retryable: true,
					message: `Resend did not answer in ${limitMs} ms.`,
					cause: error,
				});
			}
			const reason = error instanceof Error ? error.message : String(error);
			throw new ResendError({
				code: "network_error",
				retryable: true,
				message: `The request to Resend failed: ${redactSecrets(reason, [apiKey])}`,
				cause: error,
			});
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async function request(
		method: string,
		path: string,
		body: unknown,
		requestOptions: RequestOptions = {},
	): Promise<unknown> {
		const apiKey = await resolveApiKey();
		const headers: Record<string, string> = {
			Authorization: `Bearer ${apiKey}`,
			Accept: "application/json",
			"User-Agent": userAgent,
		};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (requestOptions.idempotencyKey) headers["Idempotency-Key"] = requestOptions.idempotencyKey;
		const init: RequestInit = {
			method,
			headers,
			...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		};
		const deadline = options.deadlineMs !== undefined ? now() + options.deadlineMs : undefined;

		let attempt = 0;
		for (;;) {
			let failure: ResendError;
			try {
				// An attempt never runs past the deadline of the call.
				const remaining = deadline === undefined ? timeoutMs : deadline - now();
				if (remaining <= 0) {
					throw new ResendError({
						code: "timeout",
						message: `Resend did not answer in ${options.deadlineMs} ms.`,
					});
				}
				const { response, text } = await attemptFetch(
					`${baseUrl}${path}`,
					init,
					apiKey,
					requestOptions.signal,
					Math.min(timeoutMs, remaining),
				);
				if (response.ok) {
					if (!text) return {};
					try {
						return JSON.parse(text) as unknown;
					} catch {
						throw new ResendError({
							code: "server_error",
							status: response.status,
							message: "Resend returned a response that is not JSON.",
						});
					}
				}
				failure = errorFromResponse(response.status, text, response.headers, [apiKey]);
			} catch (error) {
				if (!(error instanceof ResendError)) throw error;
				failure = error;
			}

			failure.attempts = attempt + 1;
			if (!failure.retryable || attempt >= maxRetries) throw failure;

			const delay =
				failure.retryAfter !== undefined
					? Math.max(failure.retryAfter * 1000, backoffDelay(attempt))
					: backoffDelay(attempt);
			// A long `retry-after` or a near deadline makes a retry useless.
			if (failure.retryAfter !== undefined && failure.retryAfter * 1000 > retryMaxDelayMs) {
				throw failure;
			}
			if (deadline !== undefined && now() + delay + 1 > deadline) throw failure;
			await sleep(delay);
			attempt += 1;
		}
	}

	function expectId(result: unknown): SendEmailResult {
		const id = (result as { id?: unknown } | null)?.id;
		if (typeof id !== "string" || id.length === 0) {
			throw new ResendError({
				code: "server_error",
				message: "Resend returned a response without an email ID.",
			});
		}
		return { id };
	}

	function requirePathId(id: string): string {
		if (!id || typeof id !== "string") throw validationError("The ID is missing.");
		return encodeURIComponent(id);
	}

	return {
		async send(email, requestOptions = {}) {
			const payload = buildEmailPayload(email, defaults);
			const idempotencyKey = requestOptions.idempotencyKey ?? crypto.randomUUID();
			return expectId(
				await request("POST", "/emails", payload, { ...requestOptions, idempotencyKey }),
			);
		},

		async sendBatch(emails, requestOptions = {}) {
			if (!Array.isArray(emails) || emails.length === 0) {
				throw validationError("The batch is empty. Give 1 to 100 emails.");
			}
			if (emails.length > MAX_BATCH_SIZE) {
				throw validationError(
					`The batch has ${emails.length} emails. The limit is ${MAX_BATCH_SIZE}.`,
				);
			}
			const payload = emails.map((email, index) => {
				if (email.attachments && email.attachments.length > 0) {
					throw validationError(
						`Email ${index} has attachments. The Resend batch endpoint does not accept attachments.`,
					);
				}
				return buildEmailPayload(email, defaults);
			});
			const idempotencyKey = requestOptions.idempotencyKey ?? crypto.randomUUID();
			const result = await request("POST", "/emails/batch", payload, {
				...requestOptions,
				idempotencyKey,
			});
			const data = (result as { data?: unknown } | null)?.data;
			if (!Array.isArray(data)) {
				throw new ResendError({
					code: "server_error",
					message: "Resend returned a batch response without data.",
				});
			}
			return data.map(expectId);
		},

		async getEmail(id, requestOptions) {
			const result = await request(
				"GET",
				`/emails/${requirePathId(id)}`,
				undefined,
				requestOptions,
			);
			return mapEmail(result as Record<string, unknown>);
		},

		async updateEmail(id, update, requestOptions) {
			const scheduledAt =
				update.scheduledAt instanceof Date ? update.scheduledAt.toISOString() : update.scheduledAt;
			if (!scheduledAt) throw validationError("Set `scheduledAt` to change a scheduled email.");
			return expectId(
				await request(
					"PATCH",
					`/emails/${requirePathId(id)}`,
					{ scheduled_at: scheduledAt },
					requestOptions,
				),
			);
		},

		async cancelEmail(id, requestOptions) {
			return expectId(
				await request("POST", `/emails/${requirePathId(id)}/cancel`, undefined, requestOptions),
			);
		},

		async listDomains(requestOptions) {
			const result = await request("GET", "/domains", undefined, requestOptions);
			const data = (result as { data?: unknown } | null)?.data;
			return Array.isArray(data) ? (data as Array<Record<string, unknown>>).map(mapDomain) : [];
		},

		async getDomain(id, requestOptions) {
			const result = await request(
				"GET",
				`/domains/${requirePathId(id)}`,
				undefined,
				requestOptions,
			);
			return mapDomain(result as Record<string, unknown>);
		},
	};
}
