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

const ENDPOINT = "https://api.cloudflare.com/client/v4";
/**
 * The API reference still names the product Browser Rendering in its path.
 * The product docs already use `browser-run`; change it here when the old
 * path goes away.
 */
const PATH_SEGMENT = "browser-rendering";
/** Browser time past the included hours, in US dollars per millisecond. */
const USD_PER_MS = 0.09 / 3_600_000;
/** The longest a page may take to load: Cloudflare's own cap. */
const GOTO_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_MS = 10_000;

type BrowserRunBody = {
	success?: unknown;
	result?: unknown;
	meta?: { status?: unknown; finalUrl?: unknown; url?: unknown };
};

function failure(
	outcome: StepFailure["outcome"],
	detail: string,
	extra: Partial<StepFailure> = {},
): StepFailure {
	return {
		outcome,
		status: null,
		costUsd: 0,
		detail: `Cloudflare Browser Run: ${detail}`,
		billed: false,
		...extra,
	};
}

/** Browser time used, as Cloudflare reports it on every response. */
function browserMs(response: Response): number {
	const ms = Number.parseFloat(response.headers.get("x-browser-ms-used") ?? "");
	return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

function retryAfterMs(response: Response): number {
	const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: DEFAULT_RETRY_MS;
}

/** What the site's own status means when the browser reached it but did not get the page. */
function siteFailure(status: number, extra: Partial<StepFailure>): StepFailure {
	if (status === 404 || status === 410)
		return failure("not-found", `the site answered ${status}`, {
			status,
			...extra,
		});
	if (status === 403 || status === 429 || status === 503)
		return failure("blocked", `the site blocked the browser (${status})`, {
			status,
			...extra,
		});
	return failure("target-error", `the site answered ${status}`, {
		status,
		...extra,
	});
}

/**
 * Cloudflare Browser Run (formerly Browser Rendering): a real browser on
 * Cloudflare's network. It renders JavaScript but is always identified as a
 * bot and gets past no bot protection, so the ladder uses it for pages that
 * need a browser, never for pages that block.
 */
export const cloudflareAdapter: ProxyAdapter = {
	kind: "cloudflare-browser",

	maxCostUsd(_config: ProxyConfig, _level: ProxyLevel): number {
		return GOTO_TIMEOUT_MS * USD_PER_MS;
	},

	async fetch(
		config: ProxyConfig,
		call: ProxyCall,
		fetchImpl: FetchLike,
	): Promise<StepResult> {
		if (!config.apiKey)
			return failure("provider-error", "no API token is set", {
				problem: "key",
			});
		if (!config.accountId)
			return failure("provider-error", "no account ID", { problem: "key" });
		const base = (config.baseUrl ?? ENDPOINT).replace(/\/+$/, "");
		const action = call.format === "markdown" ? "markdown" : "content";
		let response: Response | undefined;
		let text: string;
		try {
			response = await fetchImpl(
				`${base}/accounts/${encodeURIComponent(config.accountId)}/${PATH_SEGMENT}/${action}`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${config.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						url: call.url,
						gotoOptions: {
							waitUntil: "networkidle2",
							timeout: GOTO_TIMEOUT_MS,
						},
						rejectResourceTypes: ["image", "media", "font"],
					}),
					signal: call.signal,
				},
			);
			text = await readLimited(response);
		} catch (error) {
			if (error instanceof ResponseTooLarge && response) {
				const ms = browserMs(response);
				return failure("target-error", "the page is larger than 5 MB", {
					costUsd: ms * USD_PER_MS,
					billed: ms > 0,
				});
			}
			return call.signal.aborted
				? failure("timeout", "the request ran out of time")
				: failure("provider-error", "Cloudflare could not be reached");
		}
		const ms = browserMs(response);
		const spent = { costUsd: ms * USD_PER_MS, billed: ms > 0 };
		if (response.status === 401 || response.status === 403)
			return failure(
				"provider-error",
				`the API token was refused (HTTP ${response.status})`,
				{ problem: "key", ...spent },
			);
		if (response.status === 429)
			return failure("provider-error", "rate limited", {
				retryAfterMs: retryAfterMs(response),
				...spent,
			});
		if (response.status === 422)
			return failure(
				"provider-error",
				"the page did not finish rendering",
				spent,
			);
		if (!response.ok)
			return failure(
				"provider-error",
				`the request failed (HTTP ${response.status})`,
				spent,
			);
		let body: BrowserRunBody;
		try {
			body = JSON.parse(text) as BrowserRunBody;
		} catch {
			return failure("provider-error", "the answer was not JSON", spent);
		}
		if (body.success !== true || typeof body.result !== "string")
			return failure("provider-error", "the request did not succeed", spent);
		// The markdown endpoint may leave `meta` out; the page loaded, so 200.
		const status =
			typeof body.meta?.status === "number" ? body.meta.status : 200;
		if (status < 200 || status >= 300) return siteFailure(status, spent);
		const finalUrl =
			typeof body.meta?.finalUrl === "string"
				? body.meta.finalUrl
				: typeof body.meta?.url === "string"
					? body.meta.url
					: call.url;
		return {
			outcome: "ok",
			status,
			finalUrl,
			contentType: call.format === "markdown" ? "text/markdown" : "text/html",
			content: body.result,
			contentFormat: call.format === "markdown" ? "markdown" : "html",
			costUsd: spent.costUsd,
		};
	},
};
