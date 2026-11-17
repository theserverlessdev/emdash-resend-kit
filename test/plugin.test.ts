import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import resendKitDefault, {
	createPlugin,
	PLUGIN_ID,
	resendKit,
	VERSION,
	WEBHOOK_PATH,
} from "../src/index.js";
import { recordSend } from "../src/plugin/log.js";
import { PluginRouteError } from "../src/plugin/route-error.js";
import { envSources, fakeContext } from "./helpers/fake-context.js";

const packageJson = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as {
	name: string;
	version: string;
};

describe("descriptor", () => {
	it("has the identity of the package", () => {
		const descriptor = resendKit({ from: "Site <site@mail.example.com>" });
		expect(descriptor).toMatchObject({
			id: "emdash-resend-kit",
			version: packageJson.version,
			entrypoint: packageJson.name,
			format: "native",
			displayName: "Resend",
			capabilities: ["hooks.email-transport:register", "network:request"],
			allowedHosts: ["api.resend.com"],
			options: { from: "Site <site@mail.example.com>" },
		});
		expect(VERSION).toBe(packageJson.version);
		expect(PLUGIN_ID).toBe("emdash-resend-kit");
		expect(WEBHOOK_PATH).toBe("/_emdash/api/plugins/emdash-resend-kit/webhook");
		expect(resendKitDefault).toBe(resendKit);
	});

	it("declares the admin pages, the widget, and the storage", () => {
		const descriptor = resendKit();
		expect(descriptor.adminPages?.map((page) => page.path)).toEqual([
			"/settings",
			"/log",
			"/suppressions",
		]);
		expect(descriptor.adminWidgets).toEqual([
			{ id: "delivery-stats", title: "Email delivery", size: "half" },
		]);
		expect(Object.keys(descriptor.storage ?? {})).toEqual(["emails", "suppressions", "stats"]);
		expect(descriptor.adminEntry).toBeUndefined();
	});

	it("adds the host of a custom base URL to the allowed hosts", () => {
		expect(resendKit({ baseUrl: "https://proxy.example.com/resend" }).allowedHosts).toEqual([
			"api.resend.com",
			"proxy.example.com",
		]);
		expect(createPlugin({ baseUrl: "https://proxy.example.com/resend" }).allowedHosts).toEqual([
			"api.resend.com",
			"proxy.example.com",
		]);
	});

	it("serialises to JSON without a secret, because EmDash writes the options into the bundle", () => {
		process.env.RESEND_API_KEY = "re_sentinel_do_not_bundle";
		try {
			const json = JSON.stringify(
				resendKit({ from: "site@mail.example.com", apiKeyEnv: "RESEND_API_KEY" }),
			);
			expect(json).not.toContain("re_sentinel_do_not_bundle");
			expect(json).toContain('"apiKeyEnv":"RESEND_API_KEY"');
		} finally {
			delete process.env.RESEND_API_KEY;
		}
	});

	it("rejects a secret in the options", () => {
		expect(() => resendKit({ apiKey: "re_123" } as never)).toThrow(/Do not put a secret/);
		expect(() => createPlugin({ webhookSecret: "whsec_123" } as never)).toThrow(
			/Do not put a secret/,
		);
	});
});

describe("plugin definition", () => {
	it("registers the hooks, the routes, and the admin surface", () => {
		const plugin = createPlugin({ from: "site@mail.example.com" });
		expect(plugin.id).toBe("emdash-resend-kit");
		expect(plugin.version).toBe(packageJson.version);
		expect(Object.keys(plugin.hooks).sort()).toEqual(["cron", "email:deliver", "plugin:activate"]);
		expect(Object.keys(plugin.routes).sort()).toEqual(["admin", "webhook"]);
		expect(plugin.capabilities).toEqual(["hooks.email-transport:register", "network:request"]);
		expect(plugin.storage.emails?.indexes).toContainEqual(["status", "createdAt"]);
		expect(plugin.admin.pages).toHaveLength(3);
		expect(plugin.admin.widgets).toHaveLength(1);
		expect(plugin.admin.settingsSchema?.apiKey?.type).toBe("secret");
		expect(plugin.admin.settingsSchema?.webhookSecret?.type).toBe("secret");
		expect(Object.keys(plugin.admin.settingsSchema ?? {}).sort()).toEqual([
			"apiKey",
			"fromEmail",
			"fromName",
			"logging",
			"recipientPrivacy",
			"replyTo",
			"retentionDays",
			"suppression",
			"webhookSecret",
		]);
	});

	it("schedules the cleanup on activation, one time", async () => {
		const plugin = createPlugin();
		const fake = fakeContext();
		await plugin.hooks["plugin:activate"]!.handler({} as never, fake.ctx);
		await plugin.hooks["plugin:activate"]!.handler({} as never, fake.ctx);
		expect([...fake.cronTasks.entries()]).toEqual([["cleanup", "@daily"]]);
	});

	it("does not fail when cron is not available or fails", async () => {
		const plugin = createPlugin();
		const none = fakeContext();
		(none.ctx as { cron?: unknown }).cron = undefined;
		await expect(
			plugin.hooks["plugin:activate"]!.handler({} as never, none.ctx),
		).resolves.toBeUndefined();
		const broken = fakeContext();
		(broken.ctx.cron as { list: unknown }).list = async () => {
			throw new Error("no scheduler");
		};
		await plugin.hooks["plugin:activate"]!.handler({} as never, broken.ctx);
		expect(broken.logs.at(-1)).toMatchObject({ level: "warn", data: { reason: "no scheduler" } });
	});

	it("runs the cleanup from the cron hook with the retention setting", async () => {
		const now = Date.parse("2026-11-17T12:00:00.000Z");
		const plugin = createPlugin({ retentionDays: 10 }, { env: envSources(), now: () => now });
		const fake = fakeContext();
		const send = (id: string, daysAgo: number) =>
			recordSend(
				fake.ctx,
				"full",
				true,
				{ to: "a@example.com", subject: "S", source: "system", resendId: id, status: "sent" },
				now - daysAgo * 86_400_000,
			);
		await send("old", 11);
		await send("new", 9);
		await plugin.hooks.cron!.handler({ name: "other", scheduledAt: "" }, fake.ctx);
		expect(fake.emails.docs.size).toBe(2);
		await plugin.hooks.cron!.handler({ name: "cleanup", scheduledAt: "" }, fake.ctx);
		expect([...fake.emails.docs.keys()]).toEqual(["new"]);
		expect(fake.logs.at(-1)).toMatchObject({ level: "info", data: { deleted: 1 } });
	});
});

describe("PluginRouteError", () => {
	it("has the shape that EmDash recognises", () => {
		const error = new PluginRouteError("CODE", "Message", 401);
		expect(error).toBeInstanceOf(Error);
		expect(error.name).toBe("PluginRouteError");
		expect({ code: error.code, status: error.status, message: error.message }).toEqual({
			code: "CODE",
			status: 401,
			message: "Message",
		});
		expect(new PluginRouteError("CODE", "Message").status).toBe(400);
	});
});
