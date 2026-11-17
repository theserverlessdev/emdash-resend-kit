/**
 * Public route that receives Resend webhooks.
 *
 * URL: `/_emdash/api/plugins/emdash-resend-kit/webhook`
 */

import type { RouteContext } from "emdash";

import type { EnvSources } from "../secrets.js";
import { extractWebhookHeaders, verifyWebhook, WebhookVerificationError } from "../webhook.js";
import { resolveConfig } from "./config.js";
import { applyWebhookEvent } from "./log.js";
import { PluginRouteError } from "./route-error.js";
import { addSuppression, suppressionFromEvent } from "./suppression.js";
import type { ResendKitOptions } from "./types.js";

export interface WebhookResult {
	received: true;
	type: string;
	outcome: "recorded" | "duplicate" | "ignored";
}

const BAD_REQUEST_CODES = new Set(["missing_headers", "invalid_timestamp", "invalid_payload"]);

/** Build the handler of the webhook route. */
export function createWebhookHandler(
	options: ResendKitOptions,
	deps: { env?: EnvSources; now?: () => number } = {},
): (routeCtx: RouteContext) => Promise<WebhookResult> {
	return async (routeCtx) => {
		const config = await resolveConfig(routeCtx, options, deps.env);
		if (!config.webhookSecret) {
			throw new PluginRouteError(
				"WEBHOOK_NOT_CONFIGURED",
				"The webhook signing secret is not set. Set RESEND_WEBHOOK_SECRET.",
				503,
			);
		}
		if (typeof routeCtx.input !== "string") {
			throw new PluginRouteError("WEBHOOK_INVALID", "The webhook has no body.", 400);
		}

		let event;
		try {
			event = await verifyWebhook({
				payload: routeCtx.input,
				headers: routeCtx.request.headers,
				secret: config.webhookSecret.value,
				toleranceSeconds: config.webhookToleranceSeconds,
				now: deps.now?.(),
			});
		} catch (error) {
			if (error instanceof WebhookVerificationError) {
				routeCtx.log.warn("The plugin rejected a webhook.", { code: error.code });
				throw new PluginRouteError(
					"WEBHOOK_SIGNATURE_INVALID",
					// Do not tell an anonymous caller that the stored secret is wrong.
					error.code === "invalid_secret"
						? "The webhook signature does not match the signing secret."
						: error.message,
					BAD_REQUEST_CODES.has(error.code) ? 400 : 401,
				);
			}
			throw error;
		}

		const webhookId = extractWebhookHeaders(routeCtx.request.headers)?.id ?? crypto.randomUUID();
		let outcome: WebhookResult["outcome"] = "ignored";
		if (config.logging) {
			outcome = (await applyWebhookEvent(routeCtx, config.recipientPrivacy, event, webhookId))
				.outcome;
		}

		if (config.suppression) {
			const suppression = suppressionFromEvent(event);
			if (suppression) {
				const emailId = typeof event.data.email_id === "string" ? event.data.email_id : null;
				for (const address of suppression.addresses) {
					await addSuppression(routeCtx, config.recipientPrivacy, {
						address,
						reason: suppression.reason,
						emailId,
						detail: suppression.detail,
					});
				}
			}
		}
		return { received: true, type: event.type, outcome };
	};
}
