import { ResponseTooLarge, readLimited } from "../../web/providers/read.js";
import { checkTargetUrl } from "../../web/url-guard.js";
import type { VideoFailure } from "../types.js";

/** The most of a provider's answer read, except a Google result with its video inline. */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** A Google result with the video inline, as base64. */
export const MAX_INLINE_VIDEO_BYTES = 16 * 1024 * 1024;
/** How long to leave a provider alone after a rate limit without `Retry-After`. */
const DEFAULT_RETRY_MS = 10_000;
/** The longest a provider's `Retry-After` parks a connection or a job's polling. */
const MAX_RETRY_MS = 10 * 60_000;
const MESSAGE_LENGTH = 300;

export { ResponseTooLarge, readLimited };

export function retryAfterMs(response: Response): number {
	const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
	return Number.isFinite(seconds) && seconds >= 0
		? Math.min(Math.ceil(seconds * 1000), MAX_RETRY_MS)
		: DEFAULT_RETRY_MS;
}

/**
 * A provider's own words, safe to show: the key removed wherever it
 * appears, links removed (they can carry signed tokens), and cut short.
 */
export function providerMessage(text: unknown, apiKey?: string): string {
	if (typeof text !== "string") return "";
	// Links first: a key that happens to look like a scheme must not hide one.
	let message = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]");
	if (apiKey) message = message.split(apiKey).join("[key]");
	message = message.replace(/\s+/g, " ").trim();
	return message.length > MESSAGE_LENGTH
		? `${message.slice(0, MESSAGE_LENGTH - 1)}…`
		: message;
}

export function failure(
	label: string,
	outcome: VideoFailure["outcome"],
	detail: string,
	extra: Partial<VideoFailure> = {},
): VideoFailure {
	return { outcome, detail: `${label}: ${detail}`, billed: false, ...extra };
}

/** Connection errors that prove the request never reached the provider. */
const NOT_SENT = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"EHOSTUNREACH",
	"ENETUNREACH",
	"UND_ERR_CONNECT_TIMEOUT",
	"CERT_HAS_EXPIRED",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"ERR_TLS_CERT_ALTNAME_INVALID",
]);

/** The first `code` on an error or its causes. */
function errorCode(error: unknown): string | undefined {
	let current = error;
	for (let depth = 0; depth < 4 && current; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === "string") return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * A create call that threw. Once the request may have left, the provider
 * may have accepted it, so the failure is a `timeout`: the hold stays and
 * no other provider is tried, which could pay twice. Only an error that
 * proves the request was never sent moves on. The error itself may quote
 * the URL, so it is never shown.
 */
export function createFailure(
	label: string,
	signal: AbortSignal,
	error: unknown,
	response?: Response,
): VideoFailure {
	if (response && !response.ok) return httpFailure(label, response, "");
	if (response)
		return failure(
			label,
			"timeout",
			"the answer could not be read, so the provider may have started the video",
		);
	if (signal.aborted)
		return failure(label, "timeout", "the request ran out of time");
	const code = errorCode(error);
	if (code && NOT_SENT.has(code))
		return failure(label, "provider-error", `${label} could not be reached`);
	return failure(
		label,
		"timeout",
		"the connection failed while starting the video, so the provider may have started it",
	);
}

/**
 * What an HTTP error from a create call means. `message` is the
 * provider's own explanation, already passed through `providerMessage`.
 */
export function httpFailure(
	label: string,
	response: Response,
	message: string,
): VideoFailure {
	const tag = `HTTP ${response.status}`;
	const said = message ? `: ${message}` : "";
	const status = response.status;
	if (status === 401)
		return failure(
			label,
			"provider-error",
			`the API key was refused (${tag})${said}`,
			{ problem: "key" },
		);
	// A rate limit first: its message may well mention a quota.
	if (status === 429)
		return failure(
			label,
			"provider-error",
			`too many requests (${tag})${said}`,
			{
				retryAfterMs: retryAfterMs(response),
			},
		);
	if (
		status === 402 ||
		([400, 403, 422].includes(status) &&
			/\b(credits?|balance|billing|insufficient funds)\b/i.test(message))
	)
		return failure(
			label,
			"provider-error",
			`the account is out of credits or its plan does not allow this (${tag})${said}`,
			{ problem: "credits" },
		);
	if (status === 403)
		return failure(
			label,
			"provider-error",
			`the API key was refused (${tag})${said}`,
			{ problem: "key" },
		);
	if (status === 400 || status === 422)
		return failure(label, "invalid", `the request was refused (${tag})${said}`);
	return failure(label, "provider-error", `the request failed (${tag})${said}`);
}

/** Parses JSON, or null when the text is not JSON. */
export function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

/** A plain object's field, or undefined. */
export function field(value: unknown, key: string): unknown {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)[key]
		: undefined;
}

/**
 * A provider's result link when it is one the gateway may send people to:
 * https, no credentials, and not a private host. Otherwise null.
 */
export function safeResultUrl(raw: unknown): string | null {
	if (typeof raw !== "string" || raw.length > 8192) return null;
	try {
		const url = new URL(raw);
		if (url.protocol !== "https:" || url.username || url.password) return null;
		// The host and port pass the URL guard. Only the origin is checked:
		// signed links run past the guard's 2048-character limit.
		checkTargetUrl(`${url.protocol}//${url.host}/`);
		return url.toString();
	} catch {
		return null;
	}
}

/** Headers for a bearer-key JSON API. */
export function jsonHeaders(
	extra: Record<string, string>,
): Record<string, string> {
	return {
		accept: "application/json",
		"content-type": "application/json",
		...extra,
	};
}
