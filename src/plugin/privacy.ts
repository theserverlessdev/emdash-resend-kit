/**
 * Privacy helpers for recipient addresses.
 */

import { sha256Hex } from "../encoding.js";
import type { RecipientPrivacy } from "./types.js";

/** Trim an address and change it to lowercase. */
export function normaliseAddress(address: string): string {
	const match = /<([^<>]+)>\s*$/.exec(address);
	return (match?.[1] ?? address).trim().toLowerCase();
}

/** Full SHA-256 hash of a normalised address. The suppression list uses it as the ID. */
export function addressHash(address: string): Promise<string> {
	return sha256Hex(normaliseAddress(address));
}

/** Short hash for the `toHash` index of the delivery log. */
export async function shortAddressHash(address: string): Promise<string> {
	return (await addressHash(address)).slice(0, 32);
}

/** Mask the local part of an address: `person@example.com` becomes `p***@example.com`. */
export function maskAddress(address: string): string {
	const normalised = normaliseAddress(address);
	const at = normalised.lastIndexOf("@");
	if (at <= 0) return "***";
	return `${normalised.slice(0, 1)}***${normalised.slice(at)}`;
}

/** Return the text that the log stores for a recipient. */
export async function displayAddress(address: string, privacy: RecipientPrivacy): Promise<string> {
	if (privacy === "masked") return maskAddress(address);
	if (privacy === "hashed") return `sha256:${(await addressHash(address)).slice(0, 16)}`;
	return normaliseAddress(address);
}
