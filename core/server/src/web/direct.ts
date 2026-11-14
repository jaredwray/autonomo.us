import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { isIP } from "node:net";
import { pipeline } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { ServiceError } from "../service-error.js";
import { classifyResponse } from "./classify.js";
import type { FetchLike, StepFailure, StepResult } from "./types.js";
import {
	checkTargetUrl,
	type ResolvedAddress,
	type Resolver,
	resolvePublicAddress,
	systemResolver,
	TargetNotFoundError,
} from "./url-guard.js";

/**
 * The plain request: the free first step of the ladder. It follows redirects
 * by hand so every hop is checked again, connects to the address it checked
 * (on Node), and reads at most a fixed number of bytes.
 */

export type TransportRequest = {
	url: URL;
	/** The checked address to connect to; null when the transport cannot pin one. */
	address: ResolvedAddress | null;
	signal: AbortSignal;
	headers: Record<string, string>;
};

export type TransportResponse = {
	status: number;
	headers: Headers;
	/** The body, already decompressed, as chunks. */
	body: AsyncIterable<Uint8Array> | null;
	/** Stops reading and releases the connection. Safe to call more than once. */
	cancel: () => void;
};

/**
 * Sends one request without following redirects. `pinsAddress` says whether
 * the transport connects to the address it is given; one that cannot (the
 * Worker's fetch) is never given one, and the fetch skips the DNS check.
 */
export type DirectTransport = ((
	request: TransportRequest,
) => Promise<TransportResponse>) & { readonly pinsAddress: boolean };

export type DirectOptions = {
	/** Aborted at the whole fetch's deadline. */
	signal: AbortSignal;
	transport: DirectTransport;
	resolver?: Resolver;
	maxBytes?: number;
	hopTimeoutMs?: number;
	maxRedirects?: number;
	userAgent?: string;
};

export const DIRECT_DEFAULTS = {
	maxBytes: 5 * 1024 * 1024,
	hopTimeoutMs: 15_000,
	maxRedirects: 5,
	userAgent: "Mozilla/5.0 (compatible; autonomo.us-web-fetch/1.0)",
} as const;

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/**
 * Node's HTTP client, connecting to the checked address whatever DNS says by
 * the time the socket opens, so an answer cannot change between the check and
 * the connection. TLS still verifies the certificate against the host name.
 */
export function nodeTransport(): DirectTransport {
	const send = (request: TransportRequest) =>
		new Promise<TransportResponse>((resolve, reject) => {
			const { url, address, signal } = request;
			const secure = url.protocol === "https:";
			const host = url.hostname.replace(/^\[|\]$/g, "");
			const lookup: LookupFunction | undefined = address
				? (_hostname, options, callback) => {
						if ((options as { all?: boolean }).all)
							(callback as (error: null, addresses: ResolvedAddress[]) => void)(
								null,
								[address],
							);
						else callback(null, address.address, address.family);
					}
				: undefined;
			const client = (secure ? httpsRequest : httpRequest)(
				url,
				{
					method: "GET",
					headers: {
						...request.headers,
						"accept-encoding": "gzip, deflate, br",
					},
					agent: false,
					signal,
					...(lookup ? { lookup } : {}),
					...(secure && !isIP(host) ? { servername: host } : {}),
				},
				(response) => {
					const encoding = String(
						response.headers["content-encoding"] ?? "",
					).toLowerCase();
					const decoder =
						encoding === "gzip" || encoding === "x-gzip"
							? createGunzip()
							: encoding === "deflate"
								? createInflate()
								: encoding === "br"
									? createBrotliDecompress()
									: undefined;
					const headers = toHeaders(response.headers);
					if (decoder) {
						headers.delete("content-encoding");
						headers.delete("content-length");
					}
					const body = decoder
						? pipeline(response, decoder, () => {})
						: response;
					resolve({
						status: response.statusCode ?? 0,
						headers,
						body,
						cancel: () => {
							body.destroy();
							response.destroy();
						},
					});
				},
			);
			client.on("error", reject);
			client.end();
		});
	return Object.assign(send, { pinsAddress: true as const });
}

/**
 * The Worker's fetch. Workers cannot choose the address a request connects
 * to, so this transport is never given one; the Worker relies on
 * `checkTargetUrl` and on Cloudflare's network, which cannot reach the
 * deployment's private network.
 */
export function fetchTransport(fetchImpl?: FetchLike): DirectTransport {
	const send = async (
		request: TransportRequest,
	): Promise<TransportResponse> => {
		const response = await (fetchImpl ?? fetch)(request.url, {
			method: "GET",
			headers: request.headers,
			redirect: "manual",
			signal: request.signal,
		});
		const stream = response.body;
		if (!stream)
			return {
				status: response.status,
				headers: response.headers,
				body: null,
				cancel: () => {},
			};
		const reader = stream.getReader();
		let done = false;
		const cancel = () => {
			if (done) return;
			done = true;
			reader.cancel().catch(() => {});
		};
		async function* chunks() {
			try {
				while (true) {
					const next = await reader.read();
					if (next.done) {
						done = true;
						return;
					}
					yield next.value;
				}
			} finally {
				cancel();
			}
		}
		return {
			status: response.status,
			headers: response.headers,
			body: chunks(),
			cancel,
		};
	};
	return Object.assign(send, { pinsAddress: false as const });
}

function toHeaders(raw: IncomingHttpHeaders): Headers {
	const headers = new Headers();
	for (const [name, value] of Object.entries(raw)) {
		if (value === undefined) continue;
		for (const item of Array.isArray(value) ? value : [value]) {
			try {
				headers.append(name, item);
			} catch {
				// A header the Fetch standard refuses is not one the classifier needs.
			}
		}
	}
	return headers;
}

const failure = (
	outcome: StepFailure["outcome"],
	detail: string,
	status: number | null = null,
): StepFailure => ({ outcome, status, costUsd: 0, detail, billed: false });

class HopTimeout extends Error {}

/** Fetches a URL the caller already passed through `checkTargetUrl`. */
export async function directFetch(
	url: URL,
	options: DirectOptions,
): Promise<StepResult> {
	const { signal, transport } = options;
	const resolver = options.resolver ?? systemResolver;
	const maxBytes = options.maxBytes ?? DIRECT_DEFAULTS.maxBytes;
	const hopTimeoutMs = options.hopTimeoutMs ?? DIRECT_DEFAULTS.hopTimeoutMs;
	const maxRedirects = options.maxRedirects ?? DIRECT_DEFAULTS.maxRedirects;
	const headers = {
		"user-agent": options.userAgent ?? DIRECT_DEFAULTS.userAgent,
		accept:
			"text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
		"accept-language": "en-US,en;q=0.9",
	};
	let current = url;
	let redirects = 0;
	let retried = false;
	while (true) {
		if (signal.aborted) return failure("timeout", "the fetch ran out of time");
		let address: ResolvedAddress | null = null;
		if (transport.pinsAddress) {
			try {
				address = await resolvePublicAddress(current.hostname, resolver);
			} catch (error) {
				if (error instanceof TargetNotFoundError)
					return failure("not-found", error.message);
				if (error instanceof ServiceError && error.statusCode === 400)
					return failure(
						"target-error",
						redirects
							? "redirected to a blocked address"
							: "the host resolves to a private address",
					);
				return failure("target-error", `could not look up ${current.hostname}`);
			}
		}
		const hop = await fetchHop(current, address, {
			transport,
			signal,
			headers,
			hopTimeoutMs,
			maxBytes,
		});
		if (hop.kind === "failure") return hop.failure;
		const { status, response } = hop;
		if (REDIRECTS.has(status)) {
			const location = response.headers.get("location");
			if (location) {
				if (redirects >= maxRedirects)
					return failure("target-error", "too many redirects", status);
				let next: URL;
				try {
					next = checkTargetUrl(new URL(location, current).href);
				} catch {
					return failure(
						"target-error",
						"redirected to a blocked address",
						status,
					);
				}
				redirects++;
				current = next;
				continue;
			}
		}
		const contentType = response.headers.get("content-type") ?? "";
		const type = contentType.split(";")[0].trim().toLowerCase();
		const classification = classifyResponse({
			status,
			headers: response.headers,
			body: hop.text,
			contentType,
		});
		if (classification.outcome === "ok") {
			if (hop.binary)
				return failure("target-error", `binary content (${type})`, status);
			return {
				outcome: "ok",
				status,
				finalUrl: current.href,
				contentType: type || "text/html",
				content: hop.text,
				contentFormat: isHtml(type, hop.text) ? "html" : "text",
				costUsd: 0,
				...(hop.truncated ? { detail: "cut at the size limit" } : {}),
			};
		}
		if (classification.outcome === "target-error" && status >= 500) {
			if (!retried) {
				retried = true;
				continue;
			}
			return failure("blocked", `the site returned ${status} twice`, status);
		}
		return failure(classification.outcome, classification.detail, status);
	}
}

type Hop =
	| { kind: "failure"; failure: StepFailure }
	| {
			kind: "response";
			status: number;
			response: TransportResponse;
			text: string;
			binary: boolean;
			truncated: boolean;
	  };

/** One request and its body, inside the hop's own time limit. */
async function fetchHop(
	url: URL,
	address: ResolvedAddress | null,
	options: {
		transport: DirectTransport;
		signal: AbortSignal;
		headers: Record<string, string>;
		hopTimeoutMs: number;
		maxBytes: number;
	},
): Promise<Hop> {
	const controller = new AbortController();
	const onAbort = () => controller.abort(options.signal.reason);
	options.signal.addEventListener("abort", onAbort, { once: true });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		controller.abort(new HopTimeout());
	}, options.hopTimeoutMs);
	let response: TransportResponse | undefined;
	try {
		response = await options.transport({
			url,
			address,
			signal: controller.signal,
			headers: options.headers,
		});
		const { status } = response;
		if (REDIRECTS.has(status) && response.headers.get("location")) {
			response.cancel();
			return {
				kind: "response",
				status,
				response,
				text: "",
				binary: false,
				truncated: false,
			};
		}
		const contentType = response.headers.get("content-type") ?? "";
		const binary = isBinary(contentType);
		if (binary) {
			response.cancel();
			return {
				kind: "response",
				status,
				response,
				text: "",
				binary,
				truncated: false,
			};
		}
		const { bytes, truncated } = await readBody(
			response.body,
			options.maxBytes,
		);
		response.cancel();
		return {
			kind: "response",
			status,
			response,
			text: decode(bytes, contentType),
			binary: false,
			truncated,
		};
	} catch (error) {
		response?.cancel();
		if (options.signal.aborted)
			return {
				kind: "failure",
				failure: failure("timeout", "the fetch ran out of time"),
			};
		if (timedOut)
			return {
				kind: "failure",
				failure: failure(
					"blocked",
					`timed out after ${Math.round(options.hopTimeoutMs / 1000)} s`,
				),
			};
		const code = (error as { code?: unknown }).code;
		const tls =
			typeof code === "string" &&
			(code.includes("CERT") || code.includes("TLS") || code.includes("SSL"));
		return {
			kind: "failure",
			failure: failure(
				"blocked",
				tls
					? `TLS error (${code})`
					: typeof code === "string"
						? `connection failed (${code})`
						: "connection failed",
			),
		};
	} finally {
		clearTimeout(timer);
		options.signal.removeEventListener("abort", onAbort);
	}
}

/** HTML by its type, or by its first character when the site sent no type. */
function isHtml(type: string, text: string): boolean {
	if (type === "text/html" || type === "application/xhtml+xml") return true;
	return type === "" && text.trimStart().startsWith("<");
}

/** Types a page is never in. Anything else is read as text. */
function isBinary(contentType: string): boolean {
	const type = contentType.split(";")[0].trim().toLowerCase();
	if (!type) return false;
	if (type.startsWith("text/")) return false;
	if (
		type.endsWith("+json") ||
		type.endsWith("+xml") ||
		type === "application/json" ||
		type === "application/xml" ||
		type === "application/javascript" ||
		type === "application/ecmascript" ||
		type === "application/x-javascript"
	)
		return false;
	return true;
}

async function readBody(
	body: AsyncIterable<Uint8Array> | null,
	maxBytes: number,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	if (!body) return { bytes: new Uint8Array(0), truncated: false };
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	for await (const chunk of body) {
		const room = maxBytes - total;
		if (chunk.byteLength > room) {
			chunks.push(chunk.subarray(0, room));
			total += room;
			truncated = true;
			break;
		}
		chunks.push(chunk);
		total += chunk.byteLength;
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/**
 * Decodes with the charset the response names, or a `<meta charset>` near the
 * top of an HTML page, falling back to UTF-8.
 */
function decode(bytes: Uint8Array, contentType: string): string {
	let charset = /charset\s*=\s*"?([\w.:-]+)/i.exec(contentType)?.[1];
	if (!charset) {
		const head = new TextDecoder("latin1").decode(bytes.subarray(0, 2048));
		charset = /<meta[^>]{0,200}?charset\s*=\s*["']?([\w.:-]+)/i.exec(head)?.[1];
	}
	try {
		return new TextDecoder(charset ?? "utf-8").decode(bytes);
	} catch {
		return new TextDecoder("utf-8").decode(bytes);
	}
}
