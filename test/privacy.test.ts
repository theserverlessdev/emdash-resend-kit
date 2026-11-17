import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
	base64ToBytes,
	bytesToBase64,
	bytesToHex,
	sha256Hex,
	timingSafeEqual,
	utf8,
} from "../src/encoding.js";
import { messageIdempotencyKey } from "../src/plugin/idempotency.js";
import {
	addressHash,
	displayAddress,
	maskAddress,
	normaliseAddress,
	shortAddressHash,
} from "../src/plugin/privacy.js";

describe("encoding", () => {
	it("converts bytes to Base64 and back, also for large input", () => {
		const bytes = new Uint8Array(100_000).map((_, index) => index % 251);
		const encoded = bytesToBase64(bytes);
		expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
		expect(Buffer.from(base64ToBytes(encoded))).toEqual(Buffer.from(bytes));
	});

	it("decodes URL-safe Base64 and rejects other text", () => {
		expect(Buffer.from(base64ToBytes("-_-_")).toString("base64")).toBe("+/+/");
		expect(() => base64ToBytes("not base64!")).toThrow(TypeError);
		expect(() => base64ToBytes("abcde")).toThrow(TypeError);
	});

	it("computes SHA-256 as hex", async () => {
		expect(await sha256Hex("hello")).toBe(createHash("sha256").update("hello").digest("hex"));
		expect(bytesToHex(new Uint8Array([0, 15, 255]))).toBe("000fff");
	});

	it("compares bytes", () => {
		expect(timingSafeEqual(utf8("abc"), utf8("abc"))).toBe(true);
		expect(timingSafeEqual(utf8("abc"), utf8("abd"))).toBe(false);
		expect(timingSafeEqual(utf8("abc"), utf8("abcd"))).toBe(false);
		expect(timingSafeEqual(utf8(""), utf8(""))).toBe(true);
	});
});

describe("privacy", () => {
	it("normalises an address", () => {
		expect(normaliseAddress("  Person@Example.COM ")).toBe("person@example.com");
		expect(normaliseAddress("Person <Person@Example.com>")).toBe("person@example.com");
	});

	it("masks an address", () => {
		expect(maskAddress("person@example.com")).toBe("p***@example.com");
		expect(maskAddress("Name <Person@Example.com>")).toBe("p***@example.com");
		expect(maskAddress("no-at-sign")).toBe("***");
		expect(maskAddress("@example.com")).toBe("***");
	});

	it("hashes an address without regard to case and spaces", async () => {
		const expected = createHash("sha256").update("person@example.com").digest("hex");
		expect(await addressHash(" Person@Example.com ")).toBe(expected);
		expect(await shortAddressHash("person@example.com")).toBe(expected.slice(0, 32));
	});

	it("returns the display form for each privacy setting", async () => {
		expect(await displayAddress("Person@Example.com", "full")).toBe("person@example.com");
		expect(await displayAddress("Person@Example.com", "masked")).toBe("p***@example.com");
		const hashed = await displayAddress("Person@Example.com", "hashed");
		expect(hashed).toMatch(/^sha256:[0-9a-f]{16}$/);
		expect(hashed).not.toContain("person");
	});
});

describe("messageIdempotencyKey", () => {
	const message = {
		from: "Site <site@mail.example.com>",
		to: "person@example.com",
		subject: "Hello",
		text: "Body",
		source: "system",
	};
	const now = Date.parse("2026-11-17T12:00:30.000Z");

	it("is stable for the same message in the same window", async () => {
		const first = await messageIdempotencyKey(message, 60, now);
		const second = await messageIdempotencyKey(
			{ ...message, to: " Person@Example.com " },
			60,
			now + 20_000,
		);
		expect(first).toMatch(/^emdash\/\d+\/[0-9a-f]{64}$/);
		expect(second).toBe(first);
		expect(first.length).toBeLessThanOrEqual(256);
	});

	it("changes in the next window", async () => {
		const first = await messageIdempotencyKey(message, 60, now);
		expect(await messageIdempotencyKey(message, 60, now + 60_000)).not.toBe(first);
	});

	it.each([
		["to", { to: "other@example.com" }],
		["subject", { subject: "Other" }],
		["text", { text: "Other body" }],
		["html", { html: "<p>Body</p>" }],
		["from", { from: "other@mail.example.com" }],
		["cc", { cc: ["cc@example.com"] }],
		["replyTo", { replyTo: "reply@example.com" }],
		["source", { source: "forms" }],
	])("changes when %s changes", async (_field, change) => {
		const first = await messageIdempotencyKey(message, 60, now);
		expect(await messageIdempotencyKey({ ...message, ...change }, 60, now)).not.toBe(first);
	});

	it("does not depend on the order of cc", async () => {
		expect(await messageIdempotencyKey({ ...message, cc: ["a@x.co", "b@x.co"] }, 60, now)).toBe(
			await messageIdempotencyKey({ ...message, cc: ["B@x.co", "a@x.co"] }, 60, now),
		);
	});

	it("gives a random key when the window is 0", async () => {
		const first = await messageIdempotencyKey(message, 0, now);
		const second = await messageIdempotencyKey(message, 0, now);
		expect(first).toMatch(/^emdash\/[0-9a-f-]{36}$/);
		expect(second).not.toBe(first);
	});

	it("uses the current time by default", async () => {
		expect(await messageIdempotencyKey(message, 3600)).toMatch(/^emdash\/\d+\//);
	});
});
