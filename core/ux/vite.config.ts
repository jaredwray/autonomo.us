import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const apiTarget = process.env.VITE_API_PROXY_TARGET || "http://localhost:3000";

export default defineConfig({
	plugins: [react()],
	server: {
		proxy: {
			"/v1": apiTarget,
			"/health": apiTarget,
			// A finished video's link is the gateway's own, outside /v1.
			"/video/downloads": apiTarget,
		},
	},
});
