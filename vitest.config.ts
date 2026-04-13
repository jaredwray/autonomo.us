import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		projects: ["core/*/vitest.config.ts"],
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
