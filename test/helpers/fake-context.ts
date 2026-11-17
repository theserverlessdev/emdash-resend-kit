/**
 * In-memory stand-ins for the EmDash plugin context.
 *
 * The storage fake implements the parts of `StorageCollection` that the
 * plugin uses: versioned writes, guarded updates, and indexed queries.
 */

import type { PluginContext, RouteContext } from "emdash";

type Doc = Record<string, unknown>;

interface Stored {
	data: Doc;
	revision: number;
}

function matches(data: Doc, where: Record<string, unknown> | undefined): boolean {
	if (!where) return true;
	for (const [field, condition] of Object.entries(where)) {
		const value = data[field] as string | number | undefined;
		if (typeof condition === "object" && condition !== null) {
			const filter = condition as {
				gt?: string | number;
				gte?: string | number;
				lt?: string | number;
				lte?: string | number;
				in?: unknown[];
				startsWith?: string;
			};
			if (filter.in && !filter.in.includes(value)) return false;
			if (filter.startsWith !== undefined && !String(value).startsWith(filter.startsWith)) {
				return false;
			}
			if (filter.gt !== undefined && !(value !== undefined && value > filter.gt)) return false;
			if (filter.gte !== undefined && !(value !== undefined && value >= filter.gte)) return false;
			if (filter.lt !== undefined && !(value !== undefined && value < filter.lt)) return false;
			if (filter.lte !== undefined && !(value !== undefined && value <= filter.lte)) return false;
		} else if (value !== condition) {
			return false;
		}
	}
	return true;
}

export class FakeCollection {
	readonly docs = new Map<string, Stored>();
	private counter = 0;
	/** Number of `compareAndSet` calls that must fail before one succeeds. */
	conflicts = 0;

	async get(id: string): Promise<Doc | null> {
		return structuredClone(this.docs.get(id)?.data) ?? null;
	}

	async put(id: string, data: Doc): Promise<void> {
		this.docs.set(id, { data: structuredClone(data), revision: (this.counter += 1) });
	}

	async delete(id: string): Promise<boolean> {
		return this.docs.delete(id);
	}

	async exists(id: string): Promise<boolean> {
		return this.docs.has(id);
	}

	async getVersioned(id: string): Promise<{ value: Doc; revision: string } | null> {
		const stored = this.docs.get(id);
		return stored
			? { value: structuredClone(stored.data), revision: String(stored.revision) }
			: null;
	}

	async compareAndSet(
		id: string,
		expectedRevision: string | null,
		data: Doc,
	): Promise<{ applied: true; revision: string } | { applied: false }> {
		if (this.conflicts > 0) {
			this.conflicts -= 1;
			return { applied: false };
		}
		const stored = this.docs.get(id);
		if (
			expectedRevision === null
				? stored !== undefined
				: String(stored?.revision) !== expectedRevision
		) {
			return { applied: false };
		}
		await this.put(id, data);
		return { applied: true, revision: String(this.counter) };
	}

	async updateIf(
		id: string,
		args: {
			where: Record<string, unknown>;
			set?: Doc;
			delta?: Record<string, { inc?: number; dec?: number }>;
		},
	): Promise<{ applied: true; data: Doc } | { applied: false }> {
		const stored = this.docs.get(id);
		if (!stored || !matches(stored.data, args.where)) return { applied: false };
		const next = { ...stored.data, ...args.set };
		for (const [field, change] of Object.entries(args.delta ?? {})) {
			next[field] = (Number(next[field]) || 0) + (change.inc ?? 0) - (change.dec ?? 0);
		}
		await this.put(id, next);
		return { applied: true, data: structuredClone(next) };
	}

	async getMany(ids: string[]): Promise<Map<string, Doc>> {
		const result = new Map<string, Doc>();
		for (const id of ids) {
			const stored = this.docs.get(id);
			if (stored) result.set(id, structuredClone(stored.data));
		}
		return result;
	}

	async putMany(items: Array<{ id: string; data: Doc }>): Promise<void> {
		for (const item of items) await this.put(item.id, item.data);
	}

	async deleteMany(ids: string[]): Promise<number> {
		let deleted = 0;
		for (const id of ids) if (this.docs.delete(id)) deleted += 1;
		return deleted;
	}

	async query(
		options: {
			where?: Record<string, unknown>;
			orderBy?: Record<string, "asc" | "desc">;
			limit?: number;
			cursor?: string;
		} = {},
	): Promise<{ items: Array<{ id: string; data: Doc }>; cursor?: string; hasMore: boolean }> {
		let items = [...this.docs.entries()]
			.filter(([, stored]) => matches(stored.data, options.where))
			.map(([id, stored]) => ({ id, data: structuredClone(stored.data) }));
		const [field, direction] = Object.entries(options.orderBy ?? {})[0] ?? [];
		if (field) {
			items.sort((a, b) => {
				const order =
					String(a.data[field]).localeCompare(String(b.data[field])) || a.id.localeCompare(b.id);
				return direction === "desc" ? -order : order;
			});
		}
		const offset = options.cursor ? Number(options.cursor) : 0;
		const limit = Math.min(options.limit ?? 50, 100);
		const total = items.length;
		items = items.slice(offset, offset + limit);
		const hasMore = offset + limit < total;
		return { items, hasMore, ...(hasMore ? { cursor: String(offset + limit) } : {}) };
	}

	async count(where?: Record<string, unknown>): Promise<number> {
		return [...this.docs.values()].filter((stored) => matches(stored.data, where)).length;
	}
}

export class FakeKeyValue {
	readonly values = new Map<string, unknown>();
	/** Keys whose read must fail. This simulates an unreadable secret. */
	readonly unreadable = new Set<string>();
	/** Set to make each write fail. This simulates a missing encryption key. */
	failWrites = false;

	async get<T>(key: string): Promise<T | null> {
		if (this.unreadable.has(key)) throw new Error("decryption failed");
		return (this.values.get(key) as T | undefined) ?? null;
	}

	async set(key: string, value: unknown): Promise<void> {
		if (this.failWrites) throw new Error("Plugin secret settings require EMDASH_ENCRYPTION_KEY");
		this.values.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<boolean> {
		return this.values.delete(key);
	}

	async list(prefix = ""): Promise<Array<{ key: string; value: unknown }>> {
		if (this.unreadable.size > 0) throw new Error("decryption failed");
		return [...this.values.entries()]
			.filter(([key]) => key.startsWith(prefix))
			.map(([key, value]) => ({ key, value }));
	}
}

export interface LogLine {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	data?: unknown;
}

export interface FetchCall {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

export type FetchReply =
	{ status: number; body?: unknown; headers?: Record<string, string> } | Error | "hang";

/** Create a `fetch` stand-in that records calls and returns queued replies. */
export function fakeFetch(replies: FetchReply[] = []) {
	const calls: FetchCall[] = [];
	const queue = [...replies];
	const fetch = async (url: string, init: RequestInit = {}): Promise<Response> => {
		const headers: Record<string, string> = {};
		new Headers(init.headers).forEach((value, key) => (headers[key] = value));
		let body: unknown = init.body;
		if (typeof init.body === "string") {
			try {
				body = JSON.parse(init.body);
			} catch {
				body = init.body;
			}
		}
		calls.push({ url, method: init.method ?? "GET", headers, body });
		const reply =
			queue.length > 0 ? queue.shift() : { status: 200, body: { id: `email-${calls.length}` } };
		if (reply instanceof Error) throw reply;
		if (reply === "hang") {
			return new Promise<Response>((_, reject) => {
				init.signal?.addEventListener("abort", () => {
					reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
				});
			});
		}
		const text =
			reply?.body === undefined
				? ""
				: typeof reply.body === "string"
					? reply.body
					: JSON.stringify(reply.body);
		return new Response(text, {
			status: reply?.status ?? 200,
			headers: reply?.headers,
		});
	};
	return { fetch, calls, queue };
}

export interface FakeContext {
	ctx: PluginContext;
	emails: FakeCollection;
	suppressions: FakeCollection;
	stats: FakeCollection;
	kv: FakeKeyValue;
	settings: FakeKeyValue;
	logs: LogLine[];
	cronTasks: Map<string, string>;
	http: ReturnType<typeof fakeFetch>;
}

/** Create a plugin context with in-memory storage. */
export function fakeContext(replies: FetchReply[] = [], withHttp = true): FakeContext {
	const emails = new FakeCollection();
	const suppressions = new FakeCollection();
	const stats = new FakeCollection();
	const kv = new FakeKeyValue();
	const settings = new FakeKeyValue();
	const logs: LogLine[] = [];
	const cronTasks = new Map<string, string>();
	const http = fakeFetch(replies);
	const log = (level: LogLine["level"]) => (message: string, data?: unknown) => {
		logs.push({ level, message, data });
	};
	const ctx = {
		plugin: { id: "emdash-resend-kit", version: "0.0.0-test" },
		storage: { emails, suppressions, stats },
		kv,
		settings,
		log: { debug: log("debug"), info: log("info"), warn: log("warn"), error: log("error") },
		site: { name: "Test Site", url: "https://site.example", locale: "en" },
		url: (path: string) => `https://site.example${path}`,
		cron: {
			schedule: async (name: string, options: { schedule: string }) => {
				cronTasks.set(name, options.schedule);
			},
			cancel: async (name: string) => {
				cronTasks.delete(name);
			},
			list: async () =>
				[...cronTasks.entries()].map(([name, schedule]) => ({
					name,
					schedule,
					nextRunAt: "2026-01-02T00:00:00.000Z",
					lastRunAt: null,
				})),
		},
		...(withHttp ? { http: { fetch: http.fetch } } : {}),
	} as unknown as PluginContext;
	return { ctx, emails, suppressions, stats, kv, settings, logs, cronTasks, http };
}

/** Wrap a plugin context as a route context. */
export function routeContext(
	fake: FakeContext,
	input: unknown,
	init: { headers?: Record<string, string>; user?: { email: string } } = {},
): RouteContext {
	return {
		...fake.ctx,
		input,
		request: new Request("https://site.example/_emdash/api/plugins/emdash-resend-kit/route", {
			method: "POST",
			headers: init.headers,
		}),
		requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
		...(init.user
			? { user: { id: "user-1", email: init.user.email, name: "Admin", role: 50, createdAt: "" } }
			: {}),
	} as unknown as RouteContext;
}

/** Environment sources for tests. The Worker environment is empty by default. */
export function envSources(
	processEnv: Record<string, unknown> = {},
	workerEnv: Record<string, unknown> | null = null,
) {
	return {
		workerEnv: async () => workerEnv,
		processEnv: () => processEnv,
	};
}

export const TEST_KEY = "re_test_0123456789abcdef";
export const TEST_WEBHOOK_SECRET = "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw";
