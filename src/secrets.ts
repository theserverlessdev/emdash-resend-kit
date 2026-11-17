/**
 * Runtime secret resolution.
 *
 * A secret is never part of the plugin options, because EmDash writes the
 * options into the server bundle. The code reads each secret when it needs
 * it, from one of these sources:
 *
 * 1. The Cloudflare Worker environment (`cloudflare:workers`).
 * 2. `process.env`.
 * 3. An encrypted plugin setting (resolved by the plugin, not by this module).
 */

/** Default environment variable names for the API key, in lookup order. */
export const API_KEY_ENV_NAMES = ["RESEND_API_KEY", "EMDASH_RESEND_API_KEY"] as const;

/** Default environment variable names for the webhook secret, in lookup order. */
export const WEBHOOK_SECRET_ENV_NAMES = [
	"RESEND_WEBHOOK_SECRET",
	"EMDASH_RESEND_WEBHOOK_SECRET",
] as const;

export type EnvRecord = Record<string, unknown>;

/** Where a secret came from. */
export type SecretSource =
	| { kind: "env"; name: string; runtime: "worker" | "process" }
	| { kind: "setting" }
	| { kind: "option" };

export interface ResolvedSecret {
	value: string;
	source: SecretSource;
}

let workerEnvPromise: Promise<EnvRecord | null> | undefined;

/**
 * Load the Cloudflare Worker environment.
 *
 * The specifier is a variable, so a bundler does not try to resolve the
 * module. Node rejects the import, and the function returns `null`.
 */
export function loadWorkerEnv(): Promise<EnvRecord | null> {
	workerEnvPromise ??= (async () => {
		try {
			const specifier = ["cloudflare", "workers"].join(":");
			const module_: { env?: unknown } = await import(/* @vite-ignore */ specifier);
			return typeof module_.env === "object" && module_.env !== null
				? (module_.env as EnvRecord)
				: null;
		} catch {
			return null;
		}
	})();
	return workerEnvPromise;
}

/** Return `process.env` when the runtime has one. */
export function loadProcessEnv(): EnvRecord | null {
	const candidate = (globalThis as { process?: { env?: unknown } }).process?.env;
	return typeof candidate === "object" && candidate !== null ? (candidate as EnvRecord) : null;
}

export interface EnvSources {
	/** Loader for the Worker environment. The default imports `cloudflare:workers`. */
	workerEnv?: () => Promise<EnvRecord | null>;
	/** Loader for the process environment. The default reads `process.env`. */
	processEnv?: () => EnvRecord | null;
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Read the first variable in `names` that has a value.
 *
 * The Worker environment has priority over `process.env`.
 */
export async function resolveEnvSecret(
	names: ReadonlyArray<string>,
	sources: EnvSources = {},
): Promise<ResolvedSecret | null> {
	const workerEnv = await (sources.workerEnv ?? loadWorkerEnv)();
	const processEnv = (sources.processEnv ?? loadProcessEnv)();
	for (const name of names) {
		const fromWorker = nonEmptyString(workerEnv?.[name]);
		if (fromWorker) return { value: fromWorker, source: { kind: "env", name, runtime: "worker" } };
		const fromProcess = nonEmptyString(processEnv?.[name]);
		if (fromProcess) {
			return { value: fromProcess, source: { kind: "env", name, runtime: "process" } };
		}
	}
	return null;
}

/** Build the list of variable names. A custom name comes first. */
export function envNames(custom: string | undefined, defaults: ReadonlyArray<string>): string[] {
	const names = custom ? [custom, ...defaults] : [...defaults];
	return [...new Set(names)];
}

/** Describe a secret source in one short sentence for the admin UI. */
export function describeSecretSource(source: SecretSource): string {
	if (source.kind === "setting") return "Encrypted plugin setting";
	if (source.kind === "option") return "Client option";
	return source.runtime === "worker"
		? `Worker environment variable ${source.name}`
		: `Environment variable ${source.name}`;
}

/** Reset the cached Worker environment. Tests use this function. */
export function resetWorkerEnvCache(): void {
	workerEnvPromise = undefined;
}
