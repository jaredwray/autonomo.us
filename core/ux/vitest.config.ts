import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
 include: ["test/**/*.test.{ts,tsx}"],
		environment: "jsdom",
		// Node 26 native Web Storage shadows jsdom storage in Vitest 4.
		// Keep browser tests on jsdom's per-origin, in-memory storage.
		execArgv: ["--no-webstorage"],
		coverage: {
			reporter: ["json", "text", "lcov"],
			exclude: ["**/test/**", "**/dist/**"],
		},
	},
});
