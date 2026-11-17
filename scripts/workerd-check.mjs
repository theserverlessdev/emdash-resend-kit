/**
 * Runtime check on workerd, the Cloudflare Workers runtime.
 *
 * Run `node scripts/cloudflare-check.mjs` first. That script creates the site
 * in `.integration/cf-site`.
 *
 * Part 1 starts `astro dev`, which runs the site in workerd through the
 * Cloudflare Vite plugin. It checks that the plugin reads the API key at
 * runtime and sends an email to a local mock of the Resend API.
 *
 * Part 2 builds the site and starts the production bundle with
 * `wrangler dev`. It checks that the public webhook route reads the signing
 * secret at runtime and verifies a signature.
 *
 * All of this runs on the local computer. The script deploys nothing.
 */

import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { startMockResend } from "./mock-resend.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const siteDir = join(root, ".integration", "cf-site");
const PLUGIN_ID = "emdash-resend-kit";
const API_KEY = `re_workerd_${randomBytes(12).toString("hex")}`;
const WEBHOOK_SECRET = `whsec_${randomBytes(24).toString("base64")}`;

let failed = false;
function check(name, ok, detail) {
	if (!ok) failed = true;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

async function waitFor(url, timeoutMs, logs) {
	const end = Date.now() + timeoutMs;
	for (;;) {
		try {
			const response = await fetch(url, { redirect: "manual" });
			if (response.status < 500) return;
		} catch {
			// The server is not up yet.
		}
		if (Date.now() > end) {
			throw new Error(`No answer from ${url} in ${timeoutMs} ms.\n${logs().slice(-3000)}`);
		}
		await new Promise((done) => setTimeout(done, 500));
	}
}

function start(command, args, env) {
	let output = "";
	const child = spawn(command, args, {
		cwd: siteDir,
		env: { ...process.env, ASTRO_TELEMETRY_DISABLED: "1", WRANGLER_SEND_METRICS: "false", ...env },
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	child.stdout.on("data", (chunk) => (output += chunk));
	child.stderr.on("data", (chunk) => (output += chunk));
	return {
		logs: () => output,
		stop: () => {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		},
	};
}

if (!existsSync(join(siteDir, "node_modules", PLUGIN_ID))) {
	throw new Error("Run `node scripts/cloudflare-check.mjs` first.");
}

// The local secrets file of Wrangler. This is the local form of `wrangler secret put`.
const envPath = join(siteDir, ".env");
const baseEnv = existsSync(envPath)
	? readFileSync(envPath, "utf8")
			.split("\n")
			.filter((line) => line && !line.startsWith("RESEND_"))
			.join("\n")
	: "";
writeFileSync(
	envPath,
	`${baseEnv}\nRESEND_API_KEY=${API_KEY}\nRESEND_WEBHOOK_SECRET=${WEBHOOK_SECRET}\n`,
);
rmSync(join(siteDir, ".wrangler"), { recursive: true, force: true });

const mock = await startMockResend();
const astroBin = join(siteDir, "node_modules", "astro", "bin", "astro.mjs");

// ---------------------------------------------------------------------------
// Part 1: astro dev in workerd
// ---------------------------------------------------------------------------
{
	const port = await freePort();
	const origin = `http://localhost:${port}`;
	console.log(`Part 1: astro dev on workerd at ${origin}`);
	// The process environment has no key. The key is only in the local secrets file.
	const env = { RESEND_BASE_URL: mock.url, RESEND_API_KEY: "", RESEND_WEBHOOK_SECRET: "" };
	const site = start(process.execPath, [astroBin, "dev", "--port", String(port)], env);
	try {
		await waitFor(`${origin}/`, 180_000, site.logs);
		const bypass = await (
			await fetch(`${origin}/_emdash/api/setup/dev-bypass?token=1&content=0`, { method: "POST" })
		).json();
		const token = bypass?.data?.token;
		check(
			"workerd dev: the dev bypass returns a token",
			typeof token === "string",
			JSON.stringify(bypass).slice(0, 300),
		);
		const api = async (path, init = {}) => {
			const response = await fetch(`${origin}${path}`, {
				...init,
				headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
			});
			return { status: response.status, text: await response.text() };
		};

		const settings = await api(`/_emdash/api/plugins/${PLUGIN_ID}/admin`, {
			method: "POST",
			body: JSON.stringify({ type: "page_load", page: "/settings" }),
		});
		const source = /"API key","value":"([^"]+)"/.exec(settings.text)?.[1];
		check(
			"workerd dev: the plugin finds the API key at runtime",
			settings.status === 200 && source?.startsWith("Present."),
			settings.text.slice(0, 300),
		);
		console.log(`      API key source in workerd: ${source}`);
		check(
			"workerd dev: the response does not contain the API key",
			!settings.text.includes(API_KEY),
		);

		await api("/_emdash/api/settings/email", {
			method: "PUT",
			body: JSON.stringify({ provider: "plugin", pluginId: PLUGIN_ID }),
		});
		const test = await api("/_emdash/api/settings/email", {
			method: "POST",
			body: JSON.stringify({ to: "workerd@example.com" }),
		});
		const sent = mock.sends()[0];
		check(
			"workerd dev: the EmDash test email reaches the mock",
			test.status === 200 && sent?.body?.to?.[0] === "workerd@example.com",
			test.text.slice(0, 300),
		);
		if (test.status !== 200) {
			try {
				const devLogs = execFileSync(process.execPath, [astroBin, "dev", "logs"], {
					cwd: siteDir,
					encoding: "utf8",
					timeout: 10_000,
				});
				console.log(devLogs.split("\n").slice(-30).join("\n"));
			} catch (error) {
				console.log(
					String(error.stdout ?? error)
						.split("\n")
						.slice(-30)
						.join("\n"),
				);
			}
		}
		check(
			"workerd dev: the request has the key from the local secrets file",
			sent?.headers.authorization === `Bearer ${API_KEY}`,
		);

		const hook = await mock.sendWebhook(
			`${origin}/_emdash/api/plugins/${PLUGIN_ID}/webhook`,
			WEBHOOK_SECRET,
			{
				type: "email.delivered",
				created_at: new Date().toISOString(),
				data: {
					email_id: "0b6f0d2c-1c1b-4f0e-9d3a-000000000001",
					to: ["workerd@example.com"],
					subject: "x",
				},
			},
		);
		check(
			"workerd dev: a signed webhook is accepted",
			hook.status === 200,
			`${hook.status} ${hook.body.slice(0, 200)}`,
		);
		const bad = await mock.sendWebhook(
			`${origin}/_emdash/api/plugins/${PLUGIN_ID}/webhook`,
			WEBHOOK_SECRET,
			{ type: "email.delivered", data: {} },
			{ tamper: true },
		);
		check("workerd dev: a tampered webhook is rejected", bad.status === 401, `${bad.status}`);
	} catch (error) {
		check("workerd dev: the run completes", false, String(error?.stack ?? error).slice(0, 3000));
	} finally {
		try {
			execFileSync(process.execPath, [astroBin, "dev", "stop"], { cwd: siteDir, stdio: "ignore" });
		} catch {
			// The dev server is not a background process.
		}
		site.stop();
	}
}

// ---------------------------------------------------------------------------
// Part 2: the production bundle in wrangler dev
// ---------------------------------------------------------------------------
if (!process.argv.includes("--dev-only")) {
	console.log("Part 2: build the production bundle (no key in the build environment).");
	const buildEnv = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" };
	delete buildEnv.RESEND_API_KEY;
	delete buildEnv.RESEND_WEBHOOK_SECRET;
	// Hide the local secrets file from the build.
	const secrets = readFileSync(envPath, "utf8");
	writeFileSync(envPath, baseEnv);
	try {
		execFileSync(process.execPath, [astroBin, "build"], {
			cwd: siteDir,
			env: buildEnv,
			stdio: "ignore",
		});
	} finally {
		writeFileSync(envPath, secrets);
	}
	const port = await freePort();
	const origin = `http://127.0.0.1:${port}`;
	console.log(`Part 2: wrangler dev (production bundle) at ${origin}`);
	const worker = start("npx", ["wrangler", "dev", "--port", String(port), "--ip", "127.0.0.1"], {
		RESEND_API_KEY: "",
		RESEND_WEBHOOK_SECRET: "",
	});
	try {
		await waitFor(`${origin}/_emdash/api/plugins/${PLUGIN_ID}/webhook`, 120_000, worker.logs);
		const url = `${origin}/_emdash/api/plugins/${PLUGIN_ID}/webhook`;
		const event = {
			type: "email.delivered",
			created_at: new Date().toISOString(),
			data: {
				email_id: "0b6f0d2c-1c1b-4f0e-9d3a-000000000002",
				to: ["prod@example.com"],
				subject: "x",
			},
		};
		const good = await mock.sendWebhook(url, WEBHOOK_SECRET, event);
		check(
			"production bundle on workerd: a signed webhook is accepted",
			good.status === 200 && good.body.includes('"received":true'),
			`${good.status} ${good.body.slice(0, 300)}`,
		);
		const wrong = await mock.sendWebhook(url, `whsec_${randomBytes(24).toString("base64")}`, event);
		check(
			"production bundle on workerd: a wrong signature is rejected with 401",
			wrong.status === 401,
			`${wrong.status} ${wrong.body.slice(0, 200)}`,
		);
		const anonymous = await fetch(`${origin}/_emdash/api/plugins/${PLUGIN_ID}/admin`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: '{"type":"page_load","page":"/settings"}',
		});
		check(
			"production bundle on workerd: the admin route rejects an anonymous request",
			anonymous.status === 401 || anonymous.status === 403,
			`${anonymous.status}`,
		);
		const bypass = await fetch(`${origin}/_emdash/api/setup/dev-bypass`, { method: "POST" });
		check(
			"production bundle on workerd: the dev bypass is off",
			bypass.status === 403 || bypass.status === 404,
			`${bypass.status}`,
		);
		check(
			"production bundle on workerd: the log does not contain a secret",
			!worker.logs().includes(WEBHOOK_SECRET.slice(6)) && !worker.logs().includes(API_KEY),
		);
	} catch (error) {
		check(
			"production bundle on workerd: the run completes",
			false,
			String(error?.stack ?? error).slice(0, 3000),
		);
	} finally {
		worker.stop();
	}
}

await mock.close();
// Remove the local secrets from the site again.
writeFileSync(envPath, baseEnv);
if (failed) process.exitCode = 1;
