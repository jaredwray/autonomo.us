import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));

import { containerEnvironment } from "../src/container-environment.js";
import worker, { GatewayContainer } from "../src/container-worker.js";

const bindings = {
	MONGODB_URI: "mongodb://synthetic.invalid/test",
	PUBLIC_URL: "https://dev.autonomo.us",
	CONTAINER_CONTROL_TOKEN: "test-only-".repeat(8),
};
function fixture() {
	let info: unknown;
	const app = { fetch: vi.fn(async () => new Response("ok")) };
	const control = {
		fetch: vi.fn(async () => new Response(null, { status: 204 })),
	};
	const container = {
		running: false,
		images: { base: "registry/image@sha256:new" },
		start: vi.fn((options) => {
			container.running = true;
			info = options;
		}),
		inspect: vi.fn(async () => info),
		signal: vi.fn(() => {
			container.running = false;
		}),
		monitor: vi.fn(async () => {}),
		destroy: vi.fn(async () => {
			container.running = false;
		}),
		setInactivityTimeout: vi.fn(async () => {}),
		getTcpPort: vi.fn((port: number) => (port === 3000 ? app : control)),
	};
	const ctx = { container, blockConcurrencyWhile: vi.fn((fn) => fn()) };
	const instance = new GatewayContainer(ctx as never, bindings as never);
	return { container, app, control, ctx, instance };
}
afterEach(() => vi.useRealTimers());
describe("Container deployment boundary", () => {
	it("fails closed without persistent storage, HTTPS origin or control credentials", () => {
		for (const name of Object.keys(bindings))
			expect(() => containerEnvironment({ ...bindings, [name]: "" })).toThrow();
		expect(() =>
			containerEnvironment({
				...bindings,
				PUBLIC_URL: "http://dev.autonomo.us",
			}),
		).toThrow();
		const env = containerEnvironment({
			...bindings,
			CLOUDFLARE_API_TOKEN: "deployment-secret",
			UNRELATED_SECRET: "excluded",
			OPENAI_API_KEY: "synthetic-provider",
		});
		expect(env.CLOUDFLARE_API_TOKEN).toBeUndefined();
		expect(env.UNRELATED_SECRET).toBeUndefined();
		expect(env.OPENAI_API_KEY).toBe("synthetic-provider");
	});
	it("shares cold startup and forwards exact API body, cookies and auth with a fixed HTTPS origin", async () => {
		const f = fixture();
		const request = new Request("https://dev.autonomo.us/oauth/token?x=1", {
			method: "POST",
			body: "exact=bytes",
			headers: {
				authorization: "Bearer synthetic",
				cookie: "session=synthetic",
				"x-forwarded-host": "evil.invalid",
			},
		});
		await Promise.all([
			f.instance.fetch(request),
			f.instance.fetch(new Request("https://dev.autonomo.us/health")),
		]);
		expect(f.container.start).toHaveBeenCalledTimes(1);
		expect(f.container.start).toHaveBeenCalledWith(
			expect.objectContaining({
				enableInternet: true,
				instance: "lite",
				env: expect.objectContaining({ CONTAINER_MODE: "true" }),
			}),
		);
		const sent = f.app.fetch.mock.calls[0][0] as unknown as Request;
		expect(sent.url).toBe("http://container/oauth/token?x=1");
		expect(await sent.text()).toBe("exact=bytes");
		expect(sent.headers.get("authorization")).toBe("Bearer synthetic");
		expect(sent.headers.get("cookie")).toBe("session=synthetic");
		expect(sent.headers.has("x-forwarded-host")).toBe(false);
	});
	it("wakes a stopped container on cron with no incoming user requests", async () => {
		const f = fixture();
		const env = { GATEWAY: { getByName: vi.fn(() => f.instance) } };
		await worker.scheduled({} as never, env as never);
		expect(f.container.start).toHaveBeenCalledTimes(1);
		expect(f.control.fetch).toHaveBeenLastCalledWith(
			"http://container/sweep",
			expect.objectContaining({ method: "POST" }),
		);
		f.container.running = false;
		await worker.scheduled({} as never, env as never);
		expect(f.container.start).toHaveBeenCalledTimes(2);
		expect(f.app.fetch).not.toHaveBeenCalled();
	});
	it("updates the selected image and changed secrets after DO eviction", async () => {
		const f = fixture();
		await f.instance.sweep();
		f.container.images.base = "registry/image@sha256:next";
		await new GatewayContainer(f.ctx as never, bindings as never).sweep();
		expect(f.container.signal).toHaveBeenCalledWith(15);
		expect(f.container.start).toHaveBeenCalledTimes(2);
		await new GatewayContainer(
			f.ctx as never,
			{ ...bindings, SETUP_TOKEN: "changed-synthetic" } as never,
		).sweep();
		expect(f.container.start).toHaveBeenCalledTimes(3);
	});
	it("does not retry a failed application POST or leak its exception", async () => {
		const f = fixture();
		f.app.fetch.mockRejectedValue(new Error("sensitive internal failure"));
		const env = { GATEWAY: { getByName: () => f.instance } };
		const response = await worker.fetch(
			new Request("https://dev.autonomo.us/mcp", {
				method: "POST",
				body: "{}",
			}),
			env as never,
		);
		expect(response.status).toBe(503);
		expect(await response.text()).not.toContain("sensitive");
		expect(f.app.fetch).toHaveBeenCalledTimes(1);
	});
	it("reports scheduled failure and retries on a later tick", async () => {
		const f = fixture();
		const env = { GATEWAY: { getByName: () => f.instance } };
		f.control.fetch.mockImplementation(
			async (url) =>
				new Response(null, { status: url.endsWith("/sweep") ? 503 : 204 }),
		);
		await expect(worker.scheduled({} as never, env as never)).rejects.toThrow(
			"sweep failed",
		);
		f.control.fetch.mockResolvedValue(new Response(null, { status: 204 }));
		await expect(
			worker.scheduled({} as never, env as never),
		).resolves.toBeUndefined();
	});
});
