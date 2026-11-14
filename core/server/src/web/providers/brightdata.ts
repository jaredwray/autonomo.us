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

const ENDPOINT = "https://api.brightdata.com";
/** Bright Data's list price for 1,000 successful Web Unlocker requests. */
const DEFAULT_PRICE_PER_1000_USD = 1.5;
const DEFAULT_RETRY_MS = 10_000;

/** Codes for an unlock attempt the site defeated. A retry through another step may work. */
function blockCode(code: string): boolean {
	return (
		code === "reject_block" ||
		code === "http_status" ||
		code.startsWith("resolve_failed")
	);
}

function pricePerRequest(config: ProxyConfig): number {
	const price = config.pricePer1000Usd;
	return (
		(typeof price === "number" && Number.isFinite(price) && price >= 0
			? price
			: DEFAULT_PRICE_PER_1000_USD) / 1000
	);
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
		detail: `Bright Data: ${detail}`,
		billed: false,
		...extra,
	};
}

function retryAfterMs(response: Response): number {
	const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: DEFAULT_RETRY_MS;
}

/** Whether a header holds a usable value. */
function header(response: Response, name: string): string | null {
	const value = response.headers.get(name)?.trim();
	return value ? value : null;
}

/**
 * Bright Data Web Unlocker: one POST that returns the site's own answer, or
 * an `x-brd-error` header when the unlock itself failed. Successful requests
 * are billed at a flat price per 1,000, which the connection can override.
 */
export const brightdataAdapter: ProxyAdapter = {
	kind: "brightdata",
	// Web Unlocker documents no header naming the page it landed on.
	reportsFinalUrl: false,

	maxCostUsd(config: ProxyConfig, _level: ProxyLevel): number {
		return pricePerRequest(config);
	},

	async fetch(
		config: ProxyConfig,
		call: ProxyCall,
		fetchImpl: FetchLike,
	): Promise<StepResult> {
		if (!config.apiKey)
			return failure("provider-error", "no API key is set", { problem: "key" });
		if (!config.zone) return failure("provider-error", "no zone set");
		const base = (config.baseUrl ?? ENDPOINT).replace(/\/+$/, "");
		let response: Response | undefined;
		let text: string;
		try {
			response = await fetchImpl(`${base}/request`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${config.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					zone: config.zone,
					url: call.url,
					format: "raw",
					...(call.format === "markdown" ? { data_format: "markdown" } : {}),
					...(config.country ? { country: config.country.toLowerCase() } : {}),
				}),
				signal: call.signal,
			});
			text = await readLimited(response);
		} catch (error) {
			if (!(error instanceof ResponseTooLarge && response))
				return call.signal.aborted
					? failure("timeout", "the request ran out of time")
					: failure("provider-error", "Bright Data could not be reached");
			// Only a delivered page is too large. Anything else is judged below
			// from its status and Bright Data's headers alone, as any answer is.
			const site = Number.parseInt(
				response.headers.get("x-brd-status-code") ?? "200",
				10,
			);
			if (
				response.ok &&
				!response.headers.get("x-brd-error") &&
				site >= 200 &&
				site < 300
			)
				return failure("target-error", "the page is larger than 5 MB", {
					billed: true,
					costUsd: pricePerRequest(config),
				});
			text = "";
		}
		// Refused before an unlock was tried: the key, the zone, or the account.
		if (response.status === 401)
			return failure("provider-error", "the API key was refused (HTTP 401)", {
				problem: "key",
			});
		if (response.status === 402)
			return failure(
				"provider-error",
				"the account is out of funds (HTTP 402)",
				{
					problem: "credits",
				},
			);
		if (response.status === 429)
			return failure("provider-error", "rate limited (HTTP 429)", {
				retryAfterMs: retryAfterMs(response),
			});
		if (response.status === 400)
			return failure(
				"provider-error",
				"the request was refused; check the zone name (HTTP 400)",
			);
		if (!response.ok)
			return failure(
				"provider-error",
				`the request failed (HTTP ${response.status})`,
			);
		const siteStatus = Number.parseInt(
			header(response, "x-brd-status-code") ?? "200",
			10,
		);
		const status = Number.isFinite(siteStatus) ? siteStatus : 200;
		if (header(response, "x-brd-error")) {
			const code =
				header(response, "x-brd-error-code") ??
				header(response, "x-brd-err-code");
			const tag = code ? ` (${code})` : "";
			return code && blockCode(code)
				? failure("blocked", `the site defeated the unlock attempt${tag}`, {
						status,
					})
				: failure("provider-error", `the unlock attempt failed${tag}`, {
						status,
					});
		}
		// No x-brd-error: this is the site's own answer, delivered as it was.
		const price = pricePerRequest(config);
		if (status === 404 || status === 410)
			return failure("not-found", `the site answered ${status}`, {
				status,
				costUsd: price,
				billed: true,
			});
		if (status === 403 || status === 429 || status === 503)
			return failure("blocked", `the site blocked the request (${status})`, {
				status,
			});
		if (status < 200 || status >= 300)
			return failure("target-error", `the site answered ${status}`, { status });
		const contentType = response.headers.get("content-type") ?? "";
		return {
			outcome: "ok",
			status,
			finalUrl: call.url,
			contentType,
			content: text,
			contentFormat:
				call.format === "markdown"
					? "markdown"
					: /html/i.test(contentType)
						? "html"
						: "text",
			costUsd: price,
		};
	},
};
