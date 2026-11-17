/**
 * Delivery log, daily statistics, and retention cleanup.
 *
 * The log stores one record for each email. The record ID is the Resend
 * email ID. A send that Resend did not accept gets a local ID.
 */

import type { PluginContext, StorageCollection } from "emdash";

import { redactSecrets } from "../errors.js";
import type { ResendWebhookEvent } from "../webhook.js";
import { displayAddress, shortAddressHash } from "./privacy.js";
import type {
	DailyStats,
	EmailEvent,
	EmailRecord,
	EmailStatus,
	RecipientPrivacy,
	StatField,
} from "./types.js";

const MAX_EVENTS = 50;
const MAX_CAS_ATTEMPTS = 5;
const MAX_TEXT = 500;

/** Higher rank wins when two events disagree about the status. */
const STATUS_RANK: Record<EmailStatus, number> = {
	scheduled: 0,
	sent: 1,
	delivery_delayed: 2,
	delivered: 3,
	opened: 4,
	clicked: 5,
	canceled: 6,
	failed: 6,
	suppressed: 6,
	bounced: 7,
	complained: 8,
};

const EVENT_STATUS: Record<string, EmailStatus> = {
	"email.scheduled": "scheduled",
	"email.sent": "sent",
	"email.delivery_delayed": "delivery_delayed",
	"email.delivered": "delivered",
	"email.opened": "opened",
	"email.clicked": "clicked",
	"email.failed": "failed",
	"email.suppressed": "suppressed",
	"email.bounced": "bounced",
	"email.complained": "complained",
};

const STAT_FIELDS: ReadonlyArray<StatField> = [
	"sent",
	"delivered",
	"bounced",
	"complained",
	"failed",
	"opened",
	"clicked",
	"suppressed",
];

export const ALL_STATUSES = Object.keys(STATUS_RANK) as EmailStatus[];

export function emailsCollection(ctx: PluginContext): StorageCollection<EmailRecord> {
	return ctx.storage.emails as StorageCollection<EmailRecord>;
}

export function statsCollection(ctx: PluginContext): StorageCollection<DailyStats> {
	return ctx.storage.stats as StorageCollection<DailyStats>;
}

function clip(text: string): string {
	return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT - 1)}…` : text;
}

/** UTC date of a time, as `YYYY-MM-DD`. */
export function dateKey(time: Date | string | number): string {
	return new Date(time).toISOString().slice(0, 10);
}

function emptyStats(date: string): DailyStats {
	return {
		date,
		sent: 0,
		delivered: 0,
		bounced: 0,
		complained: 0,
		failed: 0,
		opened: 0,
		clicked: 0,
		suppressed: 0,
	};
}

/** Add 1 to one counter of one day. The update is atomic. */
export async function bumpStat(ctx: PluginContext, date: string, field: StatField): Promise<void> {
	const stats = statsCollection(ctx);
	for (let attempt = 0; attempt < 2; attempt += 1) {
		const result = await stats.updateIf(date, { where: {}, delta: { [field]: { inc: 1 } } });
		if (result.applied) return;
		// The record of the day does not exist. Create it, then count again.
		await stats.compareAndSet(date, null, emptyStats(date));
	}
}

export interface StatsSummary {
	days: number;
	totals: Record<StatField, number>;
	/** One entry for each day, oldest first. */
	series: DailyStats[];
}

/** Read the counters of the last `days` days, with today as the last day. */
export async function readStats(
	ctx: PluginContext,
	days: number,
	now = Date.now(),
): Promise<StatsSummary> {
	const keys: string[] = [];
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		keys.push(dateKey(now - offset * 86_400_000));
	}
	const found = await statsCollection(ctx).getMany(keys);
	const series = keys.map((key) => ({ ...emptyStats(key), ...found.get(key), date: key }));
	const totals = Object.fromEntries(STAT_FIELDS.map((field) => [field, 0])) as Record<
		StatField,
		number
	>;
	for (const day of series) {
		for (const field of STAT_FIELDS) totals[field] += Number(day[field]) || 0;
	}
	return { days, totals, series };
}

export interface SendRecordInput {
	to: string;
	subject: string;
	source: string;
	resendId: string | null;
	status: "sent" | "scheduled" | "failed" | "suppressed";
	error?: string | null;
	errorCode?: string | null;
	attempts?: number;
	secrets?: ReadonlyArray<string | undefined>;
}

/**
 * Record one send. The function never throws: a problem with the log must
 * not stop an email.
 *
 * @returns The record ID, or `null` when the log did not store a record.
 */
export async function recordSend(
	ctx: PluginContext,
	privacy: RecipientPrivacy,
	logging: boolean,
	input: SendRecordInput,
	now = Date.now(),
): Promise<string | null> {
	try {
		const at = new Date(now).toISOString();
		const statField: StatField = input.status === "scheduled" ? "sent" : input.status;
		if (!logging) {
			await bumpStat(ctx, dateKey(now), statField);
			return null;
		}

		const id = input.resendId ?? `local-${crypto.randomUUID()}`;
		const error = input.error ? clip(redactSecrets(input.error, input.secrets)) : null;
		const record: EmailRecord = {
			resendId: input.resendId,
			to: await displayAddress(input.to, privacy),
			toHash: await shortAddressHash(input.to),
			subject: clip(input.subject),
			status: input.status,
			source: input.source,
			error,
			errorCode: input.errorCode ?? null,
			attempts: input.attempts ?? 1,
			createdAt: at,
			updatedAt: at,
			events: [{ type: input.status, at, ...(error ? { detail: error } : {}) }],
		};
		const emails = emailsCollection(ctx);
		const created = await emails.compareAndSet(id, null, record);
		if (created.applied) {
			await bumpStat(ctx, dateKey(now), statField);
			return id;
		}
		// A record with this ID exists. There are two causes:
		// 1. A webhook arrived before this write. That record has the source
		//    `external`, so set the correct source and subject.
		// 2. Resend returned a known ID for a repeat with the same idempotency
		//    key. Resend sent one email, so keep the first record.
		const merged = await emails.updateIf(id, {
			where: { source: "external" },
			set: { source: input.source, subject: record.subject, to: record.to, toHash: record.toHash },
		});
		if (!merged.applied) {
			ctx.log.debug("Resend returned a known email ID. The log keeps the first record.", { id });
		}
		return id;
	} catch (error) {
		ctx.log.warn("The delivery log did not store a send.", {
			reason: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

function firstString(value: unknown): string | null {
	if (typeof value === "string") return value;
	if (Array.isArray(value) && typeof value[0] === "string") return value[0];
	return null;
}

/** Build the short detail text of a webhook event. */
export function eventDetail(event: ResendWebhookEvent): string | undefined {
	const data = event.data;
	const bounce = data.bounce as
		{ type?: unknown; subType?: unknown; message?: unknown } | undefined;
	if (bounce && typeof bounce === "object") {
		const kind = [bounce.type, bounce.subType]
			.filter((part) => typeof part === "string")
			.join(" / ");
		const message = typeof bounce.message === "string" ? bounce.message : "";
		return clip([kind, message].filter(Boolean).join(": "));
	}
	const failed = data.failed as { reason?: unknown } | undefined;
	if (failed && typeof failed.reason === "string") return clip(failed.reason);
	const suppressed = data.suppressed as { type?: unknown; message?: unknown } | undefined;
	if (suppressed && typeof suppressed === "object") {
		return clip(
			[suppressed.type, suppressed.message].filter((part) => typeof part === "string").join(": "),
		);
	}
	const click = data.click as { link?: unknown } | undefined;
	if (click && typeof click.link === "string") return clip(click.link);
	return undefined;
}

export interface ApplyEventResult {
	/** `recorded`: stored. `duplicate`: a repeat. `ignored`: not an email event or no ID. */
	outcome: "recorded" | "duplicate" | "ignored";
	emailId: string | null;
	status: EmailStatus | null;
}

/**
 * Apply one verified webhook event to the delivery log.
 *
 * The function creates a record when the email is not in the log. That occurs
 * for an email that site code sent with the client.
 */
export async function applyWebhookEvent(
	ctx: PluginContext,
	privacy: RecipientPrivacy,
	event: ResendWebhookEvent,
	webhookId: string,
): Promise<ApplyEventResult> {
	const status = EVENT_STATUS[event.type];
	const emailId = typeof event.data.email_id === "string" ? event.data.email_id : null;
	if (!status || !emailId) return { outcome: "ignored", emailId, status: null };

	const emails = emailsCollection(ctx);
	const at = Number.isNaN(Date.parse(event.created_at))
		? new Date().toISOString()
		: new Date(event.created_at).toISOString();
	const detail = eventDetail(event);
	const entry: EmailEvent = { type: status, at, id: webhookId, ...(detail ? { detail } : {}) };

	for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
		const current = await emails.getVersioned(emailId);
		let next: EmailRecord;
		let firstOfType: boolean;
		if (current) {
			const record = current.value;
			if (record.events.some((item) => item.id === webhookId)) {
				return { outcome: "duplicate", emailId, status: record.status };
			}
			firstOfType = !record.events.some((item) => item.type === status);
			const events = [...record.events, entry]
				.sort((a, b) => a.at.localeCompare(b.at))
				.slice(-MAX_EVENTS);
			const wins = STATUS_RANK[status] >= STATUS_RANK[record.status];
			next = {
				...record,
				status: wins ? status : record.status,
				error: wins && detail && STATUS_RANK[status] >= 6 ? detail : record.error,
				updatedAt: new Date().toISOString(),
				events,
			};
		} else {
			firstOfType = true;
			const to = firstString(event.data.to) ?? "";
			next = {
				resendId: emailId,
				to: to ? await displayAddress(to, privacy) : "",
				toHash: to ? await shortAddressHash(to) : "",
				subject: clip(typeof event.data.subject === "string" ? event.data.subject : ""),
				status,
				source: "external",
				error: detail && STATUS_RANK[status] >= 6 ? detail : null,
				errorCode: null,
				attempts: 1,
				createdAt:
					typeof event.data.created_at === "string" &&
					!Number.isNaN(Date.parse(event.data.created_at))
						? new Date(event.data.created_at).toISOString()
						: at,
				updatedAt: new Date().toISOString(),
				events: [entry],
			};
		}
		const written = await emails.compareAndSet(emailId, current?.revision ?? null, next);
		if (!written.applied) continue;
		// A record from the send path has a `sent` event already, so the `sent`
		// webhook of such an email is not the first of its type.
		if (firstOfType && status !== "scheduled") {
			const field = status === "delivery_delayed" || status === "canceled" ? null : status;
			if (field) await bumpStat(ctx, dateKey(at), field);
		}
		return { outcome: "recorded", emailId, status: next.status };
	}
	throw new Error("The delivery log is busy. Resend will send the webhook again.");
}

export interface LogFilters {
	status?: EmailStatus;
	/** Recipient address, or text in the subject. */
	search?: string;
	/** First day, as `YYYY-MM-DD`. */
	from?: string;
	/** Last day, as `YYYY-MM-DD`. */
	to?: string;
}

export interface LogPage {
	items: Array<{ id: string; data: EmailRecord }>;
	cursor?: string;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const SCAN_PAGES = 5;

/**
 * Query the delivery log, newest first.
 *
 * A search for a full address uses the `toHash` index. Other search text is
 * matched against the recipient and the subject of the most recent records.
 */
export async function queryLog(
	ctx: PluginContext,
	filters: LogFilters,
	cursor?: string,
	limit = 25,
): Promise<LogPage> {
	const emails = emailsCollection(ctx);
	const where: Record<string, unknown> = {};
	if (filters.status && ALL_STATUSES.includes(filters.status)) where.status = filters.status;
	const range: { gte?: string; lte?: string } = {};
	if (filters.from && DATE_PATTERN.test(filters.from)) range.gte = `${filters.from}T00:00:00.000Z`;
	if (filters.to && DATE_PATTERN.test(filters.to)) range.lte = `${filters.to}T23:59:59.999Z`;
	if (range.gte || range.lte) where.createdAt = range;

	const search = filters.search?.trim().toLowerCase() ?? "";
	const isAddress = search.includes("@") && !search.includes(" ") && !search.includes("*");
	if (isAddress) where.toHash = await shortAddressHash(search);
	const textSearch = search && !isAddress ? search : "";

	const items: LogPage["items"] = [];
	let nextCursor = cursor;
	for (let page = 0; page < (textSearch ? SCAN_PAGES : 1); page += 1) {
		const result = await emails.query({
			where: where as never,
			orderBy: { createdAt: "desc" },
			limit: textSearch ? 100 : limit,
			cursor: nextCursor,
		});
		for (const item of result.items) {
			if (
				!textSearch ||
				item.data.subject.toLowerCase().includes(textSearch) ||
				item.data.to.toLowerCase().includes(textSearch)
			) {
				items.push(item);
			}
		}
		nextCursor = result.hasMore ? result.cursor : undefined;
		if (!nextCursor || (textSearch && items.length >= limit)) break;
	}
	return { items, cursor: nextCursor };
}

/**
 * Delete each log record that is older than the retention time, and each
 * daily counter that is older than 90 days.
 *
 * @returns The number of deleted log records.
 */
export async function cleanupLog(
	ctx: PluginContext,
	retentionDays: number,
	now = Date.now(),
	maxBatches = 50,
): Promise<number> {
	const emails = emailsCollection(ctx);
	const cutoff = new Date(now - retentionDays * 86_400_000).toISOString();
	let deleted = 0;
	for (let batch = 0; batch < maxBatches; batch += 1) {
		const result = await emails.query({
			where: { createdAt: { lt: cutoff } },
			orderBy: { createdAt: "asc" },
			limit: 100,
		});
		if (result.items.length === 0) break;
		deleted += await emails.deleteMany(result.items.map((item) => item.id));
		if (!result.hasMore) break;
	}

	const stats = statsCollection(ctx);
	const statsCutoff = dateKey(now - 90 * 86_400_000);
	const oldStats = await stats.query({ where: { date: { lt: statsCutoff } }, limit: 100 });
	if (oldStats.items.length > 0) await stats.deleteMany(oldStats.items.map((item) => item.id));
	return deleted;
}
