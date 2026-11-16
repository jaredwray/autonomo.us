import { defineConfig } from "@playwright/test";
export default defineConfig({
 testDir: "./browser",
 use: { baseURL: "http://127.0.0.1:4173", launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined },
 webServer: { command: "node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 4173", url: "http://127.0.0.1:4173", reuseExistingServer: !process.env.CI },
});
