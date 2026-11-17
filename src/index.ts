/**
 * emdash-resend-kit: Resend integration for EmDash CMS.
 *
 * The plugin registers the exclusive `email:deliver` hook. EmDash then sends
 * each email (invites, magic links, comment notices, form notifications)
 * through Resend.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { defineConfig } from "astro/config";
 * import emdash from "emdash/astro";
 * import { resendKit } from "emdash-resend-kit";
 *
 * export default defineConfig({
 *   integrations: [
 *     emdash({
 *       plugins: [resendKit({ from: "Website <website@mail.example.com>" })],
 *     }),
 *   ],
 * });
 * ```
 */

import { definePlugin } from "emdash";
import type {
	PluginContext,
	PluginDescriptor,
	ResolvedPlugin,
	SettingField,
} from "emdash";

import { createAdminHandler, type AdminDeps } from "./plugin/admin.js";
import { apiHost, resolveConfig, validateOptions } from "./plugin/config.js";
import { cleanupLog } from "./plugin/log.js";
import { HOOK_TIMEOUT_MS, sendMessage } from "./plugin/send.js";
import { PLUGIN_ID, STORAGE_CONFIG, type ResendKitOptions } from "./plugin/types.js";
import { createWebhookHandler } from "./plugin/webhook-route.js";
import { VERSION } from "./version.js";

export type { ResendKitOptions, RecipientPrivacy, EmailStatus } from "./plugin/types.js";
export { PLUGIN_ID, WEBHOOK_PATH } from "./plugin/types.js";
export { VERSION } from "./version.js";

const DISPLAY_NAME = "Resend";
const DESCRIPTION =
	"Send EmDash email through Resend. Includes a delivery log, webhooks, and a suppression list.";
const CAPABILITIES = ["hooks.email-transport:register", "network:request"] as const;
const CLEANUP_TASK = "cleanup";

const ADMIN_PAGES = [
	{ path: "/settings", label: "Resend", icon: "envelope-simple", group: "Resend" },
	{ path: "/log", label: "Email log", icon: "list", group: "Resend" },
	{ path: "/suppressions", label: "Suppressions", icon: "prohibit", group: "Resend" },
];
const ADMIN_WIDGETS = [{ id: "delivery-stats", title: "Email delivery", size: "half" as const }];

const SETTINGS_SCHEMA: Record<string, SettingField> = {
	fromEmail: {
		type: "email",
		label: "Sender address",
		description: "The address must be on a domain that you verified in Resend.",
		placeholder: "website@mail.example.com",
	},
	fromName: { type: "string", label: "Sender name" },
	replyTo: { type: "email", label: "Reply-to address" },
	apiKey: {
		type: "secret",
		label: "API key",
		description: "The RESEND_API_KEY environment variable has priority over this value.",
	},
	webhookSecret: {
		type: "secret",
		label: "Webhook signing secret",
		description: "The RESEND_WEBHOOK_SECRET environment variable has priority over this value.",
	},
	logging: { type: "boolean", label: "Record emails in the delivery log", default: true },
	recipientPrivacy: {
		type: "select",
		label: "Recipient in the log",
		options: [
			{ value: "full", label: "Full address" },
			{ value: "masked", label: "Masked address" },
			{ value: "hashed", label: "Hash only" },
		],
		default: "full",
	},
	retentionDays: {
		type: "number",
		label: "Days to keep log records",
		default: 30,
		min: 1,
		max: 3650,
	},
	suppression: {
		type: "boolean",
		label: "Skip addresses that bounced or complained",
		default: false,
	},
};

function allowedHosts(options: ResendKitOptions): string[] {
	return [...new Set(["api.resend.com", apiHost(options.baseUrl)])];
}

/**
 * Create the plugin descriptor for the `plugins` list of the EmDash
 * integration.
 *
 * The options never contain a secret. Set `RESEND_API_KEY` in the runtime
 * environment.
 */
export function resendKit(options: ResendKitOptions = {}): PluginDescriptor<ResendKitOptions> {
	const validated = validateOptions(options);
	return {
		id: PLUGIN_ID,
		displayName: DISPLAY_NAME,
		description: DESCRIPTION,
		version: VERSION,
		entrypoint: "emdash-resend-kit",
		format: "native",
		options: validated,
		capabilities: [...CAPABILITIES],
		allowedHosts: allowedHosts(validated),
		// A descriptor accepts single-field indexes only. The composite index
		// is in the plugin definition.
		storage: {
			emails: { indexes: ["status", "createdAt", "toHash"] },
			suppressions: { indexes: ["createdAt", "reason"] },
			stats: { indexes: ["date"] },
		},
		adminPages: ADMIN_PAGES,
		adminWidgets: ADMIN_WIDGETS,
	};
}

/** Schedule the daily cleanup when the task does not exist. */
async function ensureCleanupTask(ctx: PluginContext): Promise<void> {
	if (!ctx.cron) return;
	try {
		const tasks = await ctx.cron.list();
		if (!tasks.some((task) => task.name === CLEANUP_TASK)) {
			await ctx.cron.schedule(CLEANUP_TASK, { schedule: "@daily" });
		}
	} catch (error) {
		ctx.log.warn("The plugin did not schedule the log cleanup.", {
			reason: error instanceof Error ? error.message : String(error),
		});
	}
}

/**
 * Create the plugin. EmDash calls this function at runtime with the options
 * of the descriptor.
 *
 * @param deps Overrides for tests.
 */
export function createPlugin(options: ResendKitOptions = {}, deps: AdminDeps = {}): ResolvedPlugin {
	const validated = validateOptions(options);
	const adminHandler = createAdminHandler(validated, deps);

	return definePlugin({
		id: PLUGIN_ID,
		displayName: DISPLAY_NAME,
		description: DESCRIPTION,
		version: VERSION,
		capabilities: [...CAPABILITIES],
		allowedHosts: allowedHosts(validated),
		storage: STORAGE_CONFIG,

		hooks: {
			"plugin:activate": {
				handler: async (_event, ctx) => {
					await ensureCleanupTask(ctx);
				},
			},

			"email:deliver": {
				exclusive: true,
				// The default hook timeout is 5 seconds. A send with retries can
				// need more time.
				timeout: HOOK_TIMEOUT_MS,
				handler: async (event, ctx) => {
					const config = await resolveConfig(ctx, validated, deps.env);
					const { message, source } = event;
					await sendMessage(
						ctx,
						config,
						{
							to: message.to,
							cc: message.cc,
							replyTo: message.replyTo,
							subject: message.subject,
							text: message.text,
							html: message.html,
							source,
						},
						deps,
					);
				},
			},

			cron: {
				timeout: 60_000,
				handler: async (event, ctx) => {
					if (event.name !== CLEANUP_TASK) return;
					const config = await resolveConfig(ctx, validated, deps.env);
					const deleted = await cleanupLog(ctx, config.retentionDays, deps.now?.());
					ctx.log.info("The log cleanup is complete.", { deleted });
				},
			},
		},

		routes: {
			webhook: {
				public: true,
				methods: ["POST"],
				request: {
					body: "text",
					maxBytes: 262_144,
					headers: ["svix-id", "svix-timestamp", "svix-signature"],
				},
				handler: createWebhookHandler(validated, deps),
			},

			admin: {
				methods: ["POST"],
				handler: async (routeCtx) => {
					// The task also starts here, because a plugin from the site
					// configuration does not always get an activate event.
					await ensureCleanupTask(routeCtx);
					return adminHandler(routeCtx);
				},
			},
		},

		admin: {
			settingsSchema: SETTINGS_SCHEMA,
			pages: ADMIN_PAGES,
			widgets: ADMIN_WIDGETS,
		},
	});
}

export default resendKit;
