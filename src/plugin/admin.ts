/**
 * Admin UI of the plugin.
 *
 * The plugin returns Block Kit, and the EmDash admin renders it. No plugin
 * code runs in the browser, so the pages always have the EmDash look.
 */

import type { PluginContext, RouteContext } from "emdash";

import type { ResendDomain } from "../client.js";
import { isResendError, redactSecrets } from "../errors.js";
import { describeSecretSource, type EnvSources } from "../secrets.js";
import { isEmailAddress, resolveConfig, SETTING_KEYS } from "./config.js";
import { ALL_STATUSES, emailsCollection, queryLog, readStats, type LogFilters } from "./log.js";
import { clientForContext, sendMessage, type SendDeps } from "./send.js";
import { addSuppression, listSuppressions, removeSuppression } from "./suppression.js";
import {
	WEBHOOK_PATH,
	type EmailRecord,
	type EmailStatus,
	type RecipientPrivacy,
	type ResendKitOptions,
	type RuntimeConfig,
} from "./types.js";

export type Block = Record<string, unknown>;

export interface BlockResponse {
	blocks: Block[];
	toast?: { message: string; type: "success" | "error" | "info" };
}

interface Interaction {
	type: "page_load" | "block_action" | "form_submit";
	page: string;
	actionId: string;
	value: unknown;
	values: Record<string, unknown>;
}

export interface AdminDeps extends SendDeps {
	env?: EnvSources;
}

export const PAGES = {
	settings: "/settings",
	log: "/log",
	suppressions: "/suppressions",
	widget: "widget:delivery-stats",
} as const;

const DOMAIN_CACHE_KEY = "cache:domains";
const DOMAIN_CACHE_MS = 60_000;

const STATUS_LABELS: Record<EmailStatus, string> = {
	scheduled: "Scheduled",
	sent: "Sent",
	delivery_delayed: "Delayed",
	delivered: "Delivered",
	opened: "Opened",
	clicked: "Clicked",
	failed: "Failed",
	suppressed: "Suppressed",
	canceled: "Canceled",
	bounced: "Bounced",
	complained: "Complained",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** Narrow the unknown route input to an interaction. */
export function parseInteraction(input: unknown): Interaction | null {
	if (!isRecord(input)) return null;
	const type = input.type;
	if (type !== "page_load" && type !== "block_action" && type !== "form_submit") return null;
	return {
		type,
		page: text(input.page),
		actionId: text(input.action_id),
		value: input.value,
		values: isRecord(input.values) ? input.values : {},
	};
}

function header(value: string): Block {
	return { type: "header", text: value };
}

function context(value: string): Block {
	return { type: "context", text: value };
}

function banner(
	variant: "default" | "alert" | "error",
	title: string,
	description?: string,
): Block {
	return { type: "banner", variant, title, ...(description ? { description } : {}) };
}

function formatTime(iso: string): string {
	const time = Date.parse(iso);
	if (Number.isNaN(time)) return iso;
	return `${new Date(time).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

/**
 * Build an absolute URL of the site.
 *
 * EmDash gives a relative path when the site URL is not known. The origin of
 * the current request is the fallback.
 */
export function absoluteUrl(routeCtx: RouteContext, path: string): string {
	const fromSite = routeCtx.url(path);
	if (/^https?:\/\//i.test(fromSite)) return fromSite;
	try {
		return new URL(path, routeCtx.request.url).href;
	} catch {
		return fromSite;
	}
}

function errorText(error: unknown, secrets: ReadonlyArray<string | undefined>): string {
	const message = error instanceof Error ? error.message : String(error);
	return redactSecrets(message, secrets);
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

interface DomainReport {
	checkedAt: string;
	domains: ResendDomain[];
	senderDomain: ResendDomain | null;
	error: string | null;
}

function senderDomainName(from: string | null): string | null {
	if (!from) return null;
	const address = /<([^<>]+)>\s*$/.exec(from)?.[1] ?? from;
	const at = address.lastIndexOf("@");
	return at > 0
		? address
				.slice(at + 1)
				.trim()
				.toLowerCase()
		: null;
}

/** Read the domain status from Resend, with a cache of one minute. */
export async function loadDomainReport(
	ctx: PluginContext,
	config: RuntimeConfig,
	force: boolean,
	deps: AdminDeps = {},
): Promise<DomainReport | null> {
	if (!config.apiKey) return null;
	const now = (deps.now ?? Date.now)();
	if (!force) {
		const cached = await ctx.kv.get<DomainReport>(DOMAIN_CACHE_KEY);
		if (cached && now - Date.parse(cached.checkedAt) < DOMAIN_CACHE_MS) return cached;
	}
	const client = clientForContext(ctx, config, { timeoutMs: 5000, maxRetries: 0 }, deps);
	const report: DomainReport = {
		checkedAt: new Date(now).toISOString(),
		domains: [],
		senderDomain: null,
		error: null,
	};
	try {
		report.domains = await client.listDomains();
		const wanted = senderDomainName(config.from);
		const match = wanted ? report.domains.find((domain) => domain.name === wanted) : undefined;
		if (match) report.senderDomain = await client.getDomain(match.id);
	} catch (error) {
		report.error = isResendError(error) ? error.message : errorText(error, [config.apiKey.value]);
	}
	await ctx.kv.set(DOMAIN_CACHE_KEY, report);
	return report;
}

function domainBlocks(config: RuntimeConfig, report: DomainReport | null): Block[] {
	const blocks: Block[] = [header("Domains")];
	if (!report) {
		blocks.push(context("Add an API key to see the domain status."));
		return blocks;
	}
	if (report.error) {
		blocks.push(banner("alert", "Resend did not return the domains.", report.error));
	} else if (report.domains.length === 0) {
		blocks.push(
			banner(
				"alert",
				"No domain is set up in Resend.",
				"Add a domain in the Resend dashboard. Use a subdomain such as mail.example.com.",
			),
		);
	} else {
		const wanted = senderDomainName(config.from);
		if (wanted && !report.domains.some((domain) => domain.name === wanted)) {
			blocks.push(
				banner(
					"alert",
					`The sender domain ${wanted} is not in Resend.`,
					"Add and verify this domain in Resend, or change the sender address.",
				),
			);
		} else if (report.senderDomain && report.senderDomain.status !== "verified") {
			blocks.push(
				banner(
					"alert",
					`The sender domain ${report.senderDomain.name} is not verified.`,
					"Add the DNS records below at your DNS provider. Then verify the domain in Resend.",
				),
			);
		}
		blocks.push({
			type: "table",
			block_id: "domains",
			page_action_id: "domains_refresh",
			columns: [
				{ key: "name", label: "Domain" },
				{ key: "status", label: "Status", format: "badge" },
				{ key: "region", label: "Region" },
			],
			rows: report.domains.map((domain) => ({
				name: domain.name,
				status: domain.status,
				region: domain.region ?? "",
			})),
		});
		if (report.senderDomain?.records && report.senderDomain.records.length > 0) {
			blocks.push(context(`DNS records of ${report.senderDomain.name}`), {
				type: "table",
				block_id: "dns-records",
				page_action_id: "domains_refresh",
				columns: [
					{ key: "record", label: "Record" },
					{ key: "type", label: "Type" },
					{ key: "name", label: "Name", format: "code" },
					{ key: "status", label: "Status", format: "badge" },
				],
				rows: report.senderDomain.records.map((record) => ({
					record: record.record,
					type: record.type,
					name: record.name,
					status: record.status,
				})),
			});
		}
	}
	blocks.push(context(`Last check: ${formatTime(report.checkedAt)}`), {
		type: "actions",
		elements: [{ type: "button", action_id: "domains_refresh", label: "Check again" }],
	});
	return blocks;
}

function statusFields(config: RuntimeConfig): Block {
	return {
		type: "fields",
		fields: [
			{
				label: "API key",
				value: config.apiKey
					? `Present. ${describeSecretSource(config.apiKey.source)}.`
					: "Missing",
			},
			{ label: "Sender", value: config.from ?? "Not set" },
			{ label: "Reply-to", value: config.replyTo ?? "Not set" },
			{
				label: "Webhook signing secret",
				value: config.webhookSecret
					? `Present. ${describeSecretSource(config.webhookSecret.source)}.`
					: "Missing",
			},
			{
				label: "Delivery log",
				value: config.logging
					? `On. Records stay ${config.retentionDays} days. Recipients: ${config.recipientPrivacy}.`
					: "Off",
			},
			{ label: "Suppression", value: config.suppression ? "On" : "Off" },
		],
	};
}

interface SettingsExtras {
	notice?: Block;
	toast?: BlockResponse["toast"];
	forceDomains?: boolean;
	testRecipient?: string;
}

async function settingsPage(
	routeCtx: RouteContext,
	options: ResendKitOptions,
	deps: AdminDeps,
	extras: SettingsExtras = {},
): Promise<BlockResponse> {
	const config = await resolveConfig(routeCtx, options, deps.env);
	const report = await loadDomainReport(routeCtx, config, extras.forceDomains === true, deps);
	const settings = new Map<string, unknown>();
	try {
		for (const entry of await routeCtx.settings.list()) {
			if (entry.key !== SETTING_KEYS.apiKey && entry.key !== SETTING_KEYS.webhookSecret) {
				settings.set(entry.key, entry.value);
			}
		}
	} catch {
		// The status section reports the problem with the stored secret.
	}

	const blocks: Block[] = [header("Resend")];
	if (extras.notice) blocks.push(extras.notice);
	if (config.secretSettingError) {
		blocks.push(banner("error", "A stored secret is not readable.", config.secretSettingError));
	}
	if (!config.apiKey) {
		blocks.push(
			banner(
				"error",
				"The API key is missing.",
				"Set the RESEND_API_KEY environment variable or secret. You can also enter the key below.",
			),
		);
	}
	if (!config.from) {
		blocks.push(
			banner(
				"alert",
				"The sender address is missing.",
				"Enter a sender address below. The address must be on a domain that you verified in Resend.",
			),
		);
	}

	blocks.push(statusFields(config), {
		type: "section",
		text: "Select emdash-resend-kit as the provider in the EmDash email settings.",
		accessory: {
			type: "link",
			label: "Open email settings",
			target: { kind: "external", url: absoluteUrl(routeCtx, "/_emdash/admin/settings/email") },
		},
	});

	blocks.push({ type: "divider" }, header("Test email"), {
		type: "form",
		block_id: "test",
		fields: [
			{
				type: "text_input",
				action_id: "to",
				label: "Recipient",
				placeholder: "you@example.com",
				initial_value: extras.testRecipient ?? routeCtx.user?.email ?? "",
			},
		],
		submit: { label: "Send test email", action_id: "test_send" },
	});

	blocks.push({ type: "divider" }, ...domainBlocks(config, report));

	blocks.push(
		{ type: "divider" },
		header("Webhook"),
		context(
			"Add this URL as a webhook in the Resend dashboard. Select all email events. Then copy the signing secret to RESEND_WEBHOOK_SECRET.",
		),
		{ type: "code", language: "bash", code: absoluteUrl(routeCtx, WEBHOOK_PATH) },
		context(
			config.webhookSecret
				? "The signing secret is present. The plugin verifies each webhook."
				: "The signing secret is missing. The plugin rejects each webhook.",
		),
	);

	const privacy = text(settings.get(SETTING_KEYS.recipientPrivacy)) || config.recipientPrivacy;
	blocks.push(
		{ type: "divider" },
		header("Settings"),
		context(
			"A value here replaces the value in the site configuration. An environment variable has priority over a stored secret.",
		),
		{
			type: "form",
			block_id: "settings",
			fields: [
				{
					type: "text_input",
					action_id: SETTING_KEYS.fromEmail,
					label: "Sender address",
					placeholder: "website@mail.example.com",
					initial_value: text(settings.get(SETTING_KEYS.fromEmail)),
				},
				{
					type: "text_input",
					action_id: SETTING_KEYS.fromName,
					label: "Sender name",
					placeholder: "My website",
					initial_value: text(settings.get(SETTING_KEYS.fromName)),
				},
				{
					type: "text_input",
					action_id: SETTING_KEYS.replyTo,
					label: "Reply-to address",
					placeholder: "hello@example.com",
					initial_value: text(settings.get(SETTING_KEYS.replyTo)),
				},
				{
					type: "secret_input",
					action_id: SETTING_KEYS.apiKey,
					label: "API key",
					placeholder: "re_...",
					has_value: config.storedApiKey,
				},
				{
					type: "secret_input",
					action_id: SETTING_KEYS.webhookSecret,
					label: "Webhook signing secret",
					placeholder: "whsec_...",
					has_value: config.storedWebhookSecret,
				},
				{
					type: "toggle",
					action_id: SETTING_KEYS.logging,
					label: "Record emails in the delivery log",
					initial_value: config.logging,
				},
				{
					type: "select",
					action_id: SETTING_KEYS.recipientPrivacy,
					label: "Recipient in the log",
					options: [
						{ label: "Full address", value: "full" },
						{ label: "Masked address", value: "masked" },
						{ label: "Hash only", value: "hashed" },
					],
					initial_value: privacy,
				},
				{
					type: "number_input",
					action_id: SETTING_KEYS.retentionDays,
					label: "Days to keep log records",
					min: 1,
					max: 3650,
					initial_value: config.retentionDays,
				},
				{
					type: "toggle",
					action_id: SETTING_KEYS.suppression,
					label: "Skip addresses that bounced or complained",
					initial_value: config.suppression,
				},
			],
			submit: { label: "Save settings", action_id: "settings_save" },
		},
	);

	const removeButtons: Block[] = [];
	if (config.storedApiKey) {
		removeButtons.push({
			type: "button",
			action_id: "remove_api_key",
			label: "Remove stored API key",
			style: "danger",
			confirm: {
				title: "Remove the stored API key?",
				text: "The plugin then uses the environment variable only.",
				confirm: "Remove",
				deny: "Cancel",
				style: "danger",
			},
		});
	}
	if (config.storedWebhookSecret) {
		removeButtons.push({
			type: "button",
			action_id: "remove_webhook_secret",
			label: "Remove stored signing secret",
			style: "danger",
			confirm: {
				title: "Remove the stored signing secret?",
				text: "The plugin then uses the environment variable only.",
				confirm: "Remove",
				deny: "Cancel",
				style: "danger",
			},
		});
	}
	if (removeButtons.length > 0) blocks.push({ type: "actions", elements: removeButtons });

	return { blocks, ...(extras.toast ? { toast: extras.toast } : {}) };
}

/** Save the settings form. Return an error message, or `null`. */
export async function saveSettings(
	ctx: PluginContext,
	values: Record<string, unknown>,
): Promise<string | null> {
	const fromEmail = text(values[SETTING_KEYS.fromEmail]);
	const replyTo = text(values[SETTING_KEYS.replyTo]);
	const apiKey = text(values[SETTING_KEYS.apiKey]);
	const webhookSecret = text(values[SETTING_KEYS.webhookSecret]);
	const privacy = text(values[SETTING_KEYS.recipientPrivacy]);
	const retention = Number(values[SETTING_KEYS.retentionDays]);

	if (fromEmail && !isEmailAddress(fromEmail)) return "The sender address is not valid.";
	if (replyTo && !isEmailAddress(replyTo)) return "The reply-to address is not valid.";
	if (apiKey && !apiKey.startsWith("re_")) return "A Resend API key starts with re_.";
	if (webhookSecret && !webhookSecret.startsWith("whsec_")) {
		return "A webhook signing secret starts with whsec_.";
	}
	if (privacy && !["full", "masked", "hashed"].includes(privacy)) {
		return "The recipient privacy value is not valid.";
	}
	if (
		values[SETTING_KEYS.retentionDays] !== undefined &&
		values[SETTING_KEYS.retentionDays] !== "" &&
		(!Number.isFinite(retention) || retention < 1 || retention > 3650)
	) {
		return "The retention time must be from 1 to 3650 days.";
	}

	// Store the secrets first. An encryption problem must not leave a partial save.
	try {
		if (apiKey) await ctx.settings.set(SETTING_KEYS.apiKey, apiKey);
		if (webhookSecret) await ctx.settings.set(SETTING_KEYS.webhookSecret, webhookSecret);
	} catch {
		return "EmDash did not store the secret. Set EMDASH_ENCRYPTION_KEY, or use the RESEND_API_KEY and RESEND_WEBHOOK_SECRET environment variables.";
	}

	const setOrDelete = async (key: string, value: string) => {
		if (value) await ctx.settings.set(key, value);
		else await ctx.settings.delete(key);
	};
	await setOrDelete(SETTING_KEYS.fromEmail, fromEmail);
	await setOrDelete(SETTING_KEYS.fromName, text(values[SETTING_KEYS.fromName]));
	await setOrDelete(SETTING_KEYS.replyTo, replyTo);
	if (typeof values[SETTING_KEYS.logging] === "boolean") {
		await ctx.settings.set(SETTING_KEYS.logging, values[SETTING_KEYS.logging]);
	}
	if (privacy) await ctx.settings.set(SETTING_KEYS.recipientPrivacy, privacy as RecipientPrivacy);
	if (Number.isFinite(retention) && retention >= 1) {
		await ctx.settings.set(SETTING_KEYS.retentionDays, Math.floor(retention));
	}
	if (typeof values[SETTING_KEYS.suppression] === "boolean") {
		await ctx.settings.set(SETTING_KEYS.suppression, values[SETTING_KEYS.suppression]);
	}
	await ctx.kv.delete(DOMAIN_CACHE_KEY);
	return null;
}

async function sendTest(
	routeCtx: RouteContext,
	options: ResendKitOptions,
	deps: AdminDeps,
	values: Record<string, unknown>,
): Promise<BlockResponse> {
	const to = text(values.to);
	if (!isEmailAddress(to)) {
		return settingsPage(routeCtx, options, deps, {
			testRecipient: to,
			toast: { type: "error", message: "Enter a valid recipient address." },
		});
	}
	const config = await resolveConfig(routeCtx, options, deps.env);
	const sentAt = new Date((deps.now ?? Date.now)()).toISOString();
	try {
		const result = await sendMessage(
			routeCtx,
			// A test must always send, so each test gets its own idempotency key.
			{ ...config, idempotencyWindowSeconds: 0 },
			{
				to,
				subject: `Test email from ${routeCtx.site.name || "EmDash"}`,
				text: `This is a test email from the Resend plugin of ${routeCtx.site.name || "your EmDash site"}.\n\nResend accepted this email at ${sentAt}.`,
				source: "test",
			},
			deps,
		);
		return settingsPage(routeCtx, options, deps, {
			testRecipient: to,
			notice: banner("default", "Resend accepted the test email.", `Resend ID: ${result.id}`),
			toast: { type: "success", message: "Resend accepted the test email." },
		});
	} catch (error) {
		const message = errorText(error, [config.apiKey?.value]);
		return settingsPage(routeCtx, options, deps, {
			testRecipient: to,
			notice: banner("error", "The test email failed.", message),
			toast: { type: "error", message: "The test email failed." },
		});
	}
}

// ---------------------------------------------------------------------------
// Delivery log pages
// ---------------------------------------------------------------------------

function parseFilters(value: unknown): LogFilters {
	if (!isRecord(value)) return {};
	const filters: LogFilters = {};
	const status = text(value.status);
	if (ALL_STATUSES.includes(status as EmailStatus)) filters.status = status as EmailStatus;
	const search = text(value.search).slice(0, 200);
	if (search) filters.search = search;
	const from = text(value.from).slice(0, 10);
	if (/^\d{4}-\d{2}-\d{2}$/.test(from)) filters.from = from;
	const to = text(value.to).slice(0, 10);
	if (/^\d{4}-\d{2}-\d{2}$/.test(to)) filters.to = to;
	return filters;
}

interface LogState {
	filters: LogFilters;
	cursor?: string;
}

function parseLogState(value: unknown): LogState {
	let raw: unknown = value;
	if (isRecord(raw) && typeof raw.cursor === "string") raw = raw.cursor;
	if (typeof raw === "string") {
		try {
			raw = JSON.parse(raw);
		} catch {
			return { filters: {} };
		}
	}
	if (!isRecord(raw)) return { filters: {} };
	return {
		filters: parseFilters(raw.f),
		...(typeof raw.c === "string" ? { cursor: raw.c } : {}),
	};
}

async function logPage(
	routeCtx: RouteContext,
	options: ResendKitOptions,
	deps: AdminDeps,
	state: LogState,
): Promise<BlockResponse> {
	const config = await resolveConfig(routeCtx, options, deps.env);
	const page = await queryLog(routeCtx, state.filters, state.cursor);
	const blocks: Block[] = [header("Email log")];
	if (!config.logging) {
		blocks.push(
			banner(
				"alert",
				"The delivery log is off.",
				"Turn on the log in the Resend settings to record new emails.",
			),
		);
	}
	if (!config.webhookSecret) {
		blocks.push(
			context(
				"Add the Resend webhook to see delivered, bounced, and complained events. The Resend settings page shows the URL.",
			),
		);
	}
	const filtersActive = Object.keys(state.filters).length > 0;
	const filterForm: Block = {
		type: "form",
		block_id: "filters",
		fields: [
			{
				type: "select",
				action_id: "status",
				label: "Status",
				options: [
					{ label: "All", value: "all" },
					...ALL_STATUSES.map((status) => ({ label: STATUS_LABELS[status], value: status })),
				],
				initial_value: state.filters.status ?? "all",
			},
			{
				type: "text_input",
				action_id: "search",
				label: "Search",
				placeholder: "Recipient address or subject",
				initial_value: state.filters.search ?? "",
			},
			{
				type: "date_input",
				action_id: "from",
				label: "From",
				initial_value: state.filters.from ?? "",
			},
			{ type: "date_input", action_id: "to", label: "To", initial_value: state.filters.to ?? "" },
		],
		submit: { label: "Apply filters", action_id: "log_filter" },
	};
	blocks.push({
		type: "accordion",
		label: "Filters",
		default_open: filtersActive,
		blocks: [filterForm],
	});
	blocks.push({
		type: "table",
		block_id: "log",
		page_action_id: "log_page",
		empty_text: "No emails match.",
		columns: [
			{ key: "createdAt", label: "Time", format: "relative_time" },
			{ key: "to", label: "Recipient" },
			{ key: "subject", label: "Subject" },
			{ key: "status", label: "Status", format: "badge" },
			{ key: "source", label: "Source" },
			{ key: "view", label: "", format: "element" },
		],
		rows: page.items.map((item) => ({
			createdAt: item.data.createdAt,
			to: item.data.to,
			subject: item.data.subject,
			status: STATUS_LABELS[item.data.status] ?? item.data.status,
			source: item.data.source,
			view: {
				type: "button",
				action_id: "log_view",
				label: "View",
				value: { id: item.id, f: state.filters },
			},
		})),
		...(page.cursor ? { next_cursor: JSON.stringify({ f: state.filters, c: page.cursor }) } : {}),
	});
	if (state.cursor) {
		blocks.push({
			type: "actions",
			elements: [
				{
					type: "button",
					action_id: "log_back",
					label: "First page",
					value: { f: state.filters },
				},
			],
		});
	}
	return { blocks };
}

function detailBlocks(record: EmailRecord, filters: LogFilters): Block[] {
	const blocks: Block[] = [
		header("Email details"),
		{
			type: "fields",
			fields: [
				{ label: "Recipient", value: record.to || "Unknown" },
				{ label: "Subject", value: record.subject || "No subject" },
				{ label: "Status", value: STATUS_LABELS[record.status] ?? record.status },
				{ label: "Source", value: record.source },
				{ label: "Resend ID", value: record.resendId ?? "None" },
				{ label: "Created", value: formatTime(record.createdAt) },
				{ label: "Updated", value: formatTime(record.updatedAt) },
				{ label: "Attempts", value: String(record.attempts) },
			],
		},
	];
	if (record.error) {
		blocks.push(banner(record.status === "failed" ? "error" : "alert", "Problem", record.error));
	}
	blocks.push(header("Timeline"), {
		type: "table",
		block_id: "timeline",
		page_action_id: "log_view_noop",
		empty_text: "No events.",
		columns: [
			{ key: "at", label: "Time" },
			{ key: "type", label: "Event", format: "badge" },
			{ key: "detail", label: "Detail" },
		],
		rows: record.events.map((event) => ({
			at: formatTime(event.at),
			type: STATUS_LABELS[event.type as EmailStatus] ?? event.type,
			detail: event.detail ?? "",
		})),
	});
	const elements: Block[] = [
		{ type: "button", action_id: "log_back", label: "Back to the log", value: { f: filters } },
	];
	if (record.resendId) {
		elements.push({
			type: "link",
			label: "Open in Resend",
			target: { kind: "external", url: `https://resend.com/emails/${record.resendId}` },
		});
	}
	blocks.push({ type: "actions", elements });
	return blocks;
}

async function logDetail(
	routeCtx: RouteContext,
	options: ResendKitOptions,
	deps: AdminDeps,
	value: unknown,
): Promise<BlockResponse> {
	const id = isRecord(value) ? text(value.id) : "";
	const filters = isRecord(value) ? parseFilters(value.f) : {};
	const record = id ? await emailsCollection(routeCtx).get(id) : null;
	if (!record) {
		const page = await logPage(routeCtx, options, deps, { filters });
		return { ...page, toast: { type: "error", message: "The log has no such email." } };
	}
	return { blocks: detailBlocks(record, filters) };
}

// ---------------------------------------------------------------------------
// Suppression page
// ---------------------------------------------------------------------------

async function suppressionsPage(
	routeCtx: RouteContext,
	options: ResendKitOptions,
	deps: AdminDeps,
	cursor?: string,
	toast?: BlockResponse["toast"],
): Promise<BlockResponse> {
	const config = await resolveConfig(routeCtx, options, deps.env);
	const page = await listSuppressions(routeCtx, cursor);
	const blocks: Block[] = [header("Suppression list")];
	blocks.push(
		config.suppression
			? context(
					"The plugin does not send to an address on this list. A hard bounce or a spam complaint adds an address.",
				)
			: banner(
					"alert",
					"Suppression is off.",
					"The plugin sends to each address. Turn on suppression in the Resend settings.",
				),
	);
	blocks.push({
		type: "form",
		block_id: "suppression-add",
		fields: [
			{
				type: "text_input",
				action_id: "address",
				label: "Add an address",
				placeholder: "person@example.com",
			},
		],
		submit: { label: "Add to list", action_id: "suppression_add" },
	});
	blocks.push({
		type: "table",
		block_id: "suppressions",
		page_action_id: "suppressions_page",
		empty_text: "The list is empty.",
		columns: [
			{ key: "address", label: "Address" },
			{ key: "reason", label: "Reason", format: "badge" },
			{ key: "detail", label: "Detail" },
			{ key: "createdAt", label: "Added", format: "relative_time" },
			{ key: "remove", label: "", format: "element" },
		],
		rows: page.items.map((item) => ({
			address: item.data.address,
			reason: item.data.reason,
			detail: item.data.detail ?? "",
			createdAt: item.data.createdAt,
			remove: {
				type: "button",
				action_id: "suppression_remove",
				label: "Remove",
				style: "danger",
				value: item.id,
				confirm: {
					title: "Remove this address?",
					text: "The plugin then sends to this address again.",
					confirm: "Remove",
					deny: "Cancel",
				},
			},
		})),
		...(page.cursor ? { next_cursor: page.cursor } : {}),
	});
	return { blocks, ...(toast ? { toast } : {}) };
}

// ---------------------------------------------------------------------------
// Dashboard widget
// ---------------------------------------------------------------------------

async function statsWidget(
	routeCtx: RouteContext,
	options: ResendKitOptions,
	deps: AdminDeps,
): Promise<BlockResponse> {
	const now = (deps.now ?? Date.now)();
	const [week, month, config] = await Promise.all([
		readStats(routeCtx, 7, now),
		readStats(routeCtx, 30, now),
		resolveConfig(routeCtx, options, deps.env),
	]);
	const items = (totals: typeof week.totals) => [
		{ label: "Sent", value: totals.sent },
		{ label: "Delivered", value: totals.delivered },
		{ label: "Bounced", value: totals.bounced },
		{ label: "Complained", value: totals.complained },
	];
	const blocks: Block[] = [
		context("Last 7 days"),
		{ type: "stats", items: items(week.totals) },
		context("Last 30 days"),
		{ type: "stats", items: items(month.totals) },
	];
	if (!config.apiKey) {
		blocks.unshift(banner("error", "The Resend API key is missing."));
	} else if (!config.webhookSecret) {
		blocks.push(
			context("Add the Resend webhook to count delivered, bounced, and complained emails."),
		);
	}
	return { blocks };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/** Build the handler of the private `admin` route. */
export function createAdminHandler(
	options: ResendKitOptions,
	deps: AdminDeps = {},
): (routeCtx: RouteContext) => Promise<BlockResponse> {
	return async (routeCtx) => {
		const interaction = parseInteraction(routeCtx.input);
		if (!interaction) return { blocks: [] };
		const { type, page, actionId, value, values } = interaction;

		if (type === "page_load") {
			if (page === PAGES.widget) return statsWidget(routeCtx, options, deps);
			if (page === PAGES.log) return logPage(routeCtx, options, deps, { filters: {} });
			if (page === PAGES.suppressions) return suppressionsPage(routeCtx, options, deps);
			return settingsPage(routeCtx, options, deps);
		}

		switch (actionId) {
			case "settings_save": {
				const problem = await saveSettings(routeCtx, values);
				return settingsPage(routeCtx, options, deps, {
					toast: problem
						? { type: "error", message: problem }
						: { type: "success", message: "Settings saved." },
				});
			}
			case "test_send":
				return sendTest(routeCtx, options, deps, values);
			case "domains_refresh":
				return settingsPage(routeCtx, options, deps, { forceDomains: true });
			case "remove_api_key":
				await routeCtx.settings.delete(SETTING_KEYS.apiKey);
				await routeCtx.kv.delete(DOMAIN_CACHE_KEY);
				return settingsPage(routeCtx, options, deps, {
					toast: { type: "success", message: "Stored API key removed." },
				});
			case "remove_webhook_secret":
				await routeCtx.settings.delete(SETTING_KEYS.webhookSecret);
				return settingsPage(routeCtx, options, deps, {
					toast: { type: "success", message: "Stored signing secret removed." },
				});
			case "log_filter":
				return logPage(routeCtx, options, deps, { filters: parseFilters(values) });
			case "log_page":
				return logPage(routeCtx, options, deps, parseLogState(value));
			case "log_back":
				return logPage(routeCtx, options, deps, {
					filters: isRecord(value) ? parseFilters(value.f) : {},
				});
			case "log_view":
				return logDetail(routeCtx, options, deps, value);
			case "suppression_add": {
				const address = text(values.address);
				if (!isEmailAddress(address)) {
					return suppressionsPage(routeCtx, options, deps, undefined, {
						type: "error",
						message: "Enter a valid email address.",
					});
				}
				const config = await resolveConfig(routeCtx, options, deps.env);
				const added = await addSuppression(routeCtx, config.recipientPrivacy, {
					address,
					reason: "manual",
					detail: "Added in the admin.",
				});
				return suppressionsPage(routeCtx, options, deps, undefined, {
					type: added ? "success" : "info",
					message: added ? "Address added." : "The address is on the list already.",
				});
			}
			case "suppression_remove": {
				const removed = typeof value === "string" && (await removeSuppression(routeCtx, value));
				return suppressionsPage(routeCtx, options, deps, undefined, {
					type: removed ? "success" : "error",
					message: removed ? "Address removed." : "The list has no such address.",
				});
			}
			case "suppressions_page":
				return suppressionsPage(
					routeCtx,
					options,
					deps,
					isRecord(value) && typeof value.cursor === "string" ? value.cursor : undefined,
				);
			default:
				if (page === PAGES.log) return logPage(routeCtx, options, deps, { filters: {} });
				if (page === PAGES.suppressions) return suppressionsPage(routeCtx, options, deps);
				if (page === PAGES.widget) return statsWidget(routeCtx, options, deps);
				return settingsPage(routeCtx, options, deps);
		}
	};
}
