import { describe, expect, it } from "vitest";

import {
	applyWebhookEvent,
	bumpStat,
	cleanupLog,
	dateKey,
	eventDetail,
	queryLog,
	readStats,
	recordSend,
} from "../src/plugin/log.js";
import type { EmailRecord } from "../src/plugin/types.js";
import type { ResendWebhookEvent } from "../src/webhook.js";
import { fakeContext, TEST_KEY } from "./helpers/fake-context.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const DAY = 86_400_000;

function event(
	type: string,
	emailId: string,
	extra: Record<string, unknown> = {},
	at = NOW,
): ResendWebhookEvent {
	return {
		type,
		created_at: new Date(at).toISOString(),
		data: {
			email_id: emailId,
			to: ["person@example.com"],
			subject: "Hello",
			created_at: new Date(NOW - 5000).toISOString(),
			...extra,
		},
	};
}

function stored(fake: ReturnType<typeof fakeContext>, id: string): EmailRecord {
	return fake.emails.docs.get(id)?.data as unknown as EmailRecord;
}

describe("recordSend", () => {
	it("stores a sent email under the Resend ID, without a body", async () => {
		const fake = fakeContext();
		const id = await recordSend(
			fake.ctx,
			"full",
			true,
			{
				to: "Person@Example.com",
				subject: "Hello",
				source: "system",
				resendId: "re-1",
				status: "sent",
			},
			NOW,
		);
		expect(id).toBe("re-1");
		const record = stored(fake, "re-1");
		expect(record).toEqual({
			resendId: "re-1",
			to: "person@example.com",
			toHash: expect.stringMatching(/^[0-9a-f]{32}$/),
			subject: "Hello",
			status: "sent",
			source: "system",
			error: null,
			errorCode: null,
			attempts: 1,
			createdAt: "2026-11-17T12:00:00.000Z",
			updatedAt: "2026-11-17T12:00:00.000Z",
			events: [{ type: "sent", at: "2026-11-17T12:00:00.000Z" }],
		});
		expect(Object.keys(record)).not.toContain("text");
		expect(Object.keys(record)).not.toContain("html");
		expect(fake.stats.docs.get("2026-11-17")?.data.sent).toBe(1);
	});

	it("stores a failed email under a local ID with the error, without secrets", async () => {
		const fake = fakeContext();
		const id = await recordSend(
			fake.ctx,
			"full",
			true,
			{
				to: "person@example.com",
				subject: "Hello",
				source: "forms",
				resendId: null,
				status: "failed",
				error: `Rejected. Key ${TEST_KEY} is wrong.`,
				errorCode: "invalid_api_key",
				attempts: 3,
				secrets: [TEST_KEY],
			},
			NOW,
		);
		expect(id).toMatch(/^local-[0-9a-f-]{36}$/);
		const record = stored(fake, id!);
		expect(record.status).toBe("failed");
		expect(record.resendId).toBeNull();
		expect(record.errorCode).toBe("invalid_api_key");
		expect(record.attempts).toBe(3);
		expect(record.error).not.toContain(TEST_KEY);
		expect(record.events[0]?.detail).toBe(record.error);
		expect(fake.stats.docs.get("2026-11-17")?.data).toMatchObject({ sent: 0, failed: 1 });
	});

	it.each([
		["masked", "p***@example.com"],
		["hashed", expect.stringMatching(/^sha256:[0-9a-f]{16}$/)],
	] as const)("hides the recipient with the %s setting", async (privacy, expected) => {
		const fake = fakeContext();
		await recordSend(fake.ctx, privacy, true, {
			to: "person@example.com",
			subject: "S",
			source: "system",
			resendId: "re-1",
			status: "sent",
		});
		expect(stored(fake, "re-1").to).toEqual(expected);
		expect(JSON.stringify(stored(fake, "re-1"))).not.toContain("person@");
	});

	it("counts the send and stores no record when logging is off", async () => {
		const fake = fakeContext();
		const id = await recordSend(
			fake.ctx,
			"full",
			false,
			{
				to: "person@example.com",
				subject: "S",
				source: "system",
				resendId: "re-1",
				status: "sent",
			},
			NOW,
		);
		expect(id).toBeNull();
		expect(fake.emails.docs.size).toBe(0);
		expect(fake.stats.docs.get("2026-11-17")?.data.sent).toBe(1);
	});

	it("keeps the first record when Resend returns a known ID", async () => {
		const fake = fakeContext();
		const input = {
			to: "person@example.com",
			subject: "First",
			source: "system",
			resendId: "re-1",
			status: "sent" as const,
		};
		await recordSend(fake.ctx, "full", true, input, NOW);
		await recordSend(fake.ctx, "full", true, { ...input, subject: "Second" }, NOW + 1000);
		expect(stored(fake, "re-1").subject).toBe("First");
		expect(fake.logs.some((line) => line.level === "debug")).toBe(true);
	});

	it("clips a long subject and counts a scheduled email as sent", async () => {
		const fake = fakeContext();
		await recordSend(
			fake.ctx,
			"full",
			true,
			{
				to: "person@example.com",
				subject: "x".repeat(900),
				source: "system",
				resendId: "re-1",
				status: "scheduled",
			},
			NOW,
		);
		expect(stored(fake, "re-1").subject).toHaveLength(500);
		expect(fake.stats.docs.get("2026-11-17")?.data.sent).toBe(1);
	});

	it("never throws when the storage fails", async () => {
		const fake = fakeContext();
		fake.emails.compareAndSet = async () => {
			throw new Error("database is down");
		};
		const id = await recordSend(fake.ctx, "full", true, {
			to: "person@example.com",
			subject: "S",
			source: "system",
			resendId: "re-1",
			status: "sent",
		});
		expect(id).toBeNull();
		expect(fake.logs.at(-1)).toMatchObject({ level: "warn", data: { reason: "database is down" } });
	});
});

describe("applyWebhookEvent", () => {
	async function sent(fake: ReturnType<typeof fakeContext>, id = "re-1") {
		await recordSend(
			fake.ctx,
			"full",
			true,
			{
				to: "person@example.com",
				subject: "Hello",
				source: "system",
				resendId: id,
				status: "sent",
			},
			NOW - 5000,
		);
	}

	it("adds an event to the record and updates the status", async () => {
		const fake = fakeContext();
		await sent(fake);
		const result = await applyWebhookEvent(
			fake.ctx,
			"full",
			event("email.delivered", "re-1"),
			"msg_1",
		);
		expect(result).toEqual({ outcome: "recorded", emailId: "re-1", status: "delivered" });
		const record = stored(fake, "re-1");
		expect(record.status).toBe("delivered");
		expect(record.events.map((item) => item.type)).toEqual(["sent", "delivered"]);
		expect(record.events[1]).toMatchObject({ id: "msg_1", at: "2026-11-17T12:00:00.000Z" });
		expect(fake.stats.docs.get("2026-11-17")?.data).toMatchObject({ sent: 1, delivered: 1 });
	});

	it("ignores a repeated webhook", async () => {
		const fake = fakeContext();
		await sent(fake);
		await applyWebhookEvent(fake.ctx, "full", event("email.delivered", "re-1"), "msg_1");
		const repeat = await applyWebhookEvent(
			fake.ctx,
			"full",
			event("email.delivered", "re-1"),
			"msg_1",
		);
		expect(repeat.outcome).toBe("duplicate");
		expect(stored(fake, "re-1").events).toHaveLength(2);
		expect(fake.stats.docs.get("2026-11-17")?.data.delivered).toBe(1);
	});

	it("counts each event type one time for one email", async () => {
		const fake = fakeContext();
		await sent(fake);
		await applyWebhookEvent(fake.ctx, "full", event("email.opened", "re-1"), "msg_1");
		await applyWebhookEvent(fake.ctx, "full", event("email.opened", "re-1"), "msg_2");
		await applyWebhookEvent(fake.ctx, "full", event("email.sent", "re-1"), "msg_3");
		expect(stored(fake, "re-1").events).toHaveLength(4);
		expect(fake.stats.docs.get("2026-11-17")?.data).toMatchObject({ sent: 1, opened: 1 });
	});

	it("keeps the stronger status when events arrive out of order", async () => {
		const fake = fakeContext();
		await sent(fake);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			event(
				"email.bounced",
				"re-1",
				{ bounce: { type: "Permanent", subType: "General", message: "No mailbox" } },
				NOW + 2000,
			),
			"msg_1",
		);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			event("email.delivered", "re-1", {}, NOW + 1000),
			"msg_2",
		);
		const record = stored(fake, "re-1");
		expect(record.status).toBe("bounced");
		expect(record.error).toBe("Permanent / General: No mailbox");
		// The timeline is in time order.
		expect(record.events.map((item) => item.type)).toEqual(["sent", "delivered", "bounced"]);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			event("email.complained", "re-1", {}, NOW + 3000),
			"msg_3",
		);
		expect(stored(fake, "re-1").status).toBe("complained");
	});

	it.each([
		["email.sent", "sent"],
		["email.scheduled", "scheduled"],
		["email.delivery_delayed", "delivery_delayed"],
		["email.delivered", "delivered"],
		["email.opened", "opened"],
		["email.clicked", "clicked"],
		["email.failed", "failed"],
		["email.suppressed", "suppressed"],
		["email.bounced", "bounced"],
		["email.complained", "complained"],
	])("creates a record for an unknown email from %s", async (type, status) => {
		const fake = fakeContext();
		const result = await applyWebhookEvent(fake.ctx, "masked", event(type, "ext-1"), "msg_1");
		expect(result).toEqual({ outcome: "recorded", emailId: "ext-1", status });
		const record = stored(fake, "ext-1");
		expect(record).toMatchObject({
			resendId: "ext-1",
			to: "p***@example.com",
			subject: "Hello",
			status,
			source: "external",
			createdAt: "2026-11-17T11:59:55.000Z",
		});
		const stats = fake.stats.docs.get("2026-11-17")?.data ?? {};
		const counted = ["scheduled", "delivery_delayed"].includes(status) ? undefined : 1;
		expect(stats[status]).toBe(counted);
	});

	it("ignores events that are not email events, and events without an ID", async () => {
		const fake = fakeContext();
		expect(
			(await applyWebhookEvent(fake.ctx, "full", event("domain.updated", "x"), "m1")).outcome,
		).toBe("ignored");
		expect(
			(await applyWebhookEvent(fake.ctx, "full", event("email.received", "x"), "m2")).outcome,
		).toBe("ignored");
		expect(
			(
				await applyWebhookEvent(
					fake.ctx,
					"full",
					{ type: "email.sent", created_at: "", data: {} },
					"m3",
				)
			).outcome,
		).toBe("ignored");
		expect(fake.emails.docs.size).toBe(0);
	});

	it("handles an event with missing fields and an invalid time", async () => {
		const fake = fakeContext();
		await applyWebhookEvent(
			fake.ctx,
			"full",
			{
				type: "email.sent",
				created_at: "not a date",
				data: { email_id: "ext-2", to: "single@example.com" },
			},
			"m1",
		);
		const record = stored(fake, "ext-2");
		expect(record.to).toBe("single@example.com");
		expect(record.subject).toBe("");
		expect(Number.isNaN(Date.parse(record.createdAt))).toBe(false);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			{ type: "email.sent", created_at: "", data: { email_id: "ext-3" } },
			"m2",
		);
		expect(stored(fake, "ext-3").to).toBe("");
	});

	it("tries again after a write conflict, and gives up after 5 conflicts", async () => {
		const fake = fakeContext();
		await sent(fake);
		fake.emails.conflicts = 2;
		const result = await applyWebhookEvent(
			fake.ctx,
			"full",
			event("email.delivered", "re-1"),
			"msg_1",
		);
		expect(result.outcome).toBe("recorded");
		fake.emails.conflicts = 5;
		await expect(
			applyWebhookEvent(fake.ctx, "full", event("email.opened", "re-1"), "msg_2"),
		).rejects.toThrow(/busy/);
	});

	it("keeps the newest 50 events", async () => {
		const fake = fakeContext();
		await sent(fake);
		for (let index = 0; index < 55; index += 1) {
			await applyWebhookEvent(
				fake.ctx,
				"full",
				event("email.clicked", "re-1", {}, NOW + index * 1000),
				`msg_${index}`,
			);
		}
		expect(stored(fake, "re-1").events).toHaveLength(50);
	});
});

describe("eventDetail", () => {
	it("describes bounce, failure, suppression, and click", () => {
		expect(
			eventDetail(event("email.bounced", "x", { bounce: { type: "Permanent", message: "Gone" } })),
		).toBe("Permanent: Gone");
		expect(
			eventDetail(event("email.failed", "x", { failed: { reason: "reached_daily_quota" } })),
		).toBe("reached_daily_quota");
		expect(
			eventDetail(
				event("email.suppressed", "x", {
					suppressed: { type: "OnAccountSuppressionList", message: "Listed" },
				}),
			),
		).toBe("OnAccountSuppressionList: Listed");
		expect(
			eventDetail(event("email.clicked", "x", { click: { link: "https://example.com" } })),
		).toBe("https://example.com");
		expect(eventDetail(event("email.delivered", "x"))).toBeUndefined();
	});
});

describe("stats", () => {
	it("creates the day record and counts atomically", async () => {
		const fake = fakeContext();
		await Promise.all([
			bumpStat(fake.ctx, "2026-11-17", "sent"),
			bumpStat(fake.ctx, "2026-11-17", "sent"),
		]);
		await bumpStat(fake.ctx, "2026-11-17", "bounced");
		expect(fake.stats.docs.get("2026-11-17")?.data).toMatchObject({
			date: "2026-11-17",
			sent: 2,
			bounced: 1,
		});
	});

	it("sums the last 7 and 30 days", async () => {
		const fake = fakeContext();
		await bumpStat(fake.ctx, dateKey(NOW), "sent");
		await bumpStat(fake.ctx, dateKey(NOW), "delivered");
		await bumpStat(fake.ctx, dateKey(NOW - 6 * DAY), "sent");
		await bumpStat(fake.ctx, dateKey(NOW - 7 * DAY), "sent");
		await bumpStat(fake.ctx, dateKey(NOW - 29 * DAY), "complained");
		await bumpStat(fake.ctx, dateKey(NOW - 30 * DAY), "bounced");
		const week = await readStats(fake.ctx, 7, NOW);
		expect(week.totals).toMatchObject({ sent: 2, delivered: 1, complained: 0, bounced: 0 });
		expect(week.series).toHaveLength(7);
		expect(week.series.at(-1)?.date).toBe("2026-11-17");
		const month = await readStats(fake.ctx, 30, NOW);
		expect(month.totals).toMatchObject({ sent: 3, delivered: 1, complained: 1, bounced: 0 });
		expect((await readStats(fake.ctx, 1)).series).toHaveLength(1);
	});
});

describe("queryLog", () => {
	async function seed() {
		const fake = fakeContext();
		const rows: Array<[string, string, string, "sent" | "failed", number]> = [
			["re-1", "alice@example.com", "Welcome to the site", "sent", 0],
			["re-2", "bob@example.com", "Your invite", "sent", 1],
			["re-3", "alice@example.com", "Password reset", "failed", 2],
			["re-4", "carol@example.org", "Welcome to the site", "sent", 3],
		];
		for (const [id, to, subject, status, daysAgo] of rows) {
			await recordSend(
				fake.ctx,
				"full",
				true,
				{ to, subject, source: "system", resendId: id, status },
				NOW - daysAgo * DAY,
			);
		}
		return fake;
	}
	const ids = (page: { items: Array<{ id: string }> }) => page.items.map((item) => item.id);

	it("returns the newest records first", async () => {
		const fake = await seed();
		expect(ids(await queryLog(fake.ctx, {}))).toEqual(["re-1", "re-2", "re-3", "re-4"]);
	});

	it("filters by status", async () => {
		const fake = await seed();
		expect(ids(await queryLog(fake.ctx, { status: "failed" }))).toEqual(["re-3"]);
		expect(ids(await queryLog(fake.ctx, { status: "bogus" as never }))).toHaveLength(4);
	});

	it("filters by date", async () => {
		const fake = await seed();
		expect(ids(await queryLog(fake.ctx, { from: "2026-11-16" }))).toEqual(["re-1", "re-2"]);
		expect(ids(await queryLog(fake.ctx, { to: "2026-11-15" }))).toEqual(["re-3", "re-4"]);
		expect(ids(await queryLog(fake.ctx, { from: "2026-11-15", to: "2026-11-16" }))).toEqual([
			"re-2",
			"re-3",
		]);
		expect(ids(await queryLog(fake.ctx, { from: "yesterday" }))).toHaveLength(4);
	});

	it("searches a full address through the hash index", async () => {
		const fake = await seed();
		expect(ids(await queryLog(fake.ctx, { search: " Alice@Example.com " }))).toEqual([
			"re-1",
			"re-3",
		]);
		expect(
			ids(await queryLog(fake.ctx, { search: "alice@example.com", status: "failed" })),
		).toEqual(["re-3"]);
		expect(ids(await queryLog(fake.ctx, { search: "nobody@example.com" }))).toEqual([]);
	});

	it("searches text in the subject and in the recipient", async () => {
		const fake = await seed();
		expect(ids(await queryLog(fake.ctx, { search: "welcome" }))).toEqual(["re-1", "re-4"]);
		expect(ids(await queryLog(fake.ctx, { search: "example.org" }))).toEqual(["re-4"]);
	});

	it("searches a hashed log by the full address", async () => {
		const fake = fakeContext();
		await recordSend(fake.ctx, "hashed", true, {
			to: "alice@example.com",
			subject: "S",
			source: "system",
			resendId: "re-1",
			status: "sent",
		});
		expect(ids(await queryLog(fake.ctx, { search: "alice@example.com" }))).toEqual(["re-1"]);
	});

	it("pages with a cursor", async () => {
		const fake = await seed();
		const first = await queryLog(fake.ctx, {}, undefined, 3);
		expect(ids(first)).toEqual(["re-1", "re-2", "re-3"]);
		expect(first.cursor).toBeDefined();
		const second = await queryLog(fake.ctx, {}, first.cursor, 3);
		expect(ids(second)).toEqual(["re-4"]);
		expect(second.cursor).toBeUndefined();
	});
});

describe("cleanupLog", () => {
	it("deletes records and counters that are too old", async () => {
		const fake = fakeContext();
		for (let index = 0; index < 250; index += 1) {
			await recordSend(
				fake.ctx,
				"full",
				true,
				{
					to: "a@example.com",
					subject: "old",
					source: "system",
					resendId: `old-${index}`,
					status: "sent",
				},
				NOW - 40 * DAY,
			);
		}
		await recordSend(
			fake.ctx,
			"full",
			true,
			{ to: "a@example.com", subject: "new", source: "system", resendId: "new-1", status: "sent" },
			NOW - 2 * DAY,
		);
		await bumpStat(fake.ctx, dateKey(NOW - 100 * DAY), "sent");
		const deleted = await cleanupLog(fake.ctx, 30, NOW);
		expect(deleted).toBe(250);
		expect([...fake.emails.docs.keys()]).toEqual(["new-1"]);
		expect(fake.stats.docs.has(dateKey(NOW - 100 * DAY))).toBe(false);
		expect(fake.stats.docs.has(dateKey(NOW - 40 * DAY))).toBe(true);
		expect(await cleanupLog(fake.ctx, 30, NOW)).toBe(0);
	});

	it("stops after the batch limit", async () => {
		const fake = fakeContext();
		for (let index = 0; index < 150; index += 1) {
			await recordSend(
				fake.ctx,
				"full",
				true,
				{
					to: "a@example.com",
					subject: "old",
					source: "system",
					resendId: `old-${index}`,
					status: "sent",
				},
				NOW - 40 * DAY,
			);
		}
		expect(await cleanupLog(fake.ctx, 30, NOW, 1)).toBe(100);
	});
});
