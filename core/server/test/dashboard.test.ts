import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFromEnv } from "../src/config.js";
import { createServer } from "../src/server.js";

const INDEX = "<!doctype html><title>autonomo.us</title><div id=root></div>";
const BUNDLE = "console.log('dashboard')";
const SECRET = "not for the browser";

let dashboardDir: string;
let server: ReturnType<typeof createServer>;
let apiOnly: ReturnType<typeof createServer>;

beforeAll(async () => {
	dashboardDir = await mkdtemp(join(tmpdir(), "autonomous-dashboard-"));
	await mkdir(join(dashboardDir, "assets"));
	await writeFile(join(dashboardDir, "index.html"), INDEX);
	await writeFile(join(dashboardDir, "assets", "index-abc123.js"), BUNDLE);
	await writeFile(join(dashboardDir, "favicon.svg"), "<svg/>");
	await writeFile(join(dashboardDir, ".secret"), SECRET);
	server = createServer({
		config: configFromEnv({}),
		logger: false,
		dashboardDir,
	});
	apiOnly = createServer({ config: configFromEnv({}), logger: false });
});

afterAll(async () => {
	await Promise.all([server.close(), apiOnly.close()]);
	await rm(dashboardDir, { recursive: true, force: true });
});

describe("dashboard hosting", () => {
	it("serves index.html at the root and never caches it", async () => {
		const response = await server.inject("/");
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
		expect(response.headers["cache-control"]).toBe("no-cache");
		expect(response.headers["content-length"]).toBe(String(INDEX.length));
		expect(response.headers.etag).toMatch(/^W\/"/);
		expect(response.body).toBe(INDEX);
	});

	it("serves hashed bundles as immutable", async () => {
		const response = await server.inject("/assets/index-abc123.js");
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe(
			"text/javascript; charset=utf-8",
		);
		expect(response.headers["cache-control"]).toBe(
			"public, max-age=31536000, immutable",
		);
		expect(response.body).toBe(BUNDLE);
	});

	it("serves other files with their media type", async () => {
		const response = await server.inject("/favicon.svg?v=2");
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toBe("image/svg+xml");
		expect(response.headers["cache-control"]).toBe("no-cache");
	});

	it("answers 304 to a matching If-None-Match", async () => {
		const first = await server.inject("/assets/index-abc123.js");
		const response = await server.inject({
			url: "/assets/index-abc123.js",
			headers: { "if-none-match": first.headers.etag as string },
		});
		expect(response.statusCode).toBe(304);
		expect(response.body).toBe("");
	});

	it("answers HEAD with headers only", async () => {
		const response = await server.inject({ method: "HEAD", url: "/" });
		expect(response.statusCode).toBe(200);
		expect(response.headers["content-length"]).toBe(String(INDEX.length));
		expect(response.body).toBe("");
	});

	it("falls back to index.html for client-side routes", async () => {
		for (const url of ["/models", "/team/invites/abc", "/settings?tab=1"]) {
			const response = await server.inject({
				url,
				headers: {
					accept:
						"text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
				},
			});
			expect(response.statusCode, url).toBe(200);
			expect(response.headers["content-type"]).toBe("text/html; charset=utf-8");
			expect(response.body).toBe(INDEX);
		}
	});

	it("keeps JSON 404s for clients that do not want HTML", async () => {
		const response = await server.inject({
			url: "/v2/models",
			headers: { accept: "application/json" },
		});
		expect(response.statusCode).toBe(404);
		expect(response.json()).toEqual({
			message: "Route GET:/v2/models not found",
			error: "Not Found",
			statusCode: 404,
		});
	});

	it("keeps JSON 404s for methods other than GET and HEAD", async () => {
		const response = await server.inject({ method: "POST", url: "/models" });
		expect(response.statusCode).toBe(404);
		expect(response.json().error).toBe("Not Found");
	});

	it("leaves unknown /v1 paths to the API, authentication included", async () => {
		const response = await server.inject("/v1/does-not-exist");
		expect(response.statusCode).toBe(401);
		expect(response.headers["www-authenticate"]).toBe("Bearer");
	});

	it("never serves dotfiles or paths outside the build directory", async () => {
		for (const url of [
			"/.secret",
			"/assets/../.secret",
			"/%2e%2e/%2e%2e/etc/passwd",
			"/assets/..%2f..%2fpackage.json",
		]) {
			const response = await server.inject(url);
			expect(response.statusCode, url).toBe(200);
			expect(response.body, url).toBe(INDEX);
		}
		// Fastify rejects malformed percent-encoding before routing.
		expect((await server.inject("/%zz")).statusCode).toBe(400);
	});

	it("does not host files unless a dashboard directory is configured", async () => {
		const response = await apiOnly.inject("/");
		expect(response.statusCode).toBe(404);
		expect(response.json().error).toBe("Not Found");
	});
});
