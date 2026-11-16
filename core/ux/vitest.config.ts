import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
 include: ["test/**/*.test.{ts,tsx}"],
		environment: "jsdom",
		coverage: {
			reporter: ["json", "text", "lcov"],
			exclude: ["**/test/**", "**/dist/**"],
		},
	},
});
