/**
 * Small encoding helpers that use Web APIs only.
 *
 * The helpers run on Cloudflare Workers and on Node without a polyfill.
 */

const encoder = new TextEncoder();

export function utf8(text: string): Uint8Array<ArrayBuffer> {
	return encoder.encode(text);
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	const chunk = 0x8000;
	for (let offset = 0; offset < bytes.length; offset += chunk) {
		binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
	}
	return btoa(binary);
}

/** Decode standard or URL-safe Base64. Throw a `TypeError` for other text. */
export function base64ToBytes(text: string): Uint8Array<ArrayBuffer> {
	const normalised = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]*$/.test(normalised) || normalised.length % 4 === 1) {
		throw new TypeError("Invalid Base64 text");
	}
	const binary = atob(normalised);
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
	return bytes;
}

export function bytesToHex(bytes: Uint8Array): string {
	let hex = "";
	for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
	return hex;
}

/** SHA-256 of a text, as lowercase hex. */
export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", utf8(text));
	return bytesToHex(new Uint8Array(digest));
}

/** Compare two byte arrays in constant time for equal lengths. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	let difference = 0;
	for (let index = 0; index < a.length; index += 1) {
		difference |= (a[index] as number) ^ (b[index] as number);
	}
	return difference === 0;
}
