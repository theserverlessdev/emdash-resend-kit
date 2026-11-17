/**
 * End-to-end integration test.
 *
 * The script packs the plugin, installs the tarball in a copy of
 * `examples/basic`, starts the EmDash site against a local mock of the Resend
 * API, and checks the full flow through HTTP.
 *
 * Usage:
 *   node scripts/integration.mjs            Run the HTTP checks.
 *   node scripts/integration.mjs --browser  Also check the admin pages in a headless browser.
 *   node scripts/integration.mjs --keep     Keep the site running for manual checks.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	readFileSync,
	readdirSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockResend } from "./mock-resend.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(root, ".integration");
const siteDir = join(workDir, "site");
const args = new Set(process.argv.slice(2));
const PLUGIN_ID = "emdash-resend-kit";

const API_KEY = `re_integration_${randomBytes(12).toString("hex")}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;
const ENCRYPTION_KEY = `emdash_enc_v1_${randomBytes(32).toString("base64url")}`;

/** @type {Array<{ name: string, ok: boolean, detail?: string }>} */
const results = [];

function check(name, ok, detail) {
	results.push({ name, ok: Boolean(ok), detail });
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}

function run(command, commandArgs, cwd) {
	execFileSync(command, commandArgs, { cwd, stdio: ["ignore", "ignore", "inherit"] });
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

async function waitFor(url, timeoutMs) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(url, { redirect: "manual" });
			if (response.status < 500) return;
		} catch {
			// The server is not up yet.
		}
		if (Date.now() > end) throw new Error(`The site did not start in ${timeoutMs} ms.`);
		await new Promise((done) => setTimeout(done, 500));
	}
}

function prepareSite() {
	console.log("Build and pack the plugin.");
	run("npm", ["run", "build", "--silent"], root);
	rmSync(workDir, { recursive: true, force: true });
	mkdirSync(workDir, { recursive: true });
	run("npm", ["pack", "--silent", "--pack-destination", workDir], root);
	const tarball = readdirSync(workDir).find((name) => name.endsWith(".tgz"));
	if (!tarball) throw new Error("npm pack did not create a tarball.");

	console.log("Copy the example site and install the tarball.");
	cpSync(join(root, "examples", "basic"), siteDir, {
		recursive: true,
		filter: (source) => !/node_modules|data\.db|\/dist$|\/\.astro$|\/uploads$/.test(source),
	});
	const packagePath = join(siteDir, "package.json");
	const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
	manifest.dependencies[PLUGIN_ID] = `file:${join(workDir, tarball)}`;
	writeFileSync(packagePath, JSON.stringify(manifest, null, "\t"));
	run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], siteDir);
	if (!existsSync(join(siteDir, "node_modules", PLUGIN_ID, "dist", "index.js"))) {
		throw new Error("The plugin is not in node_modules of the site.");
	}
}

async function main() {
	if (!args.has("--skip-install") || !existsSync(join(siteDir, "node_modules"))) prepareSite();
	for (const file of ["data.db", "data.db-shm", "data.db-wal"]) {
		rmSync(join(siteDir, file), { force: true });
	}

	const mock = await startMockResend();
	const port = await freePort();
	const origin = `http://localhost:${port}`;
	console.log(`Mock Resend API: ${mock.url}`);
	console.log(`EmDash site: ${origin}`);

	let siteLog = "";
	// Start Astro with Node directly, in its own process group. The script can
	// then stop the dev server and each child process.
	const astroBin = join(siteDir, "node_modules", "astro", "bin", "astro.mjs");
	const site = spawn(
		process.execPath,
		[astroBin, "dev", "--port", String(port), "--host", "127.0.0.1"],
		{
			cwd: siteDir,
			detached: true,
			env: {
				...process.env,
				RESEND_API_KEY: API_KEY,
				RESEND_WEBHOOK_SECRET: WEBHOOK_SECRET,
				RESEND_BASE_URL: mock.url,
				EMDASH_ENCRYPTION_KEY: ENCRYPTION_KEY,
				ASTRO_TELEMETRY_DISABLED: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		},
	);
	site.stdout.on("data", (chunk) => (siteLog += chunk));
	site.stderr.on("data", (chunk) => (siteLog += chunk));

	const stop = async () => {
		// Astro can keep the dev server as a background process. Stop it by
		// command first, then stop the process group.
		try {
			execFileSync(process.execPath, [astroBin, "dev", "stop"], { cwd: siteDir, stdio: "ignore" });
		} catch {
			// The dev server is not a background process.
		}
		try {
			process.kill(-site.pid, "SIGTERM");
		} catch {
			site.kill("SIGTERM");
		}
		await mock.close();
	};

	try {
		await waitFor(`${origin}/`, 120_000);

		// Dev bypass: create the admin user and a token with the admin scope.
		const bypass = await fetch(`${origin}/_emdash/api/setup/dev-bypass?token=1&content=0`, {
			method: "POST",
		});
		const bypassBody = await bypass.json();
		const token = bypassBody?.data?.token;
		check(
			"dev bypass returns an admin token",
			bypass.ok && typeof token === "string",
			JSON.stringify(bypassBody).slice(0, 300),
		);

		const api = async (path, init = {}) => {
			const response = await fetch(`${origin}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/json",
					...init.headers,
				},
			});
			const textBody = await response.text();
			let json = null;
			try {
				json = JSON.parse(textBody);
			} catch {
				// Not JSON.
			}
			return { status: response.status, json, text: textBody };
		};
		const admin = (interaction) =>
			api(`/_emdash/api/plugins/${PLUGIN_ID}/admin`, {
				method: "POST",
				body: JSON.stringify(interaction),
			});
		const blocksText = (response) => JSON.stringify(response.json?.data?.blocks ?? []);

		// 1. The plugin loads.
		const plugins = await api("/_emdash/api/admin/plugins");
		const listed = JSON.stringify(plugins.json ?? {});
		check(
			"the plugin is in the plugin list of the admin",
			plugins.status === 200 && listed.includes(PLUGIN_ID),
			listed.slice(0, 400),
		);

		// 2. The plugin is an email provider and can be selected.
		const emailSettings = await api("/_emdash/api/settings/email");
		const providers = emailSettings.json?.data?.providers ?? [];
		check(
			"the plugin is an email provider",
			providers.some((item) => item.pluginId === PLUGIN_ID),
			emailSettings.text.slice(0, 400),
		);
		// EmDash selects a provider automatically when it is the only real provider.
		console.log(
			`INFO  provider before a manual selection: ${emailSettings.json?.data?.selectedProviderId}`,
		);
		check(
			"EmDash selects the plugin automatically as the only provider",
			emailSettings.json?.data?.selectedProviderId === PLUGIN_ID,
			String(emailSettings.json?.data?.selectedProviderId),
		);
		const select = await api("/_emdash/api/settings/email", {
			method: "PUT",
			body: JSON.stringify({ provider: "plugin", pluginId: PLUGIN_ID }),
		});
		const afterSelect = await api("/_emdash/api/settings/email");
		check(
			"the plugin is selectable as the email provider",
			select.status === 200 && afterSelect.json?.data?.selectedProviderId === PLUGIN_ID,
			`${select.text.slice(0, 200)} ${afterSelect.text.slice(0, 200)}`,
		);

		// 3. The EmDash test email reaches the mock.
		mock.reset();
		const test = await api("/_emdash/api/settings/email", {
			method: "POST",
			body: JSON.stringify({ to: "tester@example.com" }),
		});
		const testSend = mock.sends()[0];
		check(
			"the EmDash test email reaches Resend",
			test.status === 200 && testSend?.body?.to?.[0] === "tester@example.com",
			test.text.slice(0, 300),
		);
		check(
			"the request uses the API key from the runtime environment",
			testSend?.headers.authorization === `Bearer ${API_KEY}`,
		);
		check(
			"the request has the sender from the plugin options",
			testSend?.body?.from === "Website <website@mail.example.com>",
			JSON.stringify(testSend?.body?.from),
		);
		check(
			"the request has the default reply-to",
			JSON.stringify(testSend?.body?.reply_to) === '["hello@example.com"]',
			JSON.stringify(testSend?.body?.reply_to),
		);
		check(
			"the request has text and HTML",
			typeof testSend?.body?.text === "string" && typeof testSend?.body?.html === "string",
		);
		check(
			"the request has an idempotency key",
			/^emdash\/\d+\/[0-9a-f]{64}$/.test(testSend?.headers["idempotency-key"] ?? ""),
			testSend?.headers["idempotency-key"],
		);
		check(
			"the request has a User-Agent header",
			(testSend?.headers["user-agent"] ?? "").startsWith("emdash-resend-kit/"),
			testSend?.headers["user-agent"],
		);
		check(
			"the request has the source tag",
			JSON.stringify(testSend?.body?.tags) === '[{"name":"emdash_source","value":"admin"}]',
			JSON.stringify(testSend?.body?.tags),
		);

		// 4. An invite email reaches the mock.
		mock.reset();
		const invite = await api("/_emdash/api/auth/invite", {
			method: "POST",
			body: JSON.stringify({ email: "invitee@example.com", role: 30 }),
		});
		const inviteSend = mock.sends()[0];
		check(
			"an invite email reaches Resend",
			invite.status < 300 && inviteSend?.body?.to?.[0] === "invitee@example.com",
			invite.text.slice(0, 300),
		);
		check(
			"the invite email has the system source tag",
			JSON.stringify(inviteSend?.body?.tags ?? "").includes('"value":"system"'),
		);

		// 5. A 429 response causes a retry with the same idempotency key.
		mock.reset();
		mock.failNext(
			429,
			{ statusCode: 429, name: "rate_limit_exceeded", message: "Too many requests." },
			{ "retry-after": "0" },
		);
		const retried = await api("/_emdash/api/settings/email", {
			method: "POST",
			body: JSON.stringify({ to: "retry@example.com" }),
		});
		const retrySends = mock.sends();
		check(
			"a 429 response causes one retry that succeeds",
			retried.status === 200 && retrySends.length === 2,
			`status ${retried.status}, requests ${retrySends.length}`,
		);
		check(
			"the retry uses the same idempotency key",
			retrySends.length === 2 &&
				retrySends[0].headers["idempotency-key"] === retrySends[1].headers["idempotency-key"],
		);

		// 6. The admin pages render Block Kit.
		const settingsPage = await admin({ type: "page_load", page: "/settings" });
		const settingsText = blocksText(settingsPage);
		check(
			"the settings page shows the API key source",
			settingsPage.status === 200 &&
				settingsText.includes("Present. Environment variable RESEND_API_KEY."),
			settingsText.slice(0, 500),
		);
		check(
			"the settings page does not contain the API key",
			!settingsText.includes(API_KEY) && !settingsText.includes(WEBHOOK_SECRET),
		);
		check(
			"the settings page shows the verified domain",
			settingsText.includes("mail.example.com") && settingsText.includes("verified"),
		);
		check(
			"the settings page shows the absolute webhook URL",
			settingsText.includes(`${origin}/_emdash/api/plugins/${PLUGIN_ID}/webhook`) ||
				/https?:\/\/[^"]+\/_emdash\/api\/plugins\/emdash-resend-kit\/webhook/.test(settingsText),
			settingsText.match(/[^"]*\/webhook/)?.[0],
		);

		// 7. The test email button of the plugin.
		mock.reset();
		const pluginTest = await admin({
			type: "form_submit",
			action_id: "test_send",
			page: "/settings",
			values: { to: "button@example.com" },
		});
		check(
			"the plugin test email reaches Resend",
			pluginTest.json?.data?.toast?.type === "success" &&
				mock.sends()[0]?.body?.to?.[0] === "button@example.com",
			pluginTest.text.slice(0, 300),
		);

		// 8. A Resend error gives a clear message and a failed log record.
		mock.reset();
		mock.failNext(403, {
			statusCode: 403,
			name: "validation_error",
			message: "The mail.example.com domain is not verified. Please, add and verify your domain.",
		});
		const failedTest = await admin({
			type: "form_submit",
			action_id: "test_send",
			page: "/settings",
			values: { to: "fail@example.com" },
		});
		check(
			"a Resend error gives a clear message",
			blocksText(failedTest).includes("The sender domain is not verified in Resend"),
			blocksText(failedTest).slice(0, 400),
		);

		// 9. The delivery log.
		const log = await admin({ type: "page_load", page: "/log" });
		const logText = blocksText(log);
		check(
			"the delivery log lists the sends",
			["tester@example.com", "invitee@example.com", "button@example.com", "fail@example.com"].every(
				(address) => logText.includes(address),
			),
			logText.slice(0, 600),
		);
		const failedOnly = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "failed", search: "", from: "", to: "" },
		});
		const failedText = blocksText(failedOnly);
		check(
			"the status filter of the log works",
			failedText.includes("fail@example.com") && !failedText.includes("invitee@example.com"),
			failedText.slice(0, 400),
		);
		const searched = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "all", search: "invitee@example.com", from: "", to: "" },
		});
		check(
			"the search of the log works",
			blocksText(searched).includes("invitee@example.com") &&
				!blocksText(searched).includes("button@example.com"),
		);

		const today = new Date().toISOString().slice(0, 10);
		const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
		const tableRows = (response) =>
			(response.json?.data?.blocks ?? []).find((block) => block.type === "table")?.rows ?? [];
		const fromToday = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "all", search: "", from: today, to: today },
		});
		const fromTomorrow = await admin({
			type: "form_submit",
			action_id: "log_filter",
			page: "/log",
			values: { status: "all", search: "", from: tomorrow, to: "" },
		});
		check(
			"the date filter of the log works",
			tableRows(fromToday).length >= 4 && tableRows(fromTomorrow).length === 0,
			`today: ${tableRows(fromToday).length}, tomorrow: ${tableRows(fromTomorrow).length}`,
		);

		// 10. Webhooks.
		const webhookUrl = `${origin}/_emdash/api/plugins/${PLUGIN_ID}/webhook`;
		const inviteId = await (async () => {
			const rows =
				(
					await admin({
						type: "form_submit",
						action_id: "log_filter",
						page: "/log",
						values: { status: "all", search: "invitee@example.com" },
					})
				).json?.data?.blocks ?? [];
			const table = rows.find((block) => block.type === "table");
			return table?.rows?.[0]?.view?.value?.id;
		})();
		check(
			"the log record ID is the Resend email ID",
			typeof inviteId === "string" && /^[0-9a-f-]{36}$/.test(inviteId),
			String(inviteId),
		);
		const eventBase = {
			from: "Website <website@mail.example.com>",
			to: ["invitee@example.com"],
			subject: "Invite",
			created_at: new Date().toISOString(),
			email_id: inviteId,
		};
		const delivered = await mock.sendWebhook(webhookUrl, WEBHOOK_SECRET, {
			type: "email.delivered",
			created_at: new Date().toISOString(),
			data: eventBase,
		});
		check(
			"a signed webhook is accepted",
			delivered.status === 200 && delivered.body.includes('"outcome":"recorded"'),
			`${delivered.status} ${delivered.body.slice(0, 200)}`,
		);
		const detail = await admin({
			type: "block_action",
			action_id: "log_view",
			page: "/log",
			value: { id: inviteId, f: {} },
		});
		check(
			"the webhook updates the log record",
			blocksText(detail).includes("Delivered"),
			blocksText(detail).slice(0, 500),
		);
		const repeat = await mock.sendWebhook(
			webhookUrl,
			WEBHOOK_SECRET,
			{ type: "email.delivered", created_at: new Date().toISOString(), data: eventBase },
			{ id: delivered.id },
		);
		check(
			"a repeated webhook is a duplicate",
			repeat.status === 200 && repeat.body.includes('"outcome":"duplicate"'),
			repeat.body.slice(0, 200),
		);
		const tampered = await mock.sendWebhook(
			webhookUrl,
			WEBHOOK_SECRET,
			{ type: "email.bounced", created_at: new Date().toISOString(), data: eventBase },
			{ tamper: true },
		);
		check(
			"a tampered webhook is rejected with 401",
			tampered.status === 401,
			`${tampered.status} ${tampered.body.slice(0, 200)}`,
		);
		const wrongSecret = await mock.sendWebhook(
			webhookUrl,
			`whsec_${randomBytes(24).toString("base64")}`,
			{ type: "email.delivered", created_at: new Date().toISOString(), data: eventBase },
		);
		check(
			"a webhook with a wrong secret is rejected with 401",
			wrongSecret.status === 401,
			`${wrongSecret.status}`,
		);
		const expired = await mock.sendWebhook(
			webhookUrl,
			WEBHOOK_SECRET,
			{ type: "email.delivered", created_at: new Date().toISOString(), data: eventBase },
			{ timestampOffset: -3600 },
		);
		check("an old webhook is rejected with 401", expired.status === 401, `${expired.status}`);
		const unsigned = await fetch(webhookUrl, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
		});
		check(
			"a webhook without a signature is rejected with 400",
			unsigned.status === 400,
			`${unsigned.status}`,
		);
		const getWebhook = await fetch(webhookUrl);
		check("the webhook route accepts POST only", getWebhook.status === 405, `${getWebhook.status}`);

		// 11. Suppression after a hard bounce.
		const bounce = await mock.sendWebhook(webhookUrl, WEBHOOK_SECRET, {
			type: "email.bounced",
			created_at: new Date().toISOString(),
			data: {
				...eventBase,
				bounce: { type: "Permanent", subType: "General", message: "Mailbox does not exist." },
			},
		});
		check(
			"a bounce webhook is accepted",
			bounce.status === 200,
			`${bounce.status} ${bounce.body.slice(0, 200)}`,
		);
		const suppressions = await admin({ type: "page_load", page: "/suppressions" });
		check(
			"the bounced address is on the suppression list",
			blocksText(suppressions).includes("invitee@example.com"),
			blocksText(suppressions).slice(0, 400),
		);
		mock.reset();
		const suppressedSend = await admin({
			type: "form_submit",
			action_id: "test_send",
			page: "/settings",
			values: { to: "invitee@example.com" },
		});
		check(
			"the plugin does not send to a suppressed address",
			mock.sends().length === 0 && blocksText(suppressedSend).includes("suppression list"),
			blocksText(suppressedSend).slice(0, 300),
		);
		const suppressionId = (suppressions.json?.data?.blocks ?? []).find(
			(block) => block.type === "table",
		)?.rows?.[0]?.remove?.value;
		const removed = await admin({
			type: "block_action",
			action_id: "suppression_remove",
			page: "/suppressions",
			value: suppressionId,
		});
		check(
			"an administrator can remove a suppressed address",
			removed.json?.data?.toast?.type === "success" &&
				!blocksText(removed).includes("invitee@example.com"),
		);

		// 12. The dashboard widget.
		const widget = await admin({ type: "page_load", page: "widget:delivery-stats" });
		const weekStats = (widget.json?.data?.blocks ?? []).find((block) => block.type === "stats");
		const week = Object.fromEntries(
			(weekStats?.items ?? []).map((item) => [item.label, item.value]),
		);
		check(
			"the dashboard widget counts sent, delivered, and bounced",
			week.Sent >= 4 && week.Delivered === 1 && week.Bounced === 1,
			JSON.stringify(week),
		);

		// 13. A stored secret is encrypted, and the environment variable has priority.
		const saved = await admin({
			type: "form_submit",
			action_id: "settings_save",
			page: "/settings",
			values: {
				fromEmail: "news@mail.example.com",
				fromName: "News",
				replyTo: "",
				apiKey: "re_stored_key_value",
				webhookSecret: "",
				logging: true,
				recipientPrivacy: "masked",
				retentionDays: 14,
				suppression: true,
			},
		});
		check(
			"the settings form saves",
			saved.json?.data?.toast?.type === "success",
			saved.text.slice(0, 300),
		);
		check(
			"the saved sender replaces the option",
			blocksText(saved).includes("News <news@mail.example.com>"),
		);
		check(
			"the environment variable has priority over the stored key",
			blocksText(saved).includes("Present. Environment variable RESEND_API_KEY."),
		);
		check(
			"the settings page does not show the stored key",
			!saved.text.includes("re_stored_key_value"),
		);
		const generated = await api(`/_emdash/api/admin/plugins/${PLUGIN_ID}/settings`);
		check(
			"EmDash masks the stored key in its settings API",
			generated.status === 200 && !generated.text.includes("re_stored_key_value"),
			generated.text.slice(0, 300),
		);
		mock.reset();
		await admin({
			type: "form_submit",
			action_id: "test_send",
			page: "/settings",
			values: { to: "masked.person@example.com" },
		});
		const maskedLog = await admin({ type: "page_load", page: "/log" });
		check(
			"the masked privacy setting hides the recipient in the log",
			blocksText(maskedLog).includes("m***@example.com") &&
				!blocksText(maskedLog).includes("masked.person@example.com"),
		);
		check(
			"the saved sender is in the request",
			mock.sends()[0]?.body?.from === "News <news@mail.example.com>",
			JSON.stringify(mock.sends()[0]?.body?.from),
		);

		// 14. Site code can use the client.
		mock.reset();
		const contact = await fetch(`${origin}/api/contact`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin },
			body: "email=visitor%40example.com&message=Hello",
			redirect: "manual",
		});
		const contactSend = mock.sends()[0];
		check(
			"site code sends an email with the client",
			contact.status === 303 &&
				contact.headers.get("location")?.includes("sent=1") &&
				contactSend?.body?.reply_to?.[0] === "visitor@example.com",
			`${contact.status} ${contact.headers.get("location")}`,
		);

		// 15. A private route rejects a request without a session.
		const anonymous = await fetch(`${origin}/_emdash/api/plugins/${PLUGIN_ID}/admin`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"type":"page_load","page":"/settings"}',
		});
		check(
			"the admin route rejects an anonymous request",
			anonymous.status === 401 || anonymous.status === 403,
			`${anonymous.status}`,
		);

		// 16. No secret is in the site log.
		check(
			"the site log does not contain the API key",
			!siteLog.includes(API_KEY) && !siteLog.includes(WEBHOOK_SECRET.slice(6)),
		);

		if (args.has("--browser")) {
			const { browserCheck } = await import("./browser-check.mjs");
			await browserCheck({ origin, check, outDir: join(workDir, "screenshots") });
		}

		if (args.has("--keep")) {
			console.log(
				`\nThe site runs at ${origin}/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin`,
			);
			console.log("Press Ctrl+C to stop.");
			await new Promise((done) => process.once("SIGINT", done));
		}
	} catch (error) {
		check(
			"the integration run completes",
			false,
			error instanceof Error ? (error.stack ?? error.message) : String(error),
		);
		console.log("\n--- last lines of the site log ---");
		console.log(siteLog.split("\n").slice(-40).join("\n"));
	} finally {
		await stop();
	}

	const failed = results.filter((item) => !item.ok);
	console.log(`\n${results.length - failed.length} of ${results.length} checks passed.`);
	if (failed.length > 0) {
		writeFileSync(join(workDir, "site.log"), siteLog);
		console.log(`Site log: ${join(workDir, "site.log")}`);
		process.exitCode = 1;
	}
}

await main();
