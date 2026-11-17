/**
 * Local suppression list.
 *
 * The record ID is the SHA-256 hash of the address. For that reason a lookup
 * works with each privacy setting, and the list can hide the address.
 */

import type { PluginContext, StorageCollection } from "emdash";

import type { ResendWebhookEvent } from "../webhook.js";
import { addressHash, displayAddress } from "./privacy.js";
import type { RecipientPrivacy, SuppressionRecord } from "./types.js";

export function suppressionsCollection(ctx: PluginContext): StorageCollection<SuppressionRecord> {
	return ctx.storage.suppressions as StorageCollection<SuppressionRecord>;
}

/** Return the suppression record of an address, or `null`. */
export async function findSuppression(
	ctx: PluginContext,
	address: string,
): Promise<SuppressionRecord | null> {
	return suppressionsCollection(ctx).get(await addressHash(address));
}

export interface AddSuppressionInput {
	address: string;
	reason: SuppressionRecord["reason"];
	emailId?: string | null;
	detail?: string | null;
}

/**
 * Add an address to the list. The first entry of an address stays.
 *
 * @returns `true` when the function added a new entry.
 */
export async function addSuppression(
	ctx: PluginContext,
	privacy: RecipientPrivacy,
	input: AddSuppressionInput,
	now = Date.now(),
): Promise<boolean> {
	const id = await addressHash(input.address);
	const record: SuppressionRecord = {
		address: await displayAddress(input.address, privacy),
		reason: input.reason,
		emailId: input.emailId ?? null,
		detail: input.detail ? input.detail.slice(0, 300) : null,
		createdAt: new Date(now).toISOString(),
	};
	const result = await suppressionsCollection(ctx).compareAndSet(id, null, record);
	return result.applied;
}

/** Remove one entry by its record ID. */
export function removeSuppression(ctx: PluginContext, id: string): Promise<boolean> {
	return suppressionsCollection(ctx).delete(id);
}

export async function listSuppressions(
	ctx: PluginContext,
	cursor?: string,
	limit = 50,
): Promise<{ items: Array<{ id: string; data: SuppressionRecord }>; cursor?: string }> {
	const result = await suppressionsCollection(ctx).query({
		orderBy: { createdAt: "desc" },
		limit,
		cursor,
	});
	return { items: result.items, cursor: result.hasMore ? result.cursor : undefined };
}

/**
 * Decide if a webhook event must add its recipients to the list.
 *
 * A permanent bounce and a spam complaint add an entry. A temporary bounce
 * does not.
 */
export function suppressionFromEvent(
	event: ResendWebhookEvent,
): { reason: "bounced" | "complained"; addresses: string[]; detail: string | null } | null {
	const addresses = Array.isArray(event.data.to)
		? event.data.to.filter((item): item is string => typeof item === "string" && item.includes("@"))
		: typeof event.data.to === "string"
			? [event.data.to]
			: [];
	// An event does not say which recipient of an email caused it. Act only on
	// an email with one recipient. EmDash sends each email to one recipient.
	if (addresses.length !== 1) return null;
	if (event.type === "email.complained") {
		return { reason: "complained", addresses, detail: "The recipient marked the email as spam." };
	}
	if (event.type === "email.bounced") {
		const bounce = event.data.bounce as { type?: unknown; message?: unknown } | undefined;
		const type = typeof bounce?.type === "string" ? bounce.type : "Permanent";
		if (type.toLowerCase() !== "permanent") return null;
		return {
			reason: "bounced",
			addresses,
			detail: typeof bounce?.message === "string" ? bounce.message : null,
		};
	}
	return null;
}
