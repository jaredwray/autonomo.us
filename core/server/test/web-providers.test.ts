import type { ProxyLevel, WebFetchFormat } from "@autonomo.us/common";
import { describe, expect, it } from "vitest";
import {
	brightdataAdapter,
	cloudflareAdapter,
	PROXY_ADAPTERS,
	zenrowsAdapter,
} from "../src/web/providers/index.js";
import type {
	FetchLike,
	ProxyCall,
	ProxyConfig,
	StepResult,
} from "../src/web/types.js";

const KEY = "sk_live_very_secret_key_123";
const TARGET = "https://shop.example.com/pricing?ref=1";

type Seen = { url: string; init: RequestInit };

/** A fake fetch that records the request and answers with `answer`. */
function fake(answer: Response | (() => Response | Promise<Response>)) {
	const seen: Seen[] = [];
	const fetchImpl: FetchLike = async (input, init = {}) => {
		seen.push({ url: String(input), init });
		return typeof answer === "function" ? answer() : answer.clone();
	};
	return { fetchImpl, seen };
}

function call(
	level: ProxyLevel,
	format: WebFetchFormat = "markdown",
	signal = new AbortController().signal,
): ProxyCall {
	return { url: TARGET, level, format, signal };
}

const problem = (
	status: number,
	code: string,
	headers: Record<string, string> = {},
) =>
	new Response(
		JSON.stringify({
			code,
			detail: "details",
			status,
			title: `Problem (${code})`,
			type: `https://docs.zenrows.com/api-error-codes#${code}`,
		}),
		{
			status,
			headers: { "content-type": "application/problem+json", ...headers },
		},
	);

const zenrows: ProxyConfig = {
	name: "zenrows",
	kind: "zenrows",
	apiKey: KEY,
	enabled: true,
	monthlyRequestCap: null,
};
const cloudflare: ProxyConfig = {
	name: "cf-render",
	kind: "cloudflare-browser",
	apiKey: KEY,
	accountId: "0123456789abcdef0123456789abcdef",
	enabled: true,
	monthlyRequestCap: null,
};
const brightdata: ProxyConfig = {
	name: "brightdata",
	kind: "brightdata",
	apiKey: KEY,
	zone: "web_unlocker1",
	enabled: true,
	monthlyRequestCap: null,
};

describe("PROXY_ADAPTERS", () => {
	it("has one adapter per kind", () => {
		for (const [kind, adapter] of Object.entries(PROXY_ADAPTERS))
			expect(adapter.kind).toBe(kind);
	});
});

describe("zenrows", () => {
	const ok = (headers: Record<string, string> = {}) =>
		new Response("# Pricing", {
			status: 200,
			headers: {
				"content-type": "text/plain",
				"x-request-cost": "0.005",
				"zr-final-url": "https://shop.example.com/pricing",
				...headers,
			},
		});

	it.each([
		["auto", { mode: "auto" }],
		["basic", {}],
		["render", { js_render: "true" }],
		["premium", { premium_proxy: "true" }],
		["render-premium", { js_render: "true", premium_proxy: "true" }],
	] as const)("sends the %s level's parameters and nothing else", async (level, params) => {
		const { fetchImpl, seen } = fake(ok());
		await zenrowsAdapter.fetch(zenrows, call(level), fetchImpl);
		const url = new URL(seen[0].url);
		expect(`${url.origin}${url.pathname}`).toBe("https://api.zenrows.com/v1/");
		expect(Object.fromEntries(url.searchParams)).toEqual({
			apikey: KEY,
			url: TARGET,
			response_type: "markdown",
			...params,
		});
		expect(seen[0].init.method).toBe("GET");
	});

	it("never sends js_render or premium_proxy with mode=auto", async () => {
		const { fetchImpl, seen } = fake(ok());
		await zenrowsAdapter.fetch(zenrows, call("auto"), fetchImpl);
		const params = new URL(seen[0].url).searchParams;
		expect(params.has("js_render")).toBe(false);
		expect(params.has("premium_proxy")).toBe(false);
		for (const banned of [
			"original_status",
			"allowed_status_codes",
			"custom_headers",
			"session_id",
		])
			expect(params.has(banned)).toBe(false);
	});

	it("asks for HTML by leaving response_type out", async () => {
		const { fetchImpl, seen } = fake(
			ok({ "content-type": "text/html; charset=utf-8" }),
		);
		const result = await zenrowsAdapter.fetch(
			zenrows,
			call("basic", "html"),
			fetchImpl,
		);
		expect(new URL(seen[0].url).searchParams.has("response_type")).toBe(false);
		expect(result).toMatchObject({ outcome: "ok", contentFormat: "html" });
	});

	it("returns a non-HTML type as text", async () => {
		const { fetchImpl } = fake(
			new Response('{"a":1}', {
				headers: { "content-type": "application/json" },
			}),
		);
		const result = await zenrowsAdapter.fetch(
			zenrows,
			call("basic", "html"),
			fetchImpl,
		);
		expect(result).toMatchObject({ outcome: "ok", contentFormat: "text" });
	});

	it("sends proxy_country only where ZenRows accepts it", async () => {
		const config = { ...zenrows, country: "DE" };
		for (const [level, sent] of [
			["auto", true],
			["premium", true],
			["render-premium", true],
			["basic", false],
			["render", false],
		] as const) {
			const { fetchImpl, seen } = fake(ok());
			await zenrowsAdapter.fetch(config, call(level), fetchImpl);
			expect(new URL(seen[0].url).searchParams.get("proxy_country")).toBe(
				sent ? "de" : null,
			);
		}
	});

	it("uses the base URL override", async () => {
		const { fetchImpl, seen } = fake(ok());
		await zenrowsAdapter.fetch(
			{ ...zenrows, baseUrl: "http://127.0.0.1:9999/" },
			call("auto"),
			fetchImpl,
		);
		expect(seen[0].url.startsWith("http://127.0.0.1:9999/v1/?")).toBe(true);
	});

	it("returns the page, the final URL, and what ZenRows charged", async () => {
		const { fetchImpl } = fake(ok());
		expect(
			await zenrowsAdapter.fetch(zenrows, call("auto"), fetchImpl),
		).toEqual({
			outcome: "ok",
			status: 200,
			finalUrl: "https://shop.example.com/pricing",
			contentType: "text/plain",
			content: "# Pricing",
			contentFormat: "markdown",
			costUsd: 0.005,
		});
	});

	it("falls back to X-Request-Credits, then to the level's price", async () => {
		const credits = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(new Response("x", { headers: { "x-request-credits": "10" } }))
				.fetchImpl,
		);
		expect(credits.costUsd).toBeCloseTo(0.01);
		const table = await zenrowsAdapter.fetch(
			zenrows,
			call("render"),
			fake(new Response("x")).fetchImpl,
		);
		expect(table.costUsd).toBeCloseTo(0.005);
		const noFinal = await zenrowsAdapter.fetch(
			zenrows,
			call("basic"),
			fake(new Response("x")).fetchImpl,
		);
		expect(noFinal).toMatchObject({ finalUrl: TARGET });
	});

	it.each([
		[422, "RESP001", { outcome: "blocked", billed: false }],
		[400, "REQS002", { outcome: "blocked", billed: false }],
		[404, "RESP002", { outcome: "not-found", billed: true, status: 404 }],
		[404, "RESP007", { outcome: "not-found", billed: true }],
		[401, "AUTH001", { outcome: "provider-error", problem: "key" }],
		[401, "AUTH002", { outcome: "provider-error", problem: "key" }],
		[401, "AUTH003", { outcome: "provider-error", problem: "key" }],
		[402, "AUTH004", { outcome: "provider-error", problem: "credits" }],
		[402, "AUTH010", { outcome: "provider-error", problem: "credits" }],
		[402, "AUTH014", { outcome: "provider-error", problem: "credits" }],
		[403, "BLK0001", { outcome: "provider-error", problem: "blocked" }],
		[400, "REQS001", { outcome: "provider-error", billed: false }],
		[413, "RESP005", { outcome: "provider-error", billed: false }],
		[504, "CTX0002", { outcome: "provider-error", billed: false }],
		[500, "ERR0000", { outcome: "provider-error", billed: false }],
		[500, "ERR0001", { outcome: "provider-error", billed: false }],
		[400, "SOMETHING_NEW", { outcome: "provider-error", billed: false }],
	] as const)("maps HTTP %i %s", async (status, code, expected) => {
		const result = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(problem(status, code)).fetchImpl,
		);
		expect(result).toMatchObject(expected);
		expect(result.outcome).not.toBe("ok");
		if (result.outcome !== "ok") {
			expect(result.detail).toContain(code);
			expect(result.detail.startsWith("ZenRows: ")).toBe(true);
			if (!("problem" in expected)) expect(result.problem).toBeUndefined();
		}
	});

	it("charges a missing page what ZenRows reported", async () => {
		const result = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(problem(404, "RESP002", { "x-request-cost": "0.001" })).fetchImpl,
		);
		expect(result).toMatchObject({ costUsd: 0.001, billed: true });
	});

	it("never charges a block", async () => {
		const result = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(problem(422, "RESP001")).fetchImpl,
		);
		expect(result).toMatchObject({ costUsd: 0, billed: false });
	});

	it.each([
		["AUTH006", 429],
		["AUTH008", 429],
		["RESP009", 503],
	])("asks the ladder to back off on %s", async (code, status) => {
		const withHeader = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(problem(status, code, { "retry-after": "3" })).fetchImpl,
		);
		expect(withHeader).toMatchObject({
			outcome: "provider-error",
			retryAfterMs: 3000,
		});
		const without = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(problem(status, code)).fetchImpl,
		);
		expect(without).toMatchObject({ retryAfterMs: 10_000 });
	});

	it("treats a body without a code as a provider error", async () => {
		const result = await zenrowsAdapter.fetch(
			zenrows,
			call("auto"),
			fake(new Response("<html>bad gateway</html>", { status: 502 })).fetchImpl,
		);
		expect(result).toMatchObject({ outcome: "provider-error", billed: false });
		if (result.outcome !== "ok") expect(result.detail).toContain("HTTP 502");
	});

	it("needs a key", async () => {
		const { fetchImpl, seen } = fake(ok());
		const result = await zenrowsAdapter.fetch(
			{ ...zenrows, apiKey: undefined },
			call("auto"),
			fetchImpl,
		);
		expect(result).toMatchObject({ outcome: "provider-error", problem: "key" });
		expect(seen).toHaveLength(0);
	});

	it("reports the most a level can cost", () => {
		expect(zenrowsAdapter.maxCostUsd(zenrows, "auto")).toBeCloseTo(0.025);
		expect(zenrowsAdapter.maxCostUsd(zenrows, "render-premium")).toBeCloseTo(
			0.025,
		);
		expect(zenrowsAdapter.maxCostUsd(zenrows, "premium")).toBeCloseTo(0.01);
		expect(zenrowsAdapter.maxCostUsd(zenrows, "render")).toBeCloseTo(0.005);
		expect(zenrowsAdapter.maxCostUsd(zenrows, "basic")).toBeCloseTo(0.001);
	});
});

describe("cloudflare browser run", () => {
	const answer = (
		body: unknown,
		init: { status?: number; headers?: Record<string, string> } = {},
	) =>
		new Response(JSON.stringify(body), {
			status: init.status ?? 200,
			headers: {
				"content-type": "application/json",
				"x-browser-ms-used": "4000",
				...init.headers,
			},
		});

	it("posts the page to the markdown endpoint with the token", async () => {
		const { fetchImpl, seen } = fake(
			answer({ success: true, result: "# Hi", meta: { status: 200 } }),
		);
		await cloudflareAdapter.fetch(cloudflare, call("render"), fetchImpl);
		expect(seen[0].url).toBe(
			"https://api.cloudflare.com/client/v4/accounts/0123456789abcdef0123456789abcdef/browser-rendering/markdown",
		);
		expect(seen[0].init.method).toBe("POST");
		expect((seen[0].init.headers as Record<string, string>).authorization).toBe(
			`Bearer ${KEY}`,
		);
		expect(JSON.parse(String(seen[0].init.body))).toEqual({
			url: TARGET,
			gotoOptions: { waitUntil: "networkidle2", timeout: 60_000 },
			rejectResourceTypes: ["image", "media", "font"],
		});
	});

	it("asks for HTML from the content endpoint", async () => {
		const { fetchImpl, seen } = fake(
			answer({ success: true, result: "<p>Hi</p>", meta: { status: 200 } }),
		);
		const result = await cloudflareAdapter.fetch(
			{ ...cloudflare, baseUrl: "http://127.0.0.1:9000/" },
			call("render", "html"),
			fetchImpl,
		);
		expect(seen[0].url).toBe(
			"http://127.0.0.1:9000/accounts/0123456789abcdef0123456789abcdef/browser-rendering/content",
		);
		expect(result).toMatchObject({
			outcome: "ok",
			contentFormat: "html",
			content: "<p>Hi</p>",
			contentType: "text/html",
		});
	});

	it("returns the page and estimates browser time", async () => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(
				answer({
					success: true,
					result: "# Hi",
					meta: { status: 200, finalUrl: "https://shop.example.com/" },
				}),
			).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "ok",
			status: 200,
			finalUrl: "https://shop.example.com/",
			content: "# Hi",
			contentFormat: "markdown",
		});
		expect(result.costUsd).toBeCloseTo((4000 * 0.09) / 3_600_000, 10);
	});

	it("assumes 200 when the markdown endpoint leaves meta out", async () => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(answer({ success: true, result: "# Hi" })).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "ok",
			status: 200,
			finalUrl: TARGET,
		});
	});

	it.each([
		[404, "not-found"],
		[410, "not-found"],
		[401, "target-error"],
		[407, "target-error"],
		[403, "blocked"],
		[429, "blocked"],
		[503, "blocked"],
		[500, "target-error"],
		[302, "target-error"],
	] as const)("maps the site's %i to %s", async (status, outcome) => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(answer({ success: true, result: "x", meta: { status } })).fetchImpl,
		);
		expect(result).toMatchObject({ outcome, status, billed: true });
	});

	it.each([
		401, 403,
	])("flags a refused token on the provider's own %i", async (status) => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(
				answer(
					{ success: false, errors: [{ message: "Authentication error" }] },
					{ status, headers: { "x-browser-ms-used": "0" } },
				),
			).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "provider-error",
			problem: "key",
			billed: false,
			costUsd: 0,
		});
	});

	it("backs off on a rate limit", async () => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(
				answer(
					{ success: false },
					{ status: 429, headers: { "retry-after": "7" } },
				),
			).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "provider-error",
			retryAfterMs: 7000,
		});
	});

	it("reports a render that did not finish", async () => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(answer({ success: false }, { status: 422 })).fetchImpl,
		);
		expect(result).toMatchObject({ outcome: "provider-error", billed: true });
		if (result.outcome !== "ok") expect(result.detail).toContain("rendering");
	});

	it("treats other failures as provider errors", async () => {
		for (const response of [
			answer({ success: false }, { status: 500 }),
			new Response("not json"),
			answer({ success: false, result: null }),
		]) {
			const result = await cloudflareAdapter.fetch(
				cloudflare,
				call("render"),
				fake(response).fetchImpl,
			);
			expect(result.outcome).toBe("provider-error");
		}
	});

	it("does not charge when the browser never ran", async () => {
		const result = await cloudflareAdapter.fetch(
			cloudflare,
			call("render"),
			fake(new Response(JSON.stringify({ success: false }), { status: 500 }))
				.fetchImpl,
		);
		expect(result).toMatchObject({ billed: false, costUsd: 0 });
	});

	it("needs a token and an account ID", async () => {
		const { fetchImpl, seen } = fake(answer({ success: true, result: "x" }));
		expect(
			await cloudflareAdapter.fetch(
				{ ...cloudflare, accountId: undefined },
				call("render"),
				fetchImpl,
			),
		).toMatchObject({
			outcome: "provider-error",
			problem: "key",
			detail: "Cloudflare Browser Run: no account ID",
		});
		expect(
			await cloudflareAdapter.fetch(
				{ ...cloudflare, apiKey: undefined },
				call("render"),
				fetchImpl,
			),
		).toMatchObject({ problem: "key" });
		expect(seen).toHaveLength(0);
	});

	it("reserves 60 seconds of browser time", () => {
		expect(cloudflareAdapter.maxCostUsd(cloudflare, "render")).toBeCloseTo(
			0.0015,
		);
	});
});

describe("bright data", () => {
	const site = (body: string, headers: Record<string, string> = {}) =>
		new Response(body, {
			status: 200,
			headers: { "content-type": "text/plain", ...headers },
		});

	it("posts the zone, the URL, and markdown", async () => {
		const { fetchImpl, seen } = fake(
			site("# Hi", { "x-brd-status-code": "200" }),
		);
		await brightdataAdapter.fetch(
			{ ...brightdata, country: "US" },
			call("unlock"),
			fetchImpl,
		);
		expect(seen[0].url).toBe("https://api.brightdata.com/request");
		expect(seen[0].init.method).toBe("POST");
		expect((seen[0].init.headers as Record<string, string>).authorization).toBe(
			`Bearer ${KEY}`,
		);
		expect(JSON.parse(String(seen[0].init.body))).toEqual({
			zone: "web_unlocker1",
			url: TARGET,
			format: "raw",
			data_format: "markdown",
			country: "us",
		});
	});

	it("asks for raw HTML without data_format or a country", async () => {
		const { fetchImpl, seen } = fake(
			site("<p>Hi</p>", { "content-type": "text/html" }),
		);
		const result = await brightdataAdapter.fetch(
			{ ...brightdata, baseUrl: "http://127.0.0.1:9100" },
			call("unlock", "html"),
			fetchImpl,
		);
		expect(seen[0].url).toBe("http://127.0.0.1:9100/request");
		expect(JSON.parse(String(seen[0].init.body))).toEqual({
			zone: "web_unlocker1",
			url: TARGET,
			format: "raw",
		});
		expect(result).toMatchObject({ outcome: "ok", contentFormat: "html" });
	});

	it("returns the site's page at the plan's price", async () => {
		const result = await brightdataAdapter.fetch(
			{ ...brightdata, pricePer1000Usd: 2 },
			call("unlock"),
			fake(site("# Hi", { "x-brd-status-code": "200" })).fetchImpl,
		);
		expect(result).toEqual({
			outcome: "ok",
			status: 200,
			finalUrl: TARGET,
			contentType: "text/plain",
			content: "# Hi",
			contentFormat: "markdown",
			costUsd: 0.002,
		});
	});

	it.each([
		["reject_block", "blocked"],
		["resolve_failed_akamai_interstitial", "blocked"],
		["http_status", "blocked"],
		["navigation_timeout", "provider-error"],
		["net_err_cert_date_invalid", "provider-error"],
	] as const)("maps the unlock error %s", async (code, outcome) => {
		const result = await brightdataAdapter.fetch(
			brightdata,
			call("unlock"),
			fake(
				site("", {
					"x-brd-error": "Navigation failed",
					"x-brd-error-code": code,
					"x-brd-status-code": "502",
				}),
			).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome,
			status: 502,
			billed: false,
			costUsd: 0,
		});
		if (result.outcome !== "ok") expect(result.detail).toContain(code);
	});

	it("reads a proxy-level code too", async () => {
		const result = await brightdataAdapter.fetch(
			brightdata,
			call("unlock"),
			fake(
				site("", {
					"x-brd-error": "Policy",
					"x-brd-err-code": "policy_20050",
					"x-brd-status-code": "403",
				}),
			).fetchImpl,
		);
		expect(result).toMatchObject({ outcome: "provider-error", status: 403 });
	});

	it.each([
		[404, "not-found", true],
		[410, "not-found", true],
		[401, "target-error", false],
		[407, "target-error", false],
		[403, "blocked", false],
		[429, "blocked", false],
		[503, "blocked", false],
		[500, "target-error", false],
	] as const)("maps the site's own %i to %s", async (status, outcome, billed) => {
		const result = await brightdataAdapter.fetch(
			brightdata,
			call("unlock"),
			fake(site("page", { "x-brd-status-code": String(status) })).fetchImpl,
		);
		expect(result).toMatchObject({ outcome, status, billed });
		expect(result.costUsd).toBeCloseTo(billed ? 0.0015 : 0);
	});

	it.each([
		[401, { problem: "key" }],
		[402, { problem: "credits" }],
		[400, {}],
		[500, {}],
	] as const)("maps an outer %i", async (status, extra) => {
		const result = await brightdataAdapter.fetch(
			brightdata,
			call("unlock"),
			fake(new Response("nope", { status })).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "provider-error",
			billed: false,
			...extra,
		});
	});

	it("backs off on an outer 429", async () => {
		const result = await brightdataAdapter.fetch(
			brightdata,
			call("unlock"),
			fake(
				new Response("slow", { status: 429, headers: { "retry-after": "2" } }),
			).fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "provider-error",
			retryAfterMs: 2000,
		});
	});

	it("needs a zone", async () => {
		const { fetchImpl, seen } = fake(site("x"));
		const result = await brightdataAdapter.fetch(
			{ ...brightdata, zone: undefined },
			call("unlock"),
			fetchImpl,
		);
		expect(result).toMatchObject({
			outcome: "provider-error",
			detail: "Bright Data: no zone set",
		});
		expect(seen).toHaveLength(0);
	});

	it("reserves one request at the plan's price", () => {
		expect(brightdataAdapter.maxCostUsd(brightdata, "unlock")).toBeCloseTo(
			0.0015,
		);
		expect(
			brightdataAdapter.maxCostUsd(
				{ ...brightdata, pricePer1000Usd: 3 },
				"unlock",
			),
		).toBeCloseTo(0.003);
	});
});

describe("every adapter", () => {
	const cases = [
		[zenrowsAdapter, zenrows, "auto"],
		[cloudflareAdapter, cloudflare, "render"],
		[brightdataAdapter, brightdata, "unlock"],
	] as const;

	it.each(
		cases,
	)("reports an abort as a timeout ($kind)", async (adapter, config, level) => {
		const controller = new AbortController();
		const fetchImpl: FetchLike = async (_input, init) => {
			controller.abort();
			throw init?.signal?.reason ?? new Error("aborted");
		};
		const result = await adapter.fetch(
			config,
			call(level, "markdown", controller.signal),
			fetchImpl,
		);
		expect(result).toMatchObject({ outcome: "timeout", billed: false });
	});

	it.each(
		cases,
	)("passes the call's signal ($kind)", async (adapter, config, level) => {
		const controller = new AbortController();
		const { fetchImpl, seen } = fake(new Response("{}"));
		await adapter.fetch(
			config,
			call(level, "markdown", controller.signal),
			fetchImpl,
		);
		expect(seen[0].init.signal).toBe(controller.signal);
	});

	it("never puts the key in a result, whatever goes wrong", async () => {
		const results: StepResult[] = [];
		const throwing: FetchLike = async (input) => {
			throw new Error(
				`connect ECONNREFUSED while fetching ${String(input)} key=${KEY}`,
			);
		};
		const abortController = new AbortController();
		abortController.abort();
		const answers: Array<() => Response> = [
			() => problem(422, "RESP001"),
			() => problem(404, "RESP002"),
			() => problem(401, "AUTH002"),
			() => problem(402, "AUTH004"),
			() => problem(429, "AUTH006"),
			() => problem(403, "BLK0001"),
			() => problem(500, "ERR0001"),
			() => new Response(`echo ${KEY}`, { status: 502 }),
			() =>
				new Response(JSON.stringify({ success: false, errors: [KEY] }), {
					status: 401,
				}),
			() => new Response(JSON.stringify({ success: false }), { status: 422 }),
			() =>
				new Response(
					JSON.stringify({ success: true, result: "x", meta: { status: 403 } }),
				),
			() => new Response("nope", { status: 401 }),
			() => new Response("nope", { status: 402 }),
			() =>
				new Response("", {
					headers: { "x-brd-error": "x", "x-brd-error-code": "reject_block" },
				}),
		];
		for (const [adapter, config, level] of cases) {
			results.push(await adapter.fetch(config, call(level), throwing));
			results.push(
				await adapter.fetch(
					config,
					call(level, "markdown", abortController.signal),
					throwing,
				),
			);
			for (const answer of answers)
				results.push(
					await adapter.fetch(config, call(level), fake(answer).fetchImpl),
				);
		}
		const reachable = results.filter(
			(result) =>
				result.outcome === "provider-error" &&
				result.detail.includes("could not be reached"),
		);
		expect(reachable).toHaveLength(3);
		for (const result of results) {
			if (result.outcome === "ok") continue;
			expect(JSON.stringify(result)).not.toContain(KEY);
			expect(JSON.stringify(result)).not.toContain("apikey=");
		}
	});
});
