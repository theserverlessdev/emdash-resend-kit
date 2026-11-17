/**
 * Cloudflare build check.
 *
 * The script scaffolds the EmDash Cloudflare starter, adds the plugin from a
 * local tarball, builds the site, and runs `wrangler deploy --dry-run`. It
 * also proves that no secret is in the build output: a sentinel API key is in
 * the environment of the build, and the script searches the output for it.
 *
 * The script deploys nothing.
 *
 * Usage: node scripts/cloudflare-check.mjs
 */

import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workDir = join(root, ".integration");
const siteDir = join(workDir, "cf-site");
const SENTINEL_KEY = "re_KITSENTINEL_buildtime_0123456789abcdef";
// Base64 of "KITSENTINEL_webhook_secret_value".
const SENTINEL_SECRET = "whsec_S0lUU0VOVElORUxfd2ViaG9va19zZWNyZXRfdmFsdWU=";
// Parts of the sentinels. A match of a part is also a leak.
const SENTINEL_PARTS = ["KITSENTINEL", SENTINEL_SECRET.slice(6, 30)];

function run(command, args, cwd, env = {}) {
	return execFileSync(command, args, {
		cwd,
		env: { ...process.env, ...env },
		stdio: ["ignore", "pipe", "pipe"],
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
	});
}

function filesUnder(directory) {
	const result = [];
	for (const name of readdirSync(directory)) {
		const path = join(directory, name);
		if (statSync(path).isDirectory()) result.push(...filesUnder(path));
		else result.push(path);
	}
	return result;
}

let failed = false;
function check(name, ok, detail) {
	if (!ok) failed = true;
	console.log(`${ok ? "PASS" : "FAIL"}  ${name}${!ok && detail ? `\n      ${detail}` : ""}`);
}

mkdirSync(workDir, { recursive: true });
console.log("Build and pack the plugin.");
run("npm", ["run", "build", "--silent"], root);
for (const name of readdirSync(workDir)) {
	if (name.endsWith(".tgz")) rmSync(join(workDir, name));
}
run("npm", ["pack", "--silent", "--pack-destination", workDir], root);
const tarball = readdirSync(workDir).find((name) => name.endsWith(".tgz"));

if (!existsSync(join(siteDir, "node_modules"))) {
	console.log("Scaffold the EmDash Cloudflare starter.");
	rmSync(siteDir, { recursive: true, force: true });
	run(
		"npx",
		[
			"--yes",
			"create-emdash@latest",
			"cf-site",
			"--template",
			"starter",
			"--platform",
			"cloudflare",
			"--pm",
			"npm",
			"--no-install",
			"--yes",
		],
		workDir,
	);
}

console.log("Add the plugin to the site.");
const configPath = join(siteDir, "astro.config.mjs");
let config = readFileSync(configPath, "utf8");
// The base URL option is for `scripts/workerd-check.mjs`, which sets
// RESEND_BASE_URL to a local mock. The builds of this script do not set it.
const pluginBlock = [
	"plugins: [",
	"\t\t\t\tresendKit({",
	'\t\t\t\t\tfrom: "Website <website@mail.example.com>",',
	"\t\t\t\t\t...(process.env.RESEND_BASE_URL ? { baseUrl: process.env.RESEND_BASE_URL } : {}),",
	"\t\t\t\t}),",
	"\t\t\t],",
].join("\n");
if (!config.includes("emdash-resend-kit")) {
	config = config.replace(
		'import emdash from "emdash/astro";',
		'import emdash from "emdash/astro";\nimport { resendKit } from "emdash-resend-kit";',
	);
}
if (!config.includes("RESEND_BASE_URL")) {
	// Remove a plugin block from an earlier run, then add the current block.
	config = config
		.replace(/\n\t\t\tplugins: \[resendKit\([^\n]*\)\],/, "")
		.replace(
			'storage: r2({ binding: "MEDIA" }),',
			`storage: r2({ binding: "MEDIA" }),\n\t\t\t${pluginBlock}`,
		);
	writeFileSync(configPath, config);
}
check("the site configuration has the plugin", config.includes("resendKit({"));

const packagePath = join(siteDir, "package.json");
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
manifest.dependencies["emdash-resend-kit"] = `file:${join(workDir, tarball)}`;
writeFileSync(packagePath, JSON.stringify(manifest, null, "\t"));
// The scaffold writes a .env file. Keep it, and add nothing to it: the
// sentinel secrets come from the process environment of the build only.
console.log("Install the dependencies of the site.");
run("npm", ["install", "--no-audit", "--no-fund", "--loglevel=error"], siteDir);

console.log("Build the site with a sentinel API key in the environment.");
rmSync(join(siteDir, "dist"), { recursive: true, force: true });
try {
	run("npx", ["astro", "build"], siteDir, {
		RESEND_API_KEY: SENTINEL_KEY,
		RESEND_WEBHOOK_SECRET: SENTINEL_SECRET,
		ASTRO_TELEMETRY_DISABLED: "1",
	});
	check("astro build passes", true);
} catch (error) {
	check("astro build passes", false, String(error.stderr ?? error).slice(-2000));
}

const outputFiles = existsSync(join(siteDir, "dist")) ? filesUnder(join(siteDir, "dist")) : [];
let pluginInBundle = false;
const leaks = [];
for (const file of outputFiles) {
	const content = readFileSync(file);
	if (content.includes("emdash-resend-kit")) pluginInBundle = true;
	if (SENTINEL_PARTS.some((part) => content.includes(part))) leaks.push(file);
}
check(`the build output has ${outputFiles.length} files and contains the plugin`, pluginInBundle);
check(
	"the build output does not contain the sentinel API key or secret",
	leaks.length === 0,
	leaks.join("\n      "),
);

console.log("Build the site again with no key in the environment.");
try {
	const env = { ...process.env, ASTRO_TELEMETRY_DISABLED: "1" };
	delete env.RESEND_API_KEY;
	delete env.RESEND_WEBHOOK_SECRET;
	execFileSync("npx", ["astro", "build"], { cwd: siteDir, env, stdio: ["ignore", "pipe", "pipe"] });
	check("astro build passes with no API key at build time", true);
} catch (error) {
	check(
		"astro build passes with no API key at build time",
		false,
		String(error.stderr ?? error).slice(-2000),
	);
}

console.log("Run wrangler deploy --dry-run.");
try {
	const output = run(
		"npx",
		["wrangler", "deploy", "--dry-run", "--outdir", join(siteDir, ".dry-run")],
		siteDir,
	);
	check(
		"wrangler deploy --dry-run passes",
		/dry-run|Total Upload/i.test(output),
		output.slice(-600),
	);
	const dryRunFiles = filesUnder(join(siteDir, ".dry-run"));
	const dryRunLeaks = dryRunFiles.filter((file) => {
		const content = readFileSync(file);
		return SENTINEL_PARTS.some((part) => content.includes(part));
	});
	const dryRunHasPlugin = dryRunFiles.some((file) =>
		readFileSync(file).includes("emdash-resend-kit"),
	);
	check("the Worker bundle of the dry run contains the plugin", dryRunHasPlugin);
	check(
		"the Worker bundle of the dry run does not contain a secret",
		dryRunLeaks.length === 0,
		dryRunLeaks.join(", "),
	);
	console.log(
		output
			.split("\n")
			.filter((line) => /Total Upload|dry-run/i.test(line))
			.join("\n"),
	);
} catch (error) {
	check(
		"wrangler deploy --dry-run passes",
		false,
		String(error.stderr ?? error.stdout ?? error).slice(-2000),
	);
}

if (failed) process.exitCode = 1;
