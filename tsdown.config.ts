import { defineConfig } from "tsdown";

export default defineConfig({
	entry: {
		index: "src/index.ts",
		client: "src/client.ts",
		webhook: "src/webhook.ts",
	},
	format: "esm",
	platform: "neutral",
	target: "es2023",
	dts: true,
	sourcemap: true,
	clean: true,
	// `emdash` is a peer dependency. `cloudflare:workers` exists only on the
	// Workers runtime, and the code loads it with a guarded dynamic import.
	external: ["emdash", /^cloudflare:/, /^node:/],
});
