/**
 * Idempotency keys for EmDash emails.
 *
 * EmDash gives a message no ID. The key is a hash of the message content and
 * a time window. A repeat of the same message in the same window gives the
 * same key, and Resend sends one email.
 */

import { sha256Hex } from "../encoding.js";

export interface IdempotencyInput {
	from: string;
	to: string;
	cc?: string[];
	replyTo?: string | null;
	subject: string;
	text: string;
	html?: string;
	source: string;
}

/**
 * Compute the idempotency key of a message.
 *
 * @param windowSeconds Length of the time window. `0` gives a random key.
 */
export async function messageIdempotencyKey(
	message: IdempotencyInput,
	windowSeconds: number,
	now = Date.now(),
): Promise<string> {
	if (windowSeconds <= 0) return `emdash/${crypto.randomUUID()}`;
	const bucket = Math.floor(now / 1000 / windowSeconds);
	const content = JSON.stringify([
		message.from,
		message.to.trim().toLowerCase(),
		(message.cc ?? []).map((address) => address.trim().toLowerCase()).sort(),
		message.replyTo ?? "",
		message.subject,
		message.text,
		message.html ?? "",
		message.source,
	]);
	return `emdash/${bucket}/${await sha256Hex(content)}`;
}
