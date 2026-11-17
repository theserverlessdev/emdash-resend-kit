import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["test/**/*.test.ts"],
		environment: "node",
		restoreMocks: true,
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.d.ts"],
			reporter: ["text", "text-summary", "lcov"],
			thresholds: {
				lines: 90,
				statements: 90,
				functions: 90,
				branches: 80,
			},
		},
	},
});
