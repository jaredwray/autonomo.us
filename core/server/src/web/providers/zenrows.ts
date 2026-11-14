import type { ProxyLevel } from "@autonomo.us/common";
import type {
	FetchLike,
	ProxyAdapter,
	ProxyCall,
	ProxyConfig,
	StepFailure,
	StepResult,
} from "../types.js";
import { ResponseTooLarge, readLimited } from "./read.js";

const ENDPOINT = "https://api.zenrows.com";
/** ZenRows bills in credits; `X-Request-Cost` reports the charge in USD at this rate. */
const USD_PER_CREDIT = 0.001;
/** Credits a request costs at each fixed level. `auto` bills whichever one worked. */
const CREDITS: Record<string, number> = {
	basic: 1,
	render: 5,
	premium: 10,
	"render-premium": 25,
	auto: 25,
};
/** How long to leave ZenRows alone after a concurrency or rate limit without `Retry-After`. */
const DEFAULT_RETRY_MS = 10_000;

/** `proxy_country` is valid only with premium proxies or `mode=auto`. */
const COUNTRY_LEVELS = new Set<ProxyLevel>([
	"auto",
	"premium",
	"render-premium",
]);

/** The query each level sends. `mode=auto` must never travel with `js_render` or `premium_proxy`. */
function levelParams(level: ProxyLevel): Record<string, string> {
	switch (level) {
		case "auto":
			return { mode: "auto" };
		case "render":
			return { js_render: "true" };
		case "premium":
			return { premium_proxy: "true" };
		case "render-premium":
			return { js_render: "true", premium_proxy: "true" };
		default:
			return {};
	}
}

/** The charge ZenRows reported, or what the level costs when it did not say. */
function costOf(response: Response, level: ProxyLevel): number {
	const usd = Number.parseFloat(response.headers.get("x-request-cost") ?? "");
	if (Number.isFinite(usd) && usd >= 0) return usd;
	const credits = Number.parseFloat(
		response.headers.get("x-request-credits") ?? "",
	);
	if (Number.isFinite(credits) && credits >= 0) return credits * USD_PER_CREDIT;
	return (CREDITS[level] ?? 1) * USD_PER_CREDIT;
}

function retryAfterMs(response: Response): number {
	const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: DEFAULT_RETRY_MS;
}

/** The `code` of ZenRows' RFC 9457 problem body, or null when it sent none. */
function problemCode(body: string): string | null {
	try {
		const parsed = JSON.parse(body) as { code?: unknown };
		return typeof parsed.code === "string" ? parsed.code : null;
	} catch {
		return null;
	}
}

function failure(
	outcome: StepFailure["outcome"],
	detail: string,
	extra: Partial<StepFailure> = {},
): StepFailure {
	return {
		outcome,
		status: null,
		costUsd: 0,
		detail: `ZenRows: ${detail}`,
		billed: false,
		...extra,
	};
}

/**
 * An error answer too large to read for its `code`. A missing page (404,
 * `RESP002`) is billed; otherwise it is billed only when ZenRows reported
 * a charge, so a hold is kept whenever money may have been spent.
 */
function oversizedError(response: Response, level: ProxyLevel): StepFailure {
	const detail = `an error answer larger than 5 MB (HTTP ${response.status})`;
	if (response.status === 404)
		return failure("not-found", "the page does not exist", {
			billed: true,
			costUsd: costOf(response, level),
		});
	// The same signals the error codes carry, read from the status.
	if (response.status === 401)
		return failure("provider-error", detail, { problem: "key" });
	if (response.status === 402)
		return failure("provider-error", detail, { problem: "credits" });
	if (response.status === 429 || response.status === 503)
		return failure("provider-error", detail, {
			retryAfterMs: retryAfterMs(response),
		});
	const charged = Number.parseFloat(
		response.headers.get("x-request-cost") ?? "",
	);
	const billed = Number.isFinite(charged) && charged > 0;
	return failure(
		"provider-error",
		detail,
		billed ? { billed, costUsd: charged } : {},
	);
}

/** What a ZenRows error means for the ladder, from its `code`, never from the status alone. */
function errorResult(
	response: Response,
	code: string | null,
	level: ProxyLevel,
): StepFailure {
	const tag = code ? ` (${code})` : ` (HTTP ${response.status})`;
	switch (code) {
		case "RESP001":
			return failure("blocked", `the site blocked the request${tag}`);
		case "REQS002":
			return failure(
				"blocked",
				`the site needs rendering or premium proxies${tag}`,
			);
		// ZenRows bills both: the page, or the whole domain, does not exist.
		case "RESP002":
			return failure("not-found", `the page was not found${tag}`, {
				status: 404,
				costUsd: costOf(response, level),
				billed: true,
			});
		case "RESP007":
			return failure("not-found", `the site's domain does not resolve${tag}`, {
				costUsd: costOf(response, level),
				billed: true,
			});
		case "AUTH001":
		case "AUTH002":
		case "AUTH003":
			return failure("provider-error", `the API key was refused${tag}`, {
				problem: "key",
			});
		case "AUTH004":
		case "AUTH010":
		case "AUTH011":
		case "AUTH012":
		case "AUTH013":
		case "AUTH014":
			return failure(
				"provider-error",
				`the account is out of credits or its plan does not allow this${tag}`,
				{ problem: "credits" },
			);
		case "AUTH006":
		case "AUTH008":
			return failure(
				"provider-error",
				`too many requests at once for the plan${tag}`,
				{ retryAfterMs: retryAfterMs(response) },
			);
		case "BLK0001":
			return failure(
				"provider-error",
				`ZenRows blocked this key after too many errors${tag}`,
				{ problem: "blocked" },
			);
		case "REQS001":
			return failure(
				"provider-error",
				`ZenRows does not fetch this domain${tag}`,
			);
		case "RESP005":
			return failure("provider-error", `the page is too large${tag}`);
		case "RESP009":
			return failure("provider-error", `ZenRows is at capacity${tag}`, {
				retryAfterMs: retryAfterMs(response),
			});
		case "CTX0002":
			return failure("provider-error", `ZenRows timed out${tag}`);
		default:
			return failure("provider-error", `the request failed${tag}`);
	}
}

/**
 * ZenRows Fetch (formerly the Universal Scraper API): proxies, browser
 * rendering, and anti-bot handling behind one GET. The API key travels in
 * the query string, so the request URL never leaves this function: not in a
 * result, a detail, or an error.
 */
export const zenrowsAdapter: ProxyAdapter = {
	kind: "zenrows",
	// `Zr-Final-Url`.
	reportsFinalUrl: true,

	maxCostUsd(_config: ProxyConfig, level: ProxyLevel): number {
		return (CREDITS[level] ?? 25) * USD_PER_CREDIT;
	},

	async fetch(
		config: ProxyConfig,
		call: ProxyCall,
		fetchImpl: FetchLike,
	): Promise<StepResult> {
		if (!config.apiKey)
			return failure("provider-error", "no API key is set", { problem: "key" });
		const query = new URLSearchParams({
			apikey: config.apiKey,
			url: call.url,
			...levelParams(call.level),
		});
		if (call.format === "markdown") query.set("response_type", "markdown");
		if (config.country && COUNTRY_LEVELS.has(call.level))
			query.set("proxy_country", config.country.toLowerCase());
		const base = (config.baseUrl ?? ENDPOINT).replace(/\/+$/, "");
		let response: Response | undefined;
		let body: string;
		try {
			response = await fetchImpl(`${base}/v1/?${query}`, {
				method: "GET",
				signal: call.signal,
			});
			body = await readLimited(response);
		} catch (error) {
			// A page too large to read was still delivered, and billed.
			if (error instanceof ResponseTooLarge && response)
				// Only a delivered page is billed; an error answer this large is
				// still an error, read from its status alone, and the ladder moves on.
				return response.ok
					? failure("target-error", "the page is larger than 5 MB", {
							billed: true,
							costUsd: costOf(response, call.level),
						})
					: oversizedError(response, call.level);
			// The error may quote the request URL, and with it the key.
			return call.signal.aborted
				? failure("timeout", "the request ran out of time")
				: failure("provider-error", "ZenRows could not be reached");
		}
		if (!response.ok)
			return errorResult(response, problemCode(body), call.level);
		const contentType =
			response.headers.get("zr-content-type") ??
			response.headers.get("content-type") ??
			"";
		return {
			outcome: "ok",
			status: 200,
			finalUrl: response.headers.get("zr-final-url") || call.url,
			contentType,
			content: body,
			contentFormat:
				call.format === "markdown"
					? "markdown"
					: /html/i.test(contentType)
						? "html"
						: "text",
			costUsd: costOf(response, call.level),
		};
	},
};
