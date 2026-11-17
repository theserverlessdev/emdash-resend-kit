import { describe, expect, it } from "vitest";

import { createPlugin } from "../src/index.js";
import {
	absoluteUrl,
	parseInteraction,
	saveSettings,
	type Block,
	type BlockResponse,
} from "../src/plugin/admin.js";
import { SETTING_KEYS } from "../src/plugin/config.js";
import { applyWebhookEvent, recordSend } from "../src/plugin/log.js";
import { addSuppression, findSuppression } from "../src/plugin/suppression.js";
import type { ResendKitOptions } from "../src/plugin/types.js";
import {
	envSources,
	fakeContext,
	routeContext,
	TEST_KEY,
	TEST_WEBHOOK_SECRET,
	type FetchReply,
} from "./helpers/fake-context.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");
const DOMAINS = {
	status: 200,
	body: { data: [{ id: "d1", name: "mail.example.com", status: "verified", region: "eu-west-1" }] },
};
const DOMAIN = {
	status: 200,
	body: {
		id: "d1",
		name: "mail.example.com",
		status: "verified",
		records: [
			{
				record: "DKIM",
				name: "resend._domainkey.mail",
				type: "TXT",
				value: "p=",
				status: "verified",
			},
		],
	},
};

function setup(
	options: ResendKitOptions = { from: "Site <site@mail.example.com>" },
	replies: FetchReply[] = [DOMAINS, DOMAIN],
	env: Record<string, unknown> = {
		RESEND_API_KEY: TEST_KEY,
		RESEND_WEBHOOK_SECRET: TEST_WEBHOOK_SECRET,
	},
) {
	const fake = fakeContext(replies);
	let now = NOW;
	const plugin = createPlugin(options, {
		env: envSources(env),
		now: () => now,
		sleep: async () => {},
		random: () => 0,
	});
	const admin = (input: unknown) =>
		plugin.routes.admin!.handler(
			routeContext(fake, input, { user: { email: "admin@example.com" } }),
		) as Promise<BlockResponse>;
	return { fake, plugin, admin, advance: (ms: number) => (now += ms) };
}

function flatten(blocks: Block[]): Block[] {
	return blocks.flatMap((block) => [
		block,
		...(Array.isArray(block.blocks) ? flatten(block.blocks as Block[]) : []),
	]);
}

function find(response: BlockResponse, type: string, blockId?: string): Block | undefined {
	return flatten(response.blocks).find(
		(block) => block.type === type && (blockId === undefined || block.block_id === blockId),
	);
}

function fieldValue(response: BlockResponse, label: string): string | undefined {
	const fields = (find(response, "fields")?.fields ?? []) as Array<{
		label: string;
		value: string;
	}>;
	return fields.find((field) => field.label === label)?.value;
}

function texts(response: BlockResponse): string {
	return JSON.stringify(response.blocks);
}

describe("admin route", () => {
	it("is private and accepts POST", () => {
		const { plugin } = setup();
		const route = plugin.routes.admin as {
			public?: boolean;
			methods?: string[];
			permission?: string;
		};
		expect(route.public).toBeUndefined();
		expect(route.methods).toEqual(["POST"]);
	});

	it("returns no blocks for invalid input", async () => {
		const { admin } = setup();
		for (const input of [null, "text", [], { type: "other" }, {}]) {
			expect(await admin(input)).toEqual({ blocks: [] });
		}
		expect(parseInteraction({ type: "page_load", page: " /log " })).toMatchObject({
			page: "/log",
			actionId: "",
		});
	});

	it("schedules the daily cleanup one time", async () => {
		const { admin, fake } = setup();
		await admin({ type: "page_load", page: "/log" });
		await admin({ type: "page_load", page: "/log" });
		expect([...fake.cronTasks.entries()]).toEqual([["cleanup", "@daily"]]);
	});
});

describe("settings page", () => {
	it("shows the status of the key, the sender, and the secret, without a secret value", async () => {
		const { admin } = setup({
			from: "Site <site@mail.example.com>",
			replyTo: "hello@example.com",
			suppression: true,
		});
		const page = await admin({ type: "page_load", page: "/settings" });
		expect(fieldValue(page, "API key")).toBe("Present. Environment variable RESEND_API_KEY.");
		expect(fieldValue(page, "Sender")).toBe("Site <site@mail.example.com>");
		expect(fieldValue(page, "Reply-to")).toBe("hello@example.com");
		expect(fieldValue(page, "Webhook signing secret")).toBe(
			"Present. Environment variable RESEND_WEBHOOK_SECRET.",
		);
		expect(fieldValue(page, "Delivery log")).toBe("On. Records stay 30 days. Recipients: full.");
		expect(fieldValue(page, "Suppression")).toBe("On");
		expect(texts(page)).not.toContain(TEST_KEY);
		expect(texts(page)).not.toContain(TEST_WEBHOOK_SECRET);
		expect(find(page, "banner")).toBeUndefined();
	});

	it("shows the webhook URL and a link to the EmDash email settings", async () => {
		const { admin } = setup();
		const page = await admin({ type: "page_load", page: "/settings" });
		expect(find(page, "code")?.code).toBe(
			"https://site.example/_emdash/api/plugins/emdash-resend-kit/webhook",
		);
		expect(texts(page)).toContain("https://site.example/_emdash/admin/settings/email");
	});

	it("warns when the key and the sender are missing", async () => {
		const { admin, fake } = setup({}, [], {});
		const page = await admin({ type: "page_load", page: "/settings" });
		expect(fieldValue(page, "API key")).toBe("Missing");
		expect(fieldValue(page, "Sender")).toBe("Not set");
		expect(fieldValue(page, "Webhook signing secret")).toBe("Missing");
		expect(texts(page)).toContain("The API key is missing.");
		expect(texts(page)).toContain("The sender address is missing.");
		expect(texts(page)).toContain("Add an API key to see the domain status.");
		expect(texts(page)).toContain("The plugin rejects each webhook.");
		expect(fake.http.calls).toHaveLength(0);
	});

	it("shows the domains with the DNS records of the sender domain", async () => {
		const { admin, fake } = setup();
		const page = await admin({ type: "page_load", page: "/settings" });
		expect(fake.http.calls.map((call) => call.url)).toEqual([
			"https://api.resend.com/domains",
			"https://api.resend.com/domains/d1",
		]);
		expect(find(page, "table", "domains")?.rows).toEqual([
			{ name: "mail.example.com", status: "verified", region: "eu-west-1" },
		]);
		expect(find(page, "table", "dns-records")?.rows).toEqual([
			{ record: "DKIM", type: "TXT", name: "resend._domainkey.mail", status: "verified" },
		]);
	});

	it("caches the domain status for one minute, and the button forces a check", async () => {
		const { admin, fake, advance } = setup({ from: "site@mail.example.com" }, [
			DOMAINS,
			DOMAIN,
			DOMAINS,
			DOMAIN,
			DOMAINS,
			DOMAIN,
		]);
		await admin({ type: "page_load", page: "/settings" });
		await admin({ type: "page_load", page: "/settings" });
		expect(fake.http.calls).toHaveLength(2);
		await admin({ type: "block_action", action_id: "domains_refresh", page: "/settings" });
		expect(fake.http.calls).toHaveLength(4);
		advance(61_000);
		await admin({ type: "page_load", page: "/settings" });
		expect(fake.http.calls).toHaveLength(6);
	});

	it.each([
		[[{ status: 200, body: { data: [] } }], "No domain is set up in Resend."],
		[
			[
				{
					status: 200,
					body: { data: [{ id: "d2", name: "other.example.com", status: "verified" }] },
				},
			],
			"The sender domain mail.example.com is not in Resend.",
		],
		[
			[DOMAINS, { status: 200, body: { ...DOMAIN.body, status: "pending" } }],
			"The sender domain mail.example.com is not verified.",
		],
		[
			[
				{
					status: 401,
					body: {
						name: "restricted_api_key",
						message: "This API key is restricted to only send emails.",
					},
				},
			],
			"This Resend API key can only send email.",
		],
		[[new Error("socket closed")], "Resend did not return the domains."],
	] as Array<[FetchReply[], string]>)("reports a domain problem (%#)", async (replies, message) => {
		const { admin } = setup({ from: "Site <site@mail.example.com>" }, replies);
		expect(texts(await admin({ type: "page_load", page: "/settings" }))).toContain(message);
	});

	it("saves the settings form", async () => {
		const { admin, fake } = setup();
		const page = await admin({
			type: "form_submit",
			action_id: "settings_save",
			page: "/settings",
			values: {
				fromEmail: "news@mail.example.com",
				fromName: "News",
				replyTo: "editor@example.com",
				apiKey: "re_new_key_from_form",
				webhookSecret: "whsec_bmV3LXNlY3JldA==",
				logging: false,
				recipientPrivacy: "hashed",
				retentionDays: 7,
				suppression: true,
			},
		});
		expect(page.toast).toEqual({ type: "success", message: "Settings saved." });
		expect(Object.fromEntries(fake.settings.values)).toEqual({
			apiKey: "re_new_key_from_form",
			webhookSecret: "whsec_bmV3LXNlY3JldA==",
			fromEmail: "news@mail.example.com",
			fromName: "News",
			replyTo: "editor@example.com",
			logging: false,
			recipientPrivacy: "hashed",
			retentionDays: 7,
			suppression: true,
		});
		expect(fieldValue(page, "Sender")).toBe("News <news@mail.example.com>");
		expect(fieldValue(page, "Delivery log")).toBe("Off");
		// The environment variable still has priority over the stored key.
		expect(fieldValue(page, "API key")).toBe("Present. Environment variable RESEND_API_KEY.");
		expect(texts(page)).not.toContain("re_new_key_from_form");
		const form = find(page, "form", "settings") as { fields: Array<Record<string, unknown>> };
		expect(form.fields.find((field) => field.action_id === "apiKey")).toMatchObject({
			type: "secret_input",
			has_value: true,
		});
		expect(form.fields.find((field) => field.action_id === "fromEmail")?.initial_value).toBe(
			"news@mail.example.com",
		);
		expect(texts(page)).toContain("remove_api_key");
		expect(texts(page)).toContain("remove_webhook_secret");
	});

	it("uses a stored key when the environment has none", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com" }, [DOMAINS, DOMAIN], {});
		fake.settings.values.set(SETTING_KEYS.apiKey, "re_stored_key");
		const page = await admin({ type: "page_load", page: "/settings" });
		expect(fieldValue(page, "API key")).toBe("Present. Encrypted plugin setting.");
		expect(fake.http.calls[0]!.headers.authorization).toBe("Bearer re_stored_key");
		expect(texts(page)).not.toContain("re_stored_key");
	});

	it("keeps a stored secret when the form field is empty, and clears an empty sender", async () => {
		const { fake } = setup();
		fake.settings.values.set(SETTING_KEYS.apiKey, "re_keep_this");
		fake.settings.values.set(SETTING_KEYS.fromEmail, "old@mail.example.com");
		expect(
			await saveSettings(fake.ctx, {
				fromEmail: "",
				fromName: "",
				replyTo: "",
				apiKey: "",
				webhookSecret: "",
			}),
		).toBeNull();
		expect(fake.settings.values.get(SETTING_KEYS.apiKey)).toBe("re_keep_this");
		expect(fake.settings.values.has(SETTING_KEYS.fromEmail)).toBe(false);
	});

	it.each([
		[{ fromEmail: "broken" }, "The sender address is not valid."],
		[{ replyTo: "broken" }, "The reply-to address is not valid."],
		[{ apiKey: "sk_wrong_prefix" }, "A Resend API key starts with re_."],
		[{ webhookSecret: "secret" }, "A webhook signing secret starts with whsec_."],
		[{ recipientPrivacy: "none" }, "The recipient privacy value is not valid."],
		[{ retentionDays: 0 }, "The retention time must be from 1 to 3650 days."],
		[{ retentionDays: "many" }, "The retention time must be from 1 to 3650 days."],
	])("rejects invalid settings %o", async (values, message) => {
		const { admin, fake } = setup();
		const page = await admin({
			type: "form_submit",
			action_id: "settings_save",
			page: "/settings",
			values,
		});
		expect(page.toast).toEqual({ type: "error", message });
		expect(fake.settings.values.size).toBe(0);
	});

	it("reports a missing encryption key and saves nothing", async () => {
		const { admin, fake } = setup();
		fake.settings.failWrites = true;
		const page = await admin({
			type: "form_submit",
			action_id: "settings_save",
			page: "/settings",
			values: { apiKey: "re_new_key", fromEmail: "news@mail.example.com" },
		});
		expect(page.toast?.type).toBe("error");
		expect(page.toast?.message).toContain("EMDASH_ENCRYPTION_KEY");
		expect(fake.settings.values.size).toBe(0);
	});

	it("reports a stored secret that is not readable", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com" }, [], {});
		fake.settings.values.set(SETTING_KEYS.apiKey, { encrypted: true });
		fake.settings.unreadable.add(SETTING_KEYS.apiKey);
		expect(texts(await admin({ type: "page_load", page: "/settings" }))).toContain(
			"A stored secret is not readable.",
		);
	});

	it("removes a stored key and a stored signing secret", async () => {
		const { admin, fake } = setup();
		fake.settings.values.set(SETTING_KEYS.apiKey, "re_stored");
		fake.settings.values.set(SETTING_KEYS.webhookSecret, "whsec_stored");
		const first = await admin({
			type: "block_action",
			action_id: "remove_api_key",
			page: "/settings",
		});
		expect(first.toast?.message).toBe("Stored API key removed.");
		expect(fake.settings.values.has(SETTING_KEYS.apiKey)).toBe(false);
		const second = await admin({
			type: "block_action",
			action_id: "remove_webhook_secret",
			page: "/settings",
		});
		expect(second.toast?.message).toBe("Stored signing secret removed.");
		expect(fake.settings.values.has(SETTING_KEYS.webhookSecret)).toBe(false);
	});

	it("fills the test recipient with the address of the current user", async () => {
		const { admin } = setup();
		const page = await admin({ type: "page_load", page: "/settings" });
		const form = find(page, "form", "test") as { fields: Array<Record<string, unknown>> };
		expect(form.fields[0]?.initial_value).toBe("admin@example.com");
	});
});

describe("test email", () => {
	const submit = (to: string) => ({
		type: "form_submit",
		action_id: "test_send",
		page: "/settings",
		values: { to },
	});

	it("sends a test email and shows the Resend ID", async () => {
		const { admin, fake } = setup({ from: "Site <site@mail.example.com>" }, [
			{ status: 200, body: { id: "re-test-1" } },
			DOMAINS,
			DOMAIN,
		]);
		const page = await admin(submit("me@example.com"));
		expect(page.toast).toEqual({ type: "success", message: "Resend accepted the test email." });
		expect(find(page, "banner")).toMatchObject({
			variant: "default",
			description: "Resend ID: re-test-1",
		});
		const call = fake.http.calls[0]!;
		expect(call.body).toMatchObject({
			from: "Site <site@mail.example.com>",
			to: ["me@example.com"],
			subject: "Test email from Test Site",
			tags: [{ name: "emdash_source", value: "test" }],
		});
		expect(fake.emails.docs.get("re-test-1")?.data).toMatchObject({
			source: "test",
			status: "sent",
		});
	});

	it("sends each test with a new idempotency key", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com" }, [
			{ status: 200, body: { id: "a" } },
			DOMAINS,
			DOMAIN,
			{ status: 200, body: { id: "b" } },
		]);
		await admin(submit("me@example.com"));
		await admin(submit("me@example.com"));
		const keys = fake.http.calls
			.filter((call) => call.url.endsWith("/emails"))
			.map((call) => call.headers["idempotency-key"]);
		expect(keys).toHaveLength(2);
		expect(keys[0]).not.toBe(keys[1]);
	});

	it("shows the mapped error when Resend rejects the test", async () => {
		const { admin } = setup({ from: "site@mail.example.com" }, [
			{ status: 401, body: { name: "validation_error", message: "API key is invalid" } },
			{ status: 401, body: { name: "validation_error", message: "API key is invalid" } },
		]);
		const page = await admin(submit("me@example.com"));
		expect(page.toast).toEqual({ type: "error", message: "The test email failed." });
		expect(find(page, "banner")).toMatchObject({
			variant: "error",
			title: "The test email failed.",
			description: expect.stringContaining("The Resend API key is invalid."),
		});
		expect(texts(page)).not.toContain(TEST_KEY);
	});

	it("rejects an invalid recipient without a send", async () => {
		const { admin, fake } = setup();
		const page = await admin(submit("not-an-address"));
		expect(page.toast).toEqual({ type: "error", message: "Enter a valid recipient address." });
		expect(fake.http.calls.some((call) => call.url.endsWith("/emails"))).toBe(false);
	});
});

describe("log pages", () => {
	async function seeded() {
		const context = setup();
		const { fake } = context;
		for (let index = 0; index < 30; index += 1) {
			await recordSend(
				fake.ctx,
				"full",
				true,
				{
					to: index % 2 === 0 ? "even@example.com" : "odd@example.com",
					subject: `Message ${index}`,
					source: "system",
					resendId: index === 5 ? null : `re-${index}`,
					status: index === 5 ? "failed" : "sent",
					error: index === 5 ? "Resend rejected the request." : null,
				},
				NOW - index * 60_000,
			);
		}
		await applyWebhookEvent(
			fake.ctx,
			"full",
			{
				type: "email.delivered",
				created_at: new Date(NOW).toISOString(),
				data: { email_id: "re-0" },
			},
			"msg_1",
		);
		return context;
	}
	const rows = (page: BlockResponse) =>
		(find(page, "table", "log")?.rows ?? []) as Array<Record<string, unknown>>;

	it("lists 25 emails and gives a cursor for the next page", async () => {
		const { admin } = await seeded();
		const page = await admin({ type: "page_load", page: "/log" });
		expect(rows(page)).toHaveLength(25);
		expect(rows(page)[0]).toMatchObject({
			to: "even@example.com",
			subject: "Message 0",
			status: "Delivered",
			source: "system",
		});
		expect(rows(page)[0]?.view).toMatchObject({
			type: "button",
			action_id: "log_view",
			value: { id: "re-0", f: {} },
		});
		const table = find(page, "table", "log")!;
		expect(typeof table.next_cursor).toBe("string");
		expect(find(page, "accordion")).toMatchObject({ label: "Filters", default_open: false });

		const next = await admin({
			type: "block_action",
			action_id: "log_page",
			page: "/log",
			value: { cursor: table.next_cursor, sort: null },
		});
		expect(rows(next)).toHaveLength(5);
		expect(find(next, "table", "log")?.next_cursor).toBeUndefined();
		expect(texts(next)).toContain("First page");
	});

	it("filters by status, search, and date, and keeps the filters in the form", async () => {
		const { admin } = await seeded();
		const failed = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "failed", search: "", from: "", to: "" },
		});
		expect(rows(failed).map((row) => row.subject)).toEqual(["Message 5"]);
		expect(find(failed, "accordion")?.default_open).toBe(true);
		const form = find(failed, "form", "filters") as { fields: Array<Record<string, unknown>> };
		expect(form.fields[0]?.initial_value).toBe("failed");

		const searched = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "all", search: "odd@example.com" },
		});
		expect(rows(searched)).toHaveLength(15);
		const cursor = find(searched, "table", "log")?.next_cursor;
		expect(cursor).toBeUndefined();

		const dated = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "all", from: "2026-11-18", to: "2026-11-19" },
		});
		expect(rows(dated)).toHaveLength(0);
		expect(find(dated, "table", "log")?.empty_text).toBe("No emails match.");
	});

	it("keeps the filters across pages", async () => {
		const { admin } = await seeded();
		const first = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "sent" },
		});
		expect(rows(first)).toHaveLength(25);
		const next = await admin({
			type: "block_action",
			action_id: "log_page",
			page: "/log",
			value: { cursor: find(first, "table", "log")?.next_cursor },
		});
		expect(rows(next)).toHaveLength(3);
		expect(rows(next).every((row) => row.status === "Sent")).toBe(true);
	});

	it("ignores a broken cursor", async () => {
		const { admin } = await seeded();
		for (const value of [{ cursor: "{not json" }, "also not json", 42, { cursor: "[1,2]" }]) {
			expect(
				rows(await admin({ type: "block_action", action_id: "log_page", page: "/log", value })),
			).toHaveLength(25);
		}
	});

	it("shows the first page when the storage rejects a cursor", async () => {
		const { admin, fake } = await seeded();
		const query = fake.emails.query.bind(fake.emails);
		fake.emails.query = async (options = {}) => {
			if (options.cursor === "bad") throw new Error("Invalid cursor");
			return query(options);
		};
		const page = await admin({
			type: "block_action",
			action_id: "log_page",
			page: "/log",
			value: { cursor: JSON.stringify({ f: { status: "sent" }, c: "bad" }) },
		});
		expect(rows(page)).toHaveLength(25);

		const list = fake.suppressions.query.bind(fake.suppressions);
		fake.suppressions.query = async (options = {}) => {
			if (options.cursor === "bad") throw new Error("Invalid cursor");
			return list(options);
		};
		const suppressions = await admin({
			type: "block_action",
			action_id: "suppressions_page",
			page: "/suppressions",
			value: { cursor: "bad" },
		});
		expect(JSON.stringify(suppressions.blocks)).toContain("Suppression list");
	});

	it("shows the details and the event timeline of one email", async () => {
		const { admin } = await seeded();
		const page = await admin({
			type: "block_action",
			action_id: "log_view",
			page: "/log",
			value: { id: "re-0", f: { status: "delivered" } },
		});
		expect(fieldValue(page, "Recipient")).toBe("even@example.com");
		expect(fieldValue(page, "Status")).toBe("Delivered");
		expect(fieldValue(page, "Resend ID")).toBe("re-0");
		expect(fieldValue(page, "Created")).toBe("2026-11-17 12:00 UTC");
		expect(find(page, "table", "timeline")?.rows).toEqual([
			{ at: "2026-11-17 12:00 UTC", type: "Sent", detail: "" },
			{ at: "2026-11-17 12:00 UTC", type: "Delivered", detail: "" },
		]);
		expect(texts(page)).toContain("https://resend.com/emails/re-0");
		expect(texts(page)).toContain('"action_id":"log_back"');
		expect(texts(page)).toContain('"status":"delivered"');
	});

	it("shows the error of a failed email, without a link to Resend", async () => {
		const { admin } = await seeded();
		const list = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "failed" },
		});
		const value = (rows(list)[0]!.view as { value: unknown }).value;
		const page = await admin({ type: "block_action", action_id: "log_view", page: "/log", value });
		expect(find(page, "banner")).toMatchObject({
			variant: "error",
			description: "Resend rejected the request.",
		});
		expect(fieldValue(page, "Resend ID")).toBe("None");
		expect(texts(page)).not.toContain("resend.com/emails");
	});

	it("goes back to the list with the filters, and reports an unknown email", async () => {
		const { admin } = await seeded();
		const back = await admin({
			type: "block_action",
			action_id: "log_back",
			page: "/log",
			value: { f: { status: "failed" } },
		});
		expect(rows(back)).toHaveLength(1);
		const missing = await admin({
			type: "block_action",
			action_id: "log_view",
			page: "/log",
			value: { id: "nope" },
		});
		expect(missing.toast).toEqual({ type: "error", message: "The log has no such email." });
		expect(rows(missing)).toHaveLength(25);
		expect(
			rows(await admin({ type: "block_action", action_id: "log_back", page: "/log" })),
		).toHaveLength(25);
	});

	it("says when the log is off and when the webhook is not set up", async () => {
		const { admin } = setup({ from: "site@mail.example.com", logging: false }, [], {
			RESEND_API_KEY: TEST_KEY,
		});
		const page = await admin({ type: "page_load", page: "/log" });
		expect(texts(page)).toContain("The delivery log is off.");
		expect(texts(page)).toContain("Add the Resend webhook");
	});
});

describe("suppression page", () => {
	it("lists the addresses and says when suppression is off", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com", suppression: false });
		await addSuppression(
			fake.ctx,
			"full",
			{ address: "bounce@example.com", reason: "bounced", detail: "No mailbox" },
			NOW,
		);
		const page = await admin({ type: "page_load", page: "/suppressions" });
		expect(texts(page)).toContain("Suppression is off.");
		const rows = find(page, "table", "suppressions")?.rows as Array<Record<string, unknown>>;
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			address: "bounce@example.com",
			reason: "bounced",
			detail: "No mailbox",
		});
		expect(rows[0]?.remove).toMatchObject({
			type: "button",
			action_id: "suppression_remove",
			style: "danger",
		});
	});

	it("adds an address by hand and rejects invalid input and repeats", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com", suppression: true });
		const add = (address: string) =>
			admin({
				type: "form_submit",
				action_id: "suppression_add",
				page: "/suppressions",
				values: { address },
			});
		expect((await add("blocked@example.com")).toast).toEqual({
			type: "success",
			message: "Address added.",
		});
		expect(await findSuppression(fake.ctx, "blocked@example.com")).toMatchObject({
			reason: "manual",
		});
		expect((await add("Blocked@example.com")).toast?.type).toBe("info");
		expect((await add("nope")).toast).toEqual({
			type: "error",
			message: "Enter a valid email address.",
		});
		expect(texts(await admin({ type: "page_load", page: "/suppressions" }))).not.toContain(
			"Suppression is off.",
		);
	});

	it("removes an address", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com", suppression: true });
		await addSuppression(fake.ctx, "full", { address: "bounce@example.com", reason: "bounced" });
		const [id] = [...fake.suppressions.docs.keys()];
		const page = await admin({
			type: "block_action",
			action_id: "suppression_remove",
			page: "/suppressions",
			value: id,
		});
		expect(page.toast).toEqual({ type: "success", message: "Address removed." });
		expect(fake.suppressions.docs.size).toBe(0);
		const again = await admin({
			type: "block_action",
			action_id: "suppression_remove",
			page: "/suppressions",
			value: id,
		});
		expect(again.toast?.type).toBe("error");
		expect(
			(
				await admin({
					type: "block_action",
					action_id: "suppression_remove",
					page: "/suppressions",
					value: { id },
				})
			).toast?.type,
		).toBe("error");
	});

	it("pages through a long list", async () => {
		const { admin, fake } = setup({ from: "site@mail.example.com", suppression: true });
		for (let index = 0; index < 55; index += 1) {
			await addSuppression(
				fake.ctx,
				"full",
				{ address: `p${index}@example.com`, reason: "bounced" },
				NOW + index,
			);
		}
		const first = await admin({ type: "page_load", page: "/suppressions" });
		const table = find(first, "table", "suppressions")!;
		expect(table.rows).toHaveLength(50);
		const next = await admin({
			type: "block_action",
			action_id: "suppressions_page",
			page: "/suppressions",
			value: { cursor: table.next_cursor },
		});
		expect(find(next, "table", "suppressions")?.rows).toHaveLength(5);
		const reset = await admin({
			type: "block_action",
			action_id: "suppressions_page",
			page: "/suppressions",
			value: null,
		});
		expect(find(reset, "table", "suppressions")?.rows).toHaveLength(50);
	});
});

describe("dashboard widget", () => {
	it("shows the counts of the last 7 and 30 days", async () => {
		const { admin, fake } = setup();
		const send = (id: string, daysAgo: number) =>
			recordSend(
				fake.ctx,
				"full",
				true,
				{ to: "a@example.com", subject: "S", source: "system", resendId: id, status: "sent" },
				NOW - daysAgo * 86_400_000,
			);
		await send("re-1", 0);
		await send("re-2", 3);
		await send("re-3", 20);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			{
				type: "email.delivered",
				created_at: new Date(NOW).toISOString(),
				data: { email_id: "re-1" },
			},
			"m1",
		);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			{
				type: "email.bounced",
				created_at: new Date(NOW).toISOString(),
				data: { email_id: "re-2" },
			},
			"m2",
		);
		await applyWebhookEvent(
			fake.ctx,
			"full",
			{
				type: "email.complained",
				created_at: new Date(NOW - 20 * 86_400_000).toISOString(),
				data: { email_id: "re-3" },
			},
			"m3",
		);
		const widget = await admin({ type: "page_load", page: "widget:delivery-stats" });
		const stats = widget.blocks.filter((block) => block.type === "stats");
		expect(stats[0]?.items).toEqual([
			{ label: "Sent", value: 2 },
			{ label: "Delivered", value: 1 },
			{ label: "Bounced", value: 1 },
			{ label: "Complained", value: 0 },
		]);
		expect(stats[1]?.items).toEqual([
			{ label: "Sent", value: 3 },
			{ label: "Delivered", value: 1 },
			{ label: "Bounced", value: 1 },
			{ label: "Complained", value: 1 },
		]);
		expect(widget.blocks.map((block) => block.text).filter(Boolean)).toEqual([
			"Last 7 days",
			"Last 30 days",
		]);
	});

	it("says when the key or the webhook is missing", async () => {
		const noKey = setup({}, [], {});
		expect(
			texts(await noKey.admin({ type: "page_load", page: "widget:delivery-stats" })),
		).toContain("The Resend API key is missing.");
		const noHook = setup({}, [], { RESEND_API_KEY: TEST_KEY });
		expect(
			texts(await noHook.admin({ type: "page_load", page: "widget:delivery-stats" })),
		).toContain("Add the Resend webhook");
	});
});

describe("unknown actions", () => {
	it("renders the page of the interaction again", async () => {
		const { admin } = setup();
		const action = (page: string) => admin({ type: "block_action", action_id: "unknown", page });
		expect(texts(await action("/log"))).toContain("Email log");
		expect(texts(await action("/suppressions"))).toContain("Suppression list");
		expect(
			(await action("widget:delivery-stats")).blocks.some((block) => block.type === "stats"),
		).toBe(true);
		expect(texts(await action("/settings"))).toContain("Test email");
		expect(texts(await admin({ type: "page_load", page: "/other" }))).toContain("Test email");
	});
});

describe("absoluteUrl", () => {
	it("uses the site URL, and the request origin as the fallback", () => {
		const fake = fakeContext();
		const withSite = routeContext(fake, null);
		expect(absoluteUrl(withSite, "/a")).toBe("https://site.example/a");
		const withoutSite = { ...withSite, url: (path: string) => path } as typeof withSite;
		expect(absoluteUrl(withoutSite, "/a")).toBe("https://site.example/a");
		const broken = { ...withoutSite, request: { url: "not a url" } } as unknown as typeof withSite;
		expect(absoluteUrl(broken, "/a")).toBe("/a");
	});
});
