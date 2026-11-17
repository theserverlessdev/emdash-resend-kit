import { describe, expect, it } from "vitest";

import {
	addSuppression,
	findSuppression,
	listSuppressions,
	removeSuppression,
	suppressionFromEvent,
} from "../src/plugin/suppression.js";
import { fakeContext } from "./helpers/fake-context.js";

const NOW = Date.parse("2026-11-17T12:00:00.000Z");

describe("suppression list", () => {
	it("adds an address and finds it without regard to case", async () => {
		const { ctx, suppressions } = fakeContext();
		const added = await addSuppression(
			ctx,
			"full",
			{ address: "Person@Example.com", reason: "bounced", emailId: "re-1", detail: "No mailbox" },
			NOW,
		);
		expect(added).toBe(true);
		expect(await findSuppression(ctx, " person@example.com ")).toEqual({
			address: "person@example.com",
			reason: "bounced",
			emailId: "re-1",
			detail: "No mailbox",
			createdAt: "2026-11-17T12:00:00.000Z",
		});
		expect(await findSuppression(ctx, "other@example.com")).toBeNull();
		const [id] = [...suppressions.docs.keys()];
		expect(id).toMatch(/^[0-9a-f]{64}$/);
	});

	it("keeps the first entry of an address", async () => {
		const { ctx } = fakeContext();
		await addSuppression(ctx, "full", { address: "a@example.com", reason: "bounced" }, NOW);
		expect(
			await addSuppression(ctx, "full", { address: "A@example.com", reason: "complained" }, NOW),
		).toBe(false);
		expect((await findSuppression(ctx, "a@example.com"))?.reason).toBe("bounced");
	});

	it("hides the address with the masked and hashed settings, and still finds it", async () => {
		const { ctx } = fakeContext();
		await addSuppression(ctx, "masked", { address: "person@example.com", reason: "complained" });
		await addSuppression(ctx, "hashed", {
			address: "other@example.com",
			reason: "manual",
			detail: "x".repeat(400),
		});
		expect((await findSuppression(ctx, "person@example.com"))?.address).toBe("p***@example.com");
		const hashed = await findSuppression(ctx, "other@example.com");
		expect(hashed?.address).toMatch(/^sha256:/);
		expect(hashed?.detail).toHaveLength(300);
		expect(hashed?.emailId).toBeNull();
	});

	it("lists newest first, pages, and removes", async () => {
		const { ctx } = fakeContext();
		for (let index = 0; index < 5; index += 1) {
			await addSuppression(
				ctx,
				"full",
				{ address: `p${index}@example.com`, reason: "bounced" },
				NOW + index * 1000,
			);
		}
		const first = await listSuppressions(ctx, undefined, 3);
		expect(first.items.map((item) => item.data.address)).toEqual([
			"p4@example.com",
			"p3@example.com",
			"p2@example.com",
		]);
		const second = await listSuppressions(ctx, first.cursor, 3);
		expect(second.items).toHaveLength(2);
		expect(second.cursor).toBeUndefined();

		expect(await removeSuppression(ctx, first.items[0]!.id)).toBe(true);
		expect(await removeSuppression(ctx, first.items[0]!.id)).toBe(false);
		expect(await findSuppression(ctx, "p4@example.com")).toBeNull();
	});
});

describe("suppressionFromEvent", () => {
	const data = { email_id: "re-1", to: ["a@example.com", 42, "not-an-address"] };

	it("returns the recipients of a permanent bounce", () => {
		expect(
			suppressionFromEvent({
				type: "email.bounced",
				created_at: "",
				data: { ...data, bounce: { type: "Permanent", message: "No mailbox" } },
			}),
		).toEqual({
			reason: "bounced",
			addresses: ["a@example.com"],
			detail: "No mailbox",
		});
	});

	it("ignores an email with more than one recipient", () => {
		expect(
			suppressionFromEvent({
				type: "email.complained",
				created_at: "",
				data: { to: ["a@example.com", "b@example.com"] },
			}),
		).toBeNull();
	});

	it("treats a bounce without a type as permanent", () => {
		expect(suppressionFromEvent({ type: "email.bounced", created_at: "", data })?.reason).toBe(
			"bounced",
		);
	});

	it("ignores a temporary bounce", () => {
		for (const type of ["Temporary", "Transient", "Undetermined"]) {
			expect(
				suppressionFromEvent({
					type: "email.bounced",
					created_at: "",
					data: { ...data, bounce: { type } },
				}),
			).toBeNull();
		}
	});

	it("returns the recipients of a complaint", () => {
		const result = suppressionFromEvent({
			type: "email.complained",
			created_at: "",
			data: { to: "a@example.com" },
		});
		expect(result).toMatchObject({ reason: "complained", addresses: ["a@example.com"] });
	});

	it("ignores other events and events without a recipient", () => {
		expect(suppressionFromEvent({ type: "email.delivered", created_at: "", data })).toBeNull();
		expect(suppressionFromEvent({ type: "email.bounced", created_at: "", data: {} })).toBeNull();
	});
});
