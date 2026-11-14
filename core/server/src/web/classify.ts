/**
 * Decides what a response means for the fetch ladder: the page, a bot block
 * that a proxy may get past, a page that needs JavaScript, or an answer no
 * proxy changes. The same checks run on Markdown or text from a provider,
 * since a provider can hand back a challenge page as if it were content.
 */

export type Classification = {
	outcome: "ok" | "blocked" | "needs-render" | "not-found" | "target-error";
	detail: string;
};

export type ClassifyInput = {
	status: number;
	headers: Headers;
	body: string;
	contentType: string;
};

/**
 * What bot protection leaves in a response. A `strong` marker appears only on
 * challenge pages; a weak one (a CAPTCHA widget, a vendor's script) also
 * appears on ordinary pages, so on a 200 it counts only when the page has
 * little else on it. Body markers are lower case.
 */
export const CHALLENGE_MARKERS: ReadonlyArray<{
	vendor: string;
	strong: boolean;
	header?: { name: string; includes?: string };
	body?: string;
}> = [
	{
		vendor: "Cloudflare challenge",
		strong: true,
		header: { name: "cf-mitigated", includes: "challenge" },
	},
	{ vendor: "Cloudflare challenge", strong: true, body: "cf_chl_opt" },
	{
		vendor: "Cloudflare challenge",
		strong: true,
		body: "/cdn-cgi/challenge-platform",
	},
	{
		vendor: "Cloudflare challenge",
		strong: true,
		body: "cf-browser-verification",
	},
	{
		vendor: "Cloudflare challenge",
		strong: true,
		body: "attention required! | cloudflare",
	},
	{ vendor: "Cloudflare challenge", strong: false, body: "just a moment..." },
	{
		vendor: "Cloudflare challenge",
		strong: false,
		body: "enable javascript and cookies to continue",
	},
	{
		vendor: "Cloudflare challenge",
		strong: false,
		body: "checking your browser before accessing",
	},
	{
		vendor: "Cloudflare challenge",
		strong: false,
		body: "verify you are human",
	},
	{
		vendor: "Cloudflare challenge",
		strong: false,
		body: "challenges.cloudflare.com/turnstile",
	},
	{ vendor: "DataDome", strong: false, header: { name: "x-datadome" } },
	{ vendor: "DataDome", strong: true, body: "captcha-delivery.com" },
	{ vendor: "Akamai", strong: true, body: "errors.edgesuite.net" },
	{ vendor: "PerimeterX/HUMAN", strong: true, body: "_pxcaptcha" },
	{ vendor: "PerimeterX/HUMAN", strong: true, body: "px-captcha" },
	{ vendor: "PerimeterX/HUMAN", strong: false, body: "press & hold" },
	{ vendor: "PerimeterX/HUMAN", strong: false, body: "press &amp; hold" },
	{ vendor: "Imperva", strong: true, body: "incapsula incident id" },
	{ vendor: "Imperva", strong: true, body: "_incapsula_resource" },
	{
		vendor: "AWS WAF",
		strong: true,
		header: { name: "x-amzn-waf-action" },
	},
	{ vendor: "AWS WAF", strong: true, body: "awswafintegration" },
	{ vendor: "CAPTCHA", strong: false, body: "g-recaptcha" },
	{ vendor: "CAPTCHA", strong: false, body: "www.google.com/recaptcha" },
	{ vendor: "CAPTCHA", strong: false, body: "hcaptcha.com" },
	{ vendor: "CAPTCHA", strong: false, body: "h-captcha" },
	{
		vendor: "CAPTCHA",
		strong: false,
		body: "unusual traffic from your computer network",
	},
	{ vendor: "CAPTCHA", strong: false, body: "are you a robot" },
	{ vendor: "bot check", strong: false, body: "you have been blocked" },
	{ vendor: "bot check", strong: false, body: "please verify you are a human" },
];

/** Signs that a page is an empty shell a browser fills in with JavaScript. */
const SHELL_MARKERS = [
	"enable javascript",
	"javascript is required",
	"requires javascript",
	"javascript is disabled",
	"turn on javascript",
	"javascript to run this app",
	'id="root"',
	"id='root'",
	'id="app"',
	"id='app'",
	'id="__next"',
	'id="__nuxt"',
	"__next_data__",
	"<app-root",
	"ng-version",
];

/** Markers are looked for in this much of a body. */
const SCAN_BYTES = 64 * 1024;
/** Visible text is estimated from this much of a body. */
const TEXT_SCAN_BYTES = 512 * 1024;
/** A page with less visible text than this is mostly markup. */
const SHELL_TEXT = 200;
/** A 200 carrying a weak marker is a challenge only below this much text. */
const CHALLENGE_TEXT = 1500;

export function classifyResponse(input: ClassifyInput): Classification {
	const { status } = input;
	if (status === 404 || status === 410)
		return {
			outcome: "not-found",
			detail: `the page does not exist (${status})`,
		};
	if (status === 401 || status === 407)
		return {
			outcome: "target-error",
			detail: `the page needs a login (${status})`,
		};
	const type = mediaType(input.contentType);
	const markup = type === "" || type.includes("html") || type.includes("xml");
	const readable =
		markup || type.startsWith("text/") || type === "application/json";
	const lower = readable ? input.body.slice(0, SCAN_BYTES).toLowerCase() : "";
	const marker = findMarker(input.headers, lower);

	if (status === 403 || status === 429 || status === 503) {
		if (marker) return { outcome: "blocked", detail: marker.vendor };
		if (status === 403)
			return { outcome: "blocked", detail: "access denied (403)" };
		if (status === 429)
			return { outcome: "blocked", detail: "rate limited (429)" };
		return { outcome: "target-error", detail: "the site returned 503" };
	}
	if (status >= 500) {
		if (marker?.strong) return { outcome: "blocked", detail: marker.vendor };
		return { outcome: "target-error", detail: `the site returned ${status}` };
	}
	if (status >= 400)
		return { outcome: "target-error", detail: `the site returned ${status}` };
	if (status < 200 || status >= 300)
		return {
			outcome: "target-error",
			detail: `unexpected status ${status}`,
		};

	if (!readable) return { outcome: "ok", detail: "" };
	const text = visibleTextLength(input.body, markup, CHALLENGE_TEXT);
	// A strong marker is a challenge page whatever else is on it.
	if (marker && (marker.strong || text < CHALLENGE_TEXT))
		return { outcome: "blocked", detail: marker.vendor };
	if (!input.body.trim())
		return { outcome: "target-error", detail: "the page was empty" };
	if (
		text < SHELL_TEXT &&
		(SHELL_MARKERS.some((sign) => lower.includes(sign)) ||
			(markup && text < 50 && lower.includes("<script")))
	)
		return { outcome: "needs-render", detail: "the page needs JavaScript" };
	return { outcome: "ok", detail: "" };
}

function mediaType(contentType: string): string {
	return contentType.split(";")[0].trim().toLowerCase();
}

function findMarker(headers: Headers, lower: string) {
	let weak: (typeof CHALLENGE_MARKERS)[number] | undefined;
	for (const marker of CHALLENGE_MARKERS) {
		let hit = false;
		if (marker.header) {
			const value = headers.get(marker.header.name);
			hit =
				value !== null &&
				(!marker.header.includes ||
					value.toLowerCase().includes(marker.header.includes));
		} else if (marker.body) hit = lower.includes(marker.body);
		if (!hit) continue;
		if (marker.strong) return marker;
		weak ??= marker;
	}
	// Akamai's block page names itself only by its wording.
	if (!weak && lower.includes("access denied") && lower.includes("reference #"))
		return {
			vendor: "Akamai",
			strong: true,
			body: "reference #",
		} as (typeof CHALLENGE_MARKERS)[number];
	return weak;
}

/**
 * Counts visible characters (whitespace collapsed), skipping tags, comments,
 * and script, style, and template contents, and stops at `limit`. Each search
 * moves forward from where the last one ended, so it is linear in the body.
 */
export function visibleTextLength(
	body: string,
	markup: boolean,
	limit: number,
): number {
	const source =
		body.length > TEXT_SCAN_BYTES ? body.slice(0, TEXT_SCAN_BYTES) : body;
	if (!markup) return countText(source, 0, source.length, limit);
	const lower = source.toLowerCase();
	let count = 0;
	let i = 0;
	while (i < source.length && count < limit) {
		const open = source.indexOf("<", i);
		const textEnd = open === -1 ? source.length : open;
		count += countText(source, i, textEnd, limit - count);
		if (open === -1) break;
		if (lower.startsWith("<!--", open)) {
			const close = lower.indexOf("-->", open + 4);
			if (close === -1) break;
			i = close + 3;
			continue;
		}
		const close = source.indexOf(">", open + 1);
		if (close === -1) break;
		const name = /^<([a-z]+)/.exec(
			lower.slice(open, Math.min(close, open + 12)),
		);
		i = close + 1;
		if (
			name &&
			(name[1] === "script" || name[1] === "style" || name[1] === "template") &&
			lower[close - 1] !== "/"
		) {
			const end = lower.indexOf(`</${name[1]}`, i);
			if (end === -1) break;
			i = end;
		}
	}
	return count;
}

function countText(text: string, from: number, to: number, limit: number) {
	let count = 0;
	let space = true;
	for (let i = from; i < to && count < limit; i++) {
		const code = text.charCodeAt(i);
		const blank =
			code === 32 ||
			code === 9 ||
			code === 10 ||
			code === 13 ||
			code === 12 ||
			code === 160;
		if (blank) {
			if (!space) count++;
			space = true;
		} else {
			count++;
			space = false;
		}
	}
	return count;
}
