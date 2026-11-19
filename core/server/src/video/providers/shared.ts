import { ResponseTooLarge, readLimited } from "../../web/providers/read.js";
import { checkTargetUrl } from "../../web/url-guard.js";
import type { VideoFailure } from "../types.js";

/** The most of a provider's answer read, except a Google result with its video inline. */
export const MAX_ANSWER_BYTES = 1024 * 1024;
/** A Google result with the video inline, as base64. */
export const MAX_INLINE_VIDEO_BYTES = 16 * 1024 * 1024;
/** How long to leave a provider alone after a rate limit without `Retry-After`. */
const DEFAULT_RETRY_MS = 10_000;
const MESSAGE_LENGTH = 300;

export { ResponseTooLarge, readLimited };

export function retryAfterMs(response: Response): number {
	const seconds = Number.parseFloat(response.headers.get("retry-after") ?? "");
	return Number.isFinite(seconds) && seconds >= 0
		? Math.ceil(seconds * 1000)
		: DEFAULT_RETRY_MS;
}

/**
 * A provider's own words, safe to show: the key removed wherever it
 * appears, links removed (they can carry signed tokens), and cut short.
 */
export function providerMessage(text: unknown, apiKey?: string): string {
	if (typeof text !== "string") return "";
	let message = text;
	if (apiKey && apiKey.length >= 4)
		message = message.split(apiKey).join("[key]");
	message = message
		.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "[link]")
		.replace(/\s+/g, " ")
		.trim();
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

/** A network error or an aborted call. The error itself may quote the URL, so it is never shown. */
export function networkFailure(
	label: string,
	signal: AbortSignal,
): VideoFailure {
	return signal.aborted
		? failure(label, "timeout", "the request ran out of time")
		: failure(label, "provider-error", `${label} could not be reached`);
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
	if (response.status === 401 || response.status === 403)
		return failure(
			label,
			"provider-error",
			`the API key was refused (${tag})${said}`,
			{ problem: "key" },
		);
	if (
		response.status === 402 ||
		/\b(credits?|balance|quota|billing)\b/i.test(message)
	)
		return failure(
			label,
			"provider-error",
			`the account is out of credits or its plan does not allow this (${tag})${said}`,
			{ problem: "credits" },
		);
	if (response.status === 429)
		return failure(
			label,
			"provider-error",
			`too many requests (${tag})${said}`,
			{
				retryAfterMs: retryAfterMs(response),
			},
		);
	if (response.status === 400 || response.status === 422)
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
