import { afterEach, describe, expect, it } from "vitest";

import {
	API_KEY_ENV_NAMES,
	describeSecretSource,
	envNames,
	loadProcessEnv,
	loadWorkerEnv,
	resetWorkerEnvCache,
	resolveEnvSecret,
	WEBHOOK_SECRET_ENV_NAMES,
} from "../src/secrets.js";
import { envSources } from "./helpers/fake-context.js";

afterEach(() => {
	delete process.env.RESEND_KIT_TEST_VALUE;
	resetWorkerEnvCache();
});

describe("resolveEnvSecret", () => {
	it("returns null when no variable has a value", async () => {
		expect(await resolveEnvSecret(API_KEY_ENV_NAMES, envSources({}))).toBeNull();
		expect(
			await resolveEnvSecret(API_KEY_ENV_NAMES, envSources({ RESEND_API_KEY: "  " })),
		).toBeNull();
		expect(
			await resolveEnvSecret(API_KEY_ENV_NAMES, envSources({ RESEND_API_KEY: 42 })),
		).toBeNull();
	});

	it("reads the Worker environment before process.env", async () => {
		const result = await resolveEnvSecret(
			API_KEY_ENV_NAMES,
			envSources({ RESEND_API_KEY: "re_process" }, { RESEND_API_KEY: "re_worker" }),
		);
		expect(result).toEqual({
			value: "re_worker",
			source: { kind: "env", name: "RESEND_API_KEY", runtime: "worker" },
		});
	});

	it("reads process.env when the Worker environment has no value", async () => {
		const result = await resolveEnvSecret(
			API_KEY_ENV_NAMES,
			envSources({ RESEND_API_KEY: " re_process " }, { OTHER: "x" }),
		);
		expect(result).toEqual({
			value: "re_process",
			source: { kind: "env", name: "RESEND_API_KEY", runtime: "process" },
		});
	});

	it("reads the names in order: RESEND_ first, then EMDASH_RESEND_", async () => {
		expect(API_KEY_ENV_NAMES).toEqual(["RESEND_API_KEY", "EMDASH_RESEND_API_KEY"]);
		expect(WEBHOOK_SECRET_ENV_NAMES).toEqual([
			"RESEND_WEBHOOK_SECRET",
			"EMDASH_RESEND_WEBHOOK_SECRET",
		]);
		const fallback = await resolveEnvSecret(
			API_KEY_ENV_NAMES,
			envSources({ EMDASH_RESEND_API_KEY: "re_prefixed" }),
		);
		expect(fallback?.source).toEqual({
			kind: "env",
			name: "EMDASH_RESEND_API_KEY",
			runtime: "process",
		});
		const first = await resolveEnvSecret(
			API_KEY_ENV_NAMES,
			envSources({ EMDASH_RESEND_API_KEY: "re_prefixed", RESEND_API_KEY: "re_plain" }),
		);
		expect(first?.value).toBe("re_plain");
	});

	it("a name earlier in the list wins over the Worker environment of a later name", async () => {
		const result = await resolveEnvSecret(
			["FIRST", "SECOND"],
			envSources({ FIRST: "from-process" }, { SECOND: "from-worker" }),
		);
		expect(result?.value).toBe("from-process");
	});

	it("uses the real process.env by default, and no Worker environment on Node", async () => {
		process.env.RESEND_KIT_TEST_VALUE = "from-real-env";
		const result = await resolveEnvSecret(["RESEND_KIT_TEST_VALUE"]);
		expect(result).toEqual({
			value: "from-real-env",
			source: { kind: "env", name: "RESEND_KIT_TEST_VALUE", runtime: "process" },
		});
		expect(await loadWorkerEnv()).toBeNull();
		expect(loadProcessEnv()).toBe(process.env);
	});
});

describe("envNames", () => {
	it("puts a custom name first and removes repeats", () => {
		expect(envNames(undefined, API_KEY_ENV_NAMES)).toEqual([
			"RESEND_API_KEY",
			"EMDASH_RESEND_API_KEY",
		]);
		expect(envNames("MY_KEY", API_KEY_ENV_NAMES)).toEqual([
			"MY_KEY",
			"RESEND_API_KEY",
			"EMDASH_RESEND_API_KEY",
		]);
		expect(envNames("RESEND_API_KEY", API_KEY_ENV_NAMES)).toEqual([
			"RESEND_API_KEY",
			"EMDASH_RESEND_API_KEY",
		]);
	});
});

describe("describeSecretSource", () => {
	it("describes each source without the value", () => {
		expect(describeSecretSource({ kind: "setting" })).toBe("Encrypted plugin setting");
		expect(describeSecretSource({ kind: "option" })).toBe("Client option");
		expect(describeSecretSource({ kind: "env", name: "RESEND_API_KEY", runtime: "worker" })).toBe(
			"Worker environment variable RESEND_API_KEY",
		);
		expect(describeSecretSource({ kind: "env", name: "RESEND_API_KEY", runtime: "process" })).toBe(
			"Environment variable RESEND_API_KEY",
		);
	});
});
