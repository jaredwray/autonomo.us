import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import {
	type DirectTransport,
	directFetch,
	fetchTransport,
	nodeTransport,
	type TransportRequest,
} from "../src/web/direct.js";
import type { Resolver } from "../src/web/url-guard.js";

type Fake = {
	status: number;
	headers?: Record<string, string>;
	body?: string | Uint8Array | Uint8Array[];
	/** Never answers until the request is aborted. */
	hang?: boolean;
	error?: Error;
};

const encoder = new TextEncoder();

/** A transport that answers from a table keyed by URL, recording each request. */
function fakeTransport(
	routes: Record<string, Fake | Fake[]>,
	pinsAddress = true,
) {
	const requests: TransportRequest[] = [];
	const counts = new Map<string, number>();
	const send = async (request: TransportRequest) => {
		requests.push(request);
		const key = request.url.href;
		const entry = routes[key];
		if (!entry)
			throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" });
		const count = counts.get(key) ?? 0;
		counts.set(key, count + 1);
		const fake = Array.isArray(entry)
			? entry[Math.min(count, entry.length - 1)]
			: entry;
		if (fake.error) throw fake.error;
		if (fake.hang)
			await new Promise((_, reject) =>
				request.signal.addEventListener("abort", () =>
					reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
				),
			);
		const chunks =
			fake.body === undefined
				? []
				: Array.isArray(fake.body)
					? fake.body
					: [
							typeof fake.body === "string"
								? encoder.encode(fake.body)
								: fake.body,
						];
		let cancelled = false;
		return {
			status: fake.status,
			headers: new Headers(fake.headers ?? { "content-type": "text/html" }),
			body: (async function* () {
				for (const chunk of chunks) {
					if (cancelled) return;
					yield chunk;
				}
			})(),
			cancel: () => {
				cancelled = true;
			},
		};
	};
	const transport: DirectTransport = Object.assign(send, { pinsAddress });
	return { transport, requests };
}

const publicResolver: Resolver = async (host) => {
	if (host === "private.example") return [{ address: "10.0.0.9", family: 4 }];
	if (host === "missing.example")
		throw Object.assign(new Error("not found"), { code: "ENOTFOUND" });
	return [{ address: "93.184.215.14", family: 4 }];
};

const page = `<html><body><main>${"<p>Readable words for the reader, enough of them to count as content.</p>".repeat(30)}</main></body></html>`;

const run = (
	url: string,
	transport: DirectTransport,
	extra: Partial<Parameters<typeof directFetch>[1]> = {},
) =>
	directFetch(new URL(url), {
		signal: new AbortController().signal,
		transport,
		resolver: publicResolver,
		...extra,
	});

describe("directFetch", () => {
	it("returns a readable page with the address it checked", async () => {
		const { transport, requests } = fakeTransport({
			"https://example.com/": { status: 200, body: page },
		});
		const result = await run("https://example.com/", transport);
		expect(result).toMatchObject({
			outcome: "ok",
			status: 200,
			finalUrl: "https://example.com/",
			contentType: "text/html",
			contentFormat: "html",
			costUsd: 0,
		});
		expect(requests[0].address).toEqual({
			address: "93.184.215.14",
			family: 4,
		});
		expect(requests[0].headers["user-agent"]).toContain(
			"autonomo.us-web-fetch",
		);
		expect(requests[0].headers.accept).toContain("text/html");
	});

	it("follows redirects and checks every hop", async () => {
		const { transport, requests } = fakeTransport({
			"https://example.com/old": {
				status: 301,
				headers: { location: "/new" },
			},
			"https://example.com/new": {
				status: 302,
				headers: { location: "https://www.example.com/final" },
			},
			"https://www.example.com/final": { status: 200, body: page },
		});
		const result = await run("https://example.com/old", transport);
		expect(result).toMatchObject({
			outcome: "ok",
			finalUrl: "https://www.example.com/final",
		});
		expect(requests.map((request) => request.url.href)).toEqual([
			"https://example.com/old",
			"https://example.com/new",
			"https://www.example.com/final",
		]);
	});

	it("refuses a redirect to a private address", async () => {
		const { transport, requests } = fakeTransport({
			"https://example.com/": {
				status: 302,
				headers: { location: "http://127.0.0.1:8080/admin" },
			},
		});
		expect(await run("https://example.com/", transport)).toMatchObject({
			outcome: "target-error",
			detail: "redirected to a blocked address",
			billed: false,
		});
		expect(requests).toHaveLength(1);
	});

	it("refuses a redirect to a host that resolves privately", async () => {
		const { transport, requests } = fakeTransport({
			"https://example.com/": {
				status: 307,
				headers: { location: "https://private.example/" },
			},
		});
		expect(await run("https://example.com/", transport)).toMatchObject({
			outcome: "target-error",
			detail: "redirected to a blocked address",
		});
		expect(requests).toHaveLength(1);
	});

	it("refuses a first host that resolves privately", async () => {
		const { transport, requests } = fakeTransport({});
		expect(await run("https://private.example/", transport)).toMatchObject({
			outcome: "target-error",
			detail: "the host resolves to a private address",
		});
		expect(requests).toHaveLength(0);
	});

	it("calls a host that does not exist not found", async () => {
		const { transport } = fakeTransport({});
		expect(await run("https://missing.example/", transport)).toMatchObject({
			outcome: "not-found",
		});
	});

	it("stops after too many redirects", async () => {
		const { transport } = fakeTransport({
			"https://example.com/loop": {
				status: 302,
				headers: { location: "/loop" },
			},
		});
		expect(
			await run("https://example.com/loop", transport, { maxRedirects: 3 }),
		).toMatchObject({ outcome: "target-error", detail: "too many redirects" });
	});

	it("reads at most maxBytes", async () => {
		const { transport } = fakeTransport({
			"https://example.com/big": {
				status: 200,
				headers: { "content-type": "text/plain" },
				body: [
					encoder.encode("a".repeat(600)),
					encoder.encode("b".repeat(600)),
				],
			},
		});
		const result = await run("https://example.com/big", transport, {
			maxBytes: 1000,
		});
		expect(result).toMatchObject({
			outcome: "ok",
			contentFormat: "text",
			detail: "cut at the size limit",
		});
		if (result.outcome === "ok") expect(result.content).toHaveLength(1000);
	});

	it("refuses binary content without reading it", async () => {
		const { transport } = fakeTransport({
			"https://example.com/file.pdf": {
				status: 200,
				headers: { "content-type": "application/pdf" },
				body: "%PDF-1.7",
			},
		});
		expect(await run("https://example.com/file.pdf", transport)).toMatchObject({
			outcome: "target-error",
			detail: "binary content (application/pdf)",
		});
	});

	it("decodes the charset the response names", async () => {
		const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]); // "café"
		const { transport } = fakeTransport({
			"https://example.com/header": {
				status: 200,
				headers: { "content-type": "text/plain; charset=ISO-8859-1" },
				body: latin1,
			},
			"https://example.com/meta": {
				status: 200,
				headers: { "content-type": "text/html" },
				body: Uint8Array.from([
					...encoder.encode(
						'<html><head><meta charset="windows-1252"></head><body>',
					),
					0x93,
					0x68,
					0x69,
					0x94,
					...encoder.encode("</body></html>"),
				]),
			},
		});
		const header = await run("https://example.com/header", transport);
		expect(header.outcome === "ok" && header.content).toBe("café");
		const meta = await run("https://example.com/meta", transport);
		expect(meta.outcome === "ok" && meta.content).toContain("“hi”");
	});

	it("retries a 5xx once, then calls it a block", async () => {
		const { transport, requests } = fakeTransport({
			"https://example.com/flaky": [
				{ status: 502, body: "bad gateway" },
				{ status: 200, body: page },
			],
			"https://example.com/down": { status: 500, body: "oops" },
		});
		expect(await run("https://example.com/flaky", transport)).toMatchObject({
			outcome: "ok",
		});
		expect(await run("https://example.com/down", transport)).toMatchObject({
			outcome: "blocked",
			detail: "the site returned 500 twice",
			status: 500,
		});
		expect(requests).toHaveLength(4);
	});

	it("classifies blocks and pages that need JavaScript", async () => {
		const { transport } = fakeTransport({
			"https://example.com/cf": {
				status: 403,
				headers: { "content-type": "text/html", "cf-mitigated": "challenge" },
				body: "<title>Just a moment...</title>",
			},
			"https://example.com/spa": {
				status: 200,
				body: '<html><body><div id="root"></div><script src="/app.js"></script></body></html>',
			},
			"https://example.com/gone": { status: 404, body: "nope" },
		});
		expect(await run("https://example.com/cf", transport)).toMatchObject({
			outcome: "blocked",
			detail: "Cloudflare challenge",
			status: 403,
			billed: false,
			costUsd: 0,
		});
		expect(await run("https://example.com/spa", transport)).toMatchObject({
			outcome: "needs-render",
		});
		expect(await run("https://example.com/gone", transport)).toMatchObject({
			outcome: "not-found",
			status: 404,
		});
	});

	it("calls a hop that takes too long a block", async () => {
		const { transport } = fakeTransport({
			"https://example.com/slow": { status: 200, hang: true },
		});
		expect(
			await run("https://example.com/slow", transport, { hopTimeoutMs: 30 }),
		).toMatchObject({ outcome: "blocked", detail: "timed out after 0 s" });
	});

	it("reports the whole fetch's deadline as a timeout", async () => {
		const { transport } = fakeTransport({
			"https://example.com/slow": { status: 200, hang: true },
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		expect(
			await directFetch(new URL("https://example.com/slow"), {
				signal: controller.signal,
				transport,
				resolver: publicResolver,
			}),
		).toMatchObject({ outcome: "timeout" });
	});

	it("calls a connection failure a block and names its code", async () => {
		const { transport } = fakeTransport({
			"https://example.com/tls": {
				status: 0,
				error: Object.assign(new Error("cert"), {
					code: "CERT_HAS_EXPIRED",
				}),
			},
		});
		expect(await run("https://example.com/reset", transport)).toMatchObject({
			outcome: "blocked",
			detail: "connection failed (ECONNREFUSED)",
		});
		expect(await run("https://example.com/tls", transport)).toMatchObject({
			outcome: "blocked",
			detail: "TLS error (CERT_HAS_EXPIRED)",
		});
	});

	it("skips the DNS check when the transport cannot pin an address", async () => {
		const { transport, requests } = fakeTransport(
			{ "https://private.example/": { status: 200, body: page } },
			false,
		);
		expect(await run("https://private.example/", transport)).toMatchObject({
			outcome: "ok",
		});
		expect(requests[0].address).toBeNull();
	});
});

describe("transports", () => {
	let server: Server | undefined;
	afterEach(async () => {
		if (server) {
			server.close();
			await once(server, "close");
			server = undefined;
		}
	});

	const listen = async (handler: Parameters<typeof createServer>[1]) => {
		server = createServer(handler);
		server.listen(0, "127.0.0.1");
		await once(server, "listening");
		return (server.address() as AddressInfo).port;
	};

	const readAll = async (body: AsyncIterable<Uint8Array> | null) => {
		const chunks: Uint8Array[] = [];
		if (body) for await (const chunk of body) chunks.push(chunk);
		return Buffer.concat(chunks).toString("utf8");
	};

	it("connects to the pinned address, not what the name resolves to", async () => {
		const port = await listen((request, response) => {
			response.setHeader("content-type", "text/plain");
			response.end(`host=${request.headers.host}`);
		});
		// example.test does not resolve; only the pinned address can be reached.
		const response = await nodeTransport()({
			url: new URL(`http://example.test:${port}/x`),
			address: { address: "127.0.0.1", family: 4 },
			signal: new AbortController().signal,
			headers: { "user-agent": "test" },
		});
		expect(response.status).toBe(200);
		expect(await readAll(response.body)).toBe(`host=example.test:${port}`);
		expect(nodeTransport().pinsAddress).toBe(true);
	});

	it("decompresses a gzip response and does not follow redirects", async () => {
		const port = await listen((request, response) => {
			if (request.url === "/moved") {
				response.writeHead(302, { location: "/elsewhere" });
				response.end();
				return;
			}
			response.writeHead(200, {
				"content-type": "text/html",
				"content-encoding": "gzip",
			});
			response.end(gzipSync("<p>zipped</p>"));
		});
		const transport = nodeTransport();
		const request = (path: string) =>
			transport({
				url: new URL(`http://example.test:${port}${path}`),
				address: { address: "127.0.0.1", family: 4 },
				signal: new AbortController().signal,
				headers: {},
			});
		const zipped = await request("/");
		expect(zipped.headers.get("content-encoding")).toBeNull();
		expect(await readAll(zipped.body)).toBe("<p>zipped</p>");
		const moved = await request("/moved");
		expect(moved.status).toBe(302);
		expect(moved.headers.get("location")).toBe("/elsewhere");
		moved.cancel();
	});

	it("uses fetch with manual redirects for the Worker", async () => {
		const seen: RequestInit[] = [];
		const transport = fetchTransport(async (_input, init) => {
			seen.push(init ?? {});
			return new Response("hello", {
				status: 200,
				headers: { "content-type": "text/plain" },
			});
		});
		expect(transport.pinsAddress).toBe(false);
		const response = await transport({
			url: new URL("https://example.com/"),
			address: null,
			signal: new AbortController().signal,
			headers: { accept: "*/*" },
		});
		expect(seen[0].redirect).toBe("manual");
		expect(await readAll(response.body)).toBe("hello");
		response.cancel();
	});
});

describe("direct fetch time and redirect rules", () => {
	it("stops waiting for a lookup that never answers", async () => {
		const { transport, requests } = fakeTransport({
			"https://slow.example/": { status: 200, body: page },
		});
		const stalled: Resolver = () => new Promise(() => {});
		const started = Date.now();
		const result = await directFetch(new URL("https://slow.example/"), {
			signal: new AbortController().signal,
			transport,
			resolver: stalled,
			hopTimeoutMs: 50,
		});
		expect(result).toMatchObject({ outcome: "blocked" });
		expect(result.outcome === "ok" ? "" : result.detail).toContain("timed out");
		expect(Date.now() - started).toBeLessThan(2000);
		expect(requests).toEqual([]);
	});

	it("reports the deadline when the fetch is cancelled during a lookup", async () => {
		const { transport } = fakeTransport({});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);
		const result = await directFetch(new URL("https://slow.example/"), {
			signal: controller.signal,
			transport,
			resolver: () => new Promise(() => {}),
			hopTimeoutMs: 10_000,
		});
		expect(result.outcome).toBe("timeout");
	});

	it("refuses a redirect the workspace's rules refuse, before requesting it", async () => {
		const { transport, requests } = fakeTransport({
			"https://allowed.example/": {
				status: 302,
				headers: { location: "https://denied.example/secret" },
			},
			"https://denied.example/secret": { status: 200, body: page },
		});
		const result = await directFetch(new URL("https://allowed.example/"), {
			signal: new AbortController().signal,
			transport,
			resolver: publicResolver,
			allowHop: (next) =>
				next.hostname === "denied.example"
					? "denied.example is blocked."
					: null,
		});
		expect(result).toMatchObject({
			outcome: "target-error",
			detail: "denied.example is blocked.",
		});
		expect(requests.map((request) => request.url.href)).toEqual([
			"https://allowed.example/",
		]);
	});
});
