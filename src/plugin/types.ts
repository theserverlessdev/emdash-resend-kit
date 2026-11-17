/**
 * Shared types and constants of the plugin runtime.
 */

import type { AddressInput } from "../client.js";
import type { ResolvedSecret } from "../secrets.js";

/** Plugin ID in EmDash. The ID is part of the route URLs. */
export const PLUGIN_ID = "emdash-resend-kit";

/** Path of the public webhook route. */
export const WEBHOOK_PATH = `/_emdash/api/plugins/${PLUGIN_ID}/webhook`;

/** How the delivery log stores a recipient address. */
export type RecipientPrivacy = "full" | "masked" | "hashed";

/**
 * Options of the plugin in `astro.config.mjs`.
 *
 * EmDash writes these options into the server bundle. For that reason the
 * options name environment variables and never contain a secret.
 */
export interface ResendKitOptions {
	/**
	 * Default sender, for example `"Website <website@mail.example.com>"`.
	 * The address must be on a domain that you verified in Resend.
	 * An administrator can replace this value in the admin settings.
	 */
	from?: AddressInput;
	/** Default reply-to address. A reply-to on the message has priority. */
	replyTo?: string;
	/** Name of the environment variable with the API key. Default: `RESEND_API_KEY`. */
	apiKeyEnv?: string;
	/**
	 * Name of the environment variable with the webhook signing secret.
	 * Default: `RESEND_WEBHOOK_SECRET`.
	 */
	webhookSecretEnv?: string;
	/** Base URL of the Resend API. Use this option for a proxy or for tests. */
	baseUrl?: string;
	/** Tags for each email, as a record of name and value. */
	tags?: Record<string, string>;
	/** Custom headers for each email. */
	headers?: Record<string, string>;
	/**
	 * Name of the tag that carries the EmDash source of the email (`system`,
	 * a plugin ID, or `admin`). Set `false` to send no such tag.
	 * Default: `emdash_source`.
	 */
	sourceTag?: string | false;
	/** Timeout of one HTTP attempt in milliseconds. Default: 10000. */
	timeoutMs?: number;
	/** Number of retries after the first attempt. Default: 2. */
	maxRetries?: number;
	/**
	 * Length of the idempotency time window in seconds. Two identical messages
	 * in the same window give one email. Set `0` to use a random key for each
	 * send. Default: 60.
	 */
	idempotencyWindowSeconds?: number;
	/** Record each send in the delivery log. Default: `true`. */
	logging?: boolean;
	/** How the delivery log stores a recipient address. Default: `"full"`. */
	recipientPrivacy?: RecipientPrivacy;
	/** Number of days that the delivery log keeps a record. Default: 30. */
	retentionDays?: number;
	/**
	 * Skip a send to an address that had a hard bounce or a spam complaint.
	 * Default: `false`.
	 */
	suppression?: boolean;
	/** Limit for the age of a webhook, in seconds. Default: 300. */
	webhookToleranceSeconds?: number;
}

/** Configuration after the merge of options, settings, and secrets. */
export interface RuntimeConfig {
	/** Formatted sender, or `null` when no sender is set. */
	from: string | null;
	replyTo: string | null;
	baseUrl: string;
	tags: Record<string, string>;
	headers: Record<string, string>;
	sourceTag: string | false;
	timeoutMs: number;
	maxRetries: number;
	idempotencyWindowSeconds: number;
	logging: boolean;
	recipientPrivacy: RecipientPrivacy;
	retentionDays: number;
	suppression: boolean;
	webhookToleranceSeconds: number;
	apiKey: ResolvedSecret | null;
	webhookSecret: ResolvedSecret | null;
	/** True when the plugin settings hold an API key. */
	storedApiKey: boolean;
	/** True when the plugin settings hold a webhook signing secret. */
	storedWebhookSecret: boolean;
	/** Set when EmDash cannot decrypt a stored secret setting. */
	secretSettingError: string | null;
}

/** Delivery status of one email in the log. */
export type EmailStatus =
	| "scheduled"
	| "sent"
	| "delivery_delayed"
	| "delivered"
	| "opened"
	| "clicked"
	| "failed"
	| "suppressed"
	| "canceled"
	| "bounced"
	| "complained";

export interface EmailEvent {
	/** Event type without the `email.` prefix, for example `delivered`. */
	type: string;
	/** Time of the event, as ISO 8601 text. */
	at: string;
	/** Webhook message ID (`svix-id`). The log uses the ID to drop a repeat. */
	id?: string;
	/** Short detail, for example the bounce reason. */
	detail?: string;
}

/** One record of the `emails` storage collection. */
export interface EmailRecord {
	/** Resend email ID, or `null` when Resend did not accept the email. */
	resendId: string | null;
	/** Recipient in the form that the privacy setting allows. */
	to: string;
	/** Short SHA-256 hash of the recipient address. Search uses this field. */
	toHash: string;
	subject: string;
	status: EmailStatus;
	/** Origin of the email: `system`, a plugin ID, `test`, or `external`. */
	source: string;
	error: string | null;
	errorCode: string | null;
	attempts: number;
	createdAt: string;
	updatedAt: string;
	events: EmailEvent[];
}

/** One record of the `suppressions` storage collection. */
export interface SuppressionRecord {
	/** Recipient in the form that the privacy setting allows. */
	address: string;
	reason: "bounced" | "complained" | "manual";
	/** Resend email ID of the event that caused the entry. */
	emailId: string | null;
	detail: string | null;
	createdAt: string;
}

/** One record of the `stats` storage collection. The ID is a UTC date. */
export interface DailyStats {
	date: string;
	sent: number;
	delivered: number;
	bounced: number;
	complained: number;
	failed: number;
	opened: number;
	clicked: number;
	suppressed: number;
}

export type StatField = Exclude<keyof DailyStats, "date">;

/** Storage declaration of the plugin. */
export const STORAGE_CONFIG = {
	emails: { indexes: ["status", "createdAt", "toHash", ["status", "createdAt"]] },
	suppressions: { indexes: ["createdAt", "reason"] },
	stats: { indexes: ["date"] },
} satisfies Record<string, { indexes: Array<string | string[]> }>;

export const DEFAULTS = {
	baseUrl: "https://api.resend.com",
	sourceTag: "emdash_source",
	timeoutMs: 10_000,
	maxRetries: 2,
	idempotencyWindowSeconds: 60,
	logging: true,
	recipientPrivacy: "full" as RecipientPrivacy,
	retentionDays: 30,
	suppression: false,
	webhookToleranceSeconds: 300,
} as const;
