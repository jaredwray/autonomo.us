import { describe, expect, it } from "vitest";
import {
	CHALLENGE_MARKERS,
	classifyResponse,
	visibleTextLength,
} from "../src/web/classify.js";

const html = "text/html; charset=utf-8";
const classify = (
	status: number,
	body: string,
	headers: Record<string, string> = {},
	contentType = html,
) =>
	classifyResponse({
		status,
		headers: new Headers(headers),
		body,
		contentType,
	});

const article = `<html><head><title>Story</title></head><body><main>${"<p>A real paragraph with plenty of words in it, about anything at all.</p>".repeat(40)}</main></body></html>`;

const cloudflareChallenge = `<!DOCTYPE html><html lang="en-US"><head><title>Just a moment...</title>
<meta http-equiv="refresh" content="390"><script>window._cf_chl_opt={cvId: '3',cZone:"example.com"};</script>
<script src="/cdn-cgi/challenge-platform/h/b/orchestrate/chl_page/v1?ray=8a1"></script></head>
<body><div class="main-wrapper"><h1>example.com</h1><p>Verify you are human by completing the action below.</p>
<noscript>Enable JavaScript and cookies to continue</noscript></div></body></html>`;

describe("classifyResponse", () => {
	it("passes a readable page", () => {
		expect(classify(200, article)).toEqual({ outcome: "ok", detail: "" });
	});

	it.each([404, 410])("calls %i not found", (status) => {
		expect(classify(status, "<p>gone</p>").outcome).toBe("not-found");
	});

	it.each([401, 407])("calls %i a login no proxy fixes", (status) => {
		expect(classify(status, "")).toEqual({
			outcome: "target-error",
			detail: `the page needs a login (${status})`,
		});
	});

	it("recognizes a Cloudflare challenge by its header", () => {
		expect(classify(403, "", { "cf-mitigated": "challenge" })).toEqual({
			outcome: "blocked",
			detail: "Cloudflare challenge",
		});
	});

	it("recognizes a Cloudflare challenge page served as 403 or 503", () => {
		expect(classify(403, cloudflareChallenge).detail).toBe(
			"Cloudflare challenge",
		);
		expect(classify(503, cloudflareChallenge).outcome).toBe("blocked");
	});

	it("recognizes a challenge page served as 200", () => {
		expect(classify(200, cloudflareChallenge)).toEqual({
			outcome: "blocked",
			detail: "Cloudflare challenge",
		});
	});

	it("recognizes a challenge in Markdown a provider returned", () => {
		const markdown =
			"# example.com\n\nJust a moment...\n\nVerify you are human by completing the action below.";
		expect(classify(200, markdown, {}, "text/markdown").outcome).toBe(
			"blocked",
		);
		expect(
			classify(
				200,
				"Enable JavaScript and cookies to continue",
				{},
				"text/plain",
			).detail,
		).toBe("Cloudflare challenge");
	});

	it.each([
		[
			"DataDome",
			'<html><head><script src="https://ct.captcha-delivery.com/c.js"></script></head><body><iframe src="https://geo.captcha-delivery.com/captcha/?initialCid=x"></iframe></body></html>',
			{},
		],
		[
			"DataDome",
			"<html><body>Please enable JS and disable any ad blocker</body></html>",
			{ "x-datadome": "protected" },
		],
		[
			"Akamai",
			'<HTML><HEAD><TITLE>Access Denied</TITLE></HEAD><BODY><H1>Access Denied</H1>You don\'t have permission to access "http://www.example.com/" on this server.<P>Reference&#32;&#35;18&#46;2d351ab8&#46;1557333295&#46;a4e16ab</BODY></HTML>'.replace(
				"Reference&#32;&#35;",
				"Reference #",
			),
			{ server: "AkamaiGHost" },
		],
		[
			"PerimeterX/HUMAN",
			'<html><body><div id="px-captcha"></div><p>Press &amp; Hold to confirm you are a human (and not a bot).</p></body></html>',
			{},
		],
		[
			"Imperva",
			'<html><body><iframe src="/_Incapsula_Resource?CWUDNSAI=9&xinfo=1"></iframe>Request unsuccessful. Incapsula incident ID: 123</body></html>',
			{},
		],
		[
			"AWS WAF",
			"<html><body><script>AwsWafIntegration.checkForceRefresh()</script></body></html>",
			{},
		],
		["AWS WAF", "", { "x-amzn-waf-action": "captcha" }],
		[
			"CAPTCHA",
			'<html><body><form><div class="g-recaptcha" data-sitekey="x"></div></form><p>Our systems have detected unusual traffic from your computer network.</p></body></html>',
			{},
		],
	])("names %s blocks on a 403", (vendor, body, headers) => {
		expect(classify(403, body, headers)).toEqual({
			outcome: "blocked",
			detail: vendor,
		});
	});

	it("calls a 403 or 429 without a marker a block", () => {
		expect(classify(403, "<h1>Forbidden</h1>")).toEqual({
			outcome: "blocked",
			detail: "access denied (403)",
		});
		expect(classify(429, "slow down")).toEqual({
			outcome: "blocked",
			detail: "rate limited (429)",
		});
	});

	it("calls a 503 or other 5xx without a marker a site error", () => {
		expect(classify(503, "<h1>Service Unavailable</h1>").outcome).toBe(
			"target-error",
		);
		expect(classify(502, "Bad gateway")).toEqual({
			outcome: "target-error",
			detail: "the site returned 502",
		});
	});

	it("calls other 4xx statuses site errors", () => {
		expect(classify(400, "bad").outcome).toBe("target-error");
		expect(classify(451, "legal").detail).toBe("the site returned 451");
	});

	it.each([
		[
			"a React shell",
			'<!doctype html><html><head><script type="module" src="/assets/index.js"></script></head><body><noscript>You need to enable JavaScript to run this app.</noscript><div id="root"></div></body></html>',
		],
		[
			"a Next.js page",
			'<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>',
		],
		[
			"an Angular app",
			'<html><body><app-root></app-root><script src="main.js"></script></body></html>',
		],
		[
			"a page with only scripts",
			"<html><body><script src=a.js></script><script src=b.js></script></body></html>",
		],
	])("says %s needs JavaScript", (_name, body) => {
		expect(classify(200, body)).toEqual({
			outcome: "needs-render",
			detail: "the page needs JavaScript",
		});
	});

	it("does not flag a long page that mentions CAPTCHAs, Cloudflare, or JavaScript", () => {
		const body = `<html><body><article><h1>How bot checks work</h1>${"<p>Sites use a CAPTCHA such as g-recaptcha or hCaptcha, Cloudflare Turnstile, and Just a moment... pages to verify you are human. Enable JavaScript to see comments.</p>".repeat(30)}</article></body></html>`;
		expect(classify(200, body).outcome).toBe("ok");
	});

	it("does not flag a login page with a CAPTCHA widget and real content", () => {
		const body = `<html><body><h1>Sign in</h1><div class="g-recaptcha"></div>${"<p>Lots of real text about the product and its features.</p>".repeat(40)}</body></html>`;
		expect(classify(200, body).outcome).toBe("ok");
	});

	it("passes JSON and other readable types", () => {
		expect(classify(200, '{"ok":true}', {}, "application/json").outcome).toBe(
			"ok",
		);
		expect(classify(200, "plain words", {}, "text/plain").outcome).toBe("ok");
	});

	it("passes types it cannot read without looking at them", () => {
		expect(classify(200, "%PDF-1.7", {}, "application/pdf").outcome).toBe("ok");
	});

	it("calls an empty page a site error", () => {
		expect(classify(200, "  ").outcome).toBe("target-error");
	});

	it("keeps every marker vendor named", () => {
		for (const marker of CHALLENGE_MARKERS) {
			expect(marker.vendor).toBeTruthy();
			expect(marker.header ?? marker.body).toBeTruthy();
			if (marker.body) expect(marker.body).toBe(marker.body.toLowerCase());
		}
	});
});

describe("visibleTextLength", () => {
	it("skips tags, comments, scripts, and styles and collapses whitespace", () => {
		const body =
			"<html><head><style>p{color:red}</style><script>var a = '<p>no</p>';</script></head><body><!-- hidden --><p>Hello   \n world</p></body></html>";
		expect(visibleTextLength(body, true, 1000)).toBe("Hello world".length);
	});

	it("stops counting at the limit", () => {
		expect(visibleTextLength("x".repeat(10_000), false, 100)).toBe(100);
	});

	it("is fast on hostile markup", () => {
		const started = performance.now();
		visibleTextLength("<".repeat(200_000), true, 1500);
		visibleTextLength("<script>".repeat(50_000), true, 1500);
		visibleTextLength("<!--".repeat(50_000), true, 1500);
		classify(200, "<a ".repeat(100_000));
		expect(performance.now() - started).toBeLessThan(1000);
	});
});
