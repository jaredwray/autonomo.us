import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["packages/*/vitest.config.ts"],
		coverage: {
			reporter: ["json", "text", "lcov"],
			exclude: [
				"**/test/**",
				"**/dist/**",
				"**/node_modules/**",
				"**/*.config.ts",
			],
		},
	},
});
