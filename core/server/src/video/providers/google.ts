import type { VideoResolution } from "@autonomo.us/common";
import type {
	FetchLike,
	VideoAdapter,
	VideoCall,
	VideoConfig,
	VideoContent,
	VideoCreateResult,
	VideoPollResult,
} from "../types.js";
import {
	createFailure,
	failure,
	field,
	httpFailure,
	jsonHeaders,
	MAX_INLINE_VIDEO_BYTES,
	parseJson,
	providerMessage,
	ResponseTooLarge,
	readLimited,
	retryAfterMs,
} from "./shared.js";

const ENDPOINT = "https://generativelanguage.googleapis.com/v1beta";
/** The revision Google's Interactions API examples send. */
const API_REVISION = "2026-05-20";
const LABEL = "Google";
/**
 * Paid-tier interactions are kept 55 days by default, but a project can
 * shorten that to 7. The link promises no more than the shortest.
 */
const RESULT_TTL_MS = 7 * 24 * 3_600_000;
const UNKNOWN_USD_PER_SECOND = 0.5;
const USD_PER_SECOND: Partial<Record<VideoResolution, number>> = {
	"360p": 0.023,
	"720p": 0.07,
};

function base(config: VideoConfig) {
	return (config.baseUrl ?? ENDPOINT).replace(/\/+$/, "");
}

/** The key travels in a header, never in the `?key=` query form. */
function headers(config: VideoConfig): Record<string, string> {
	return jsonHeaders({
		"x-goog-api-key": config.apiKey ?? "",
		"api-revision": API_REVISION,
	});
}

function interactionUrl(config: VideoConfig, id: string) {
	return `${base(config)}/interactions/${encodeURIComponent(id)}`;
}

/** Google's error text: `error.message`. */
function errorMessage(body: unknown, apiKey?: string): string {
	const message = field(field(body, "error"), "message");
	return providerMessage(typeof message === "string" ? message : "", apiKey);
}

/** The first `{ type: "video" }` block anywhere in the interaction's steps. */
export function findVideoBlock(
	interaction: unknown,
): { data?: string; uri?: string } | null {
	const seen = new Set<unknown>();
	const visit = (
		value: unknown,
		depth: number,
	): { data?: string; uri?: string } | null => {
		if (!value || typeof value !== "object" || depth > 8 || seen.has(value))
			return null;
		seen.add(value);
		if (Array.isArray(value)) {
			for (const item of value) {
				const found = visit(item, depth + 1);
				if (found) return found;
			}
			return null;
		}
		const record = value as Record<string, unknown>;
		if (
			record.type === "video" &&
			(typeof record.data === "string" || typeof record.uri === "string")
		)
			return {
				...(typeof record.data === "string" ? { data: record.data } : {}),
				...(typeof record.uri === "string" ? { uri: record.uri } : {}),
			};
		for (const child of Object.values(record)) {
			const found = visit(child, depth + 1);
			if (found) return found;
		}
		return null;
	};
	return visit(field(interaction, "steps") ?? interaction, 0);
}

/** A failed interaction's error text, from `errors[]` or `error`. */
function interactionError(interaction: unknown, apiKey?: string) {
	const errors = field(interaction, "errors");
	const first = Array.isArray(errors) ? errors[0] : field(interaction, "error");
	const code = field(first, "code");
	const message = field(first, "message");
	return {
		code:
			typeof code === "string" || typeof code === "number" ? String(code) : "",
		message: providerMessage(
			typeof message === "string" ? message : "",
			apiKey,
		),
	};
}

const SAFETY = /safety|blocked|prohibited|policy|moderat/i;

/**
 * Gemini Omni Flash through the Interactions API, run in the background so
 * the gateway can poll. The finished video comes back inline as base64,
 * which only the connection's key can fetch, so downloads stream through
 * the gateway (`content`). 1080p and 4K are left out: they need URI delivery.
 */
export const googleAdapter: VideoAdapter = {
	kind: "google",
	resultTtlMs: RESULT_TTL_MS,

	estimateCostUsd(_config, call): number {
		return (
			(USD_PER_SECOND[call.resolution] ?? UNKNOWN_USD_PER_SECOND) *
			call.durationSeconds
		);
	},

	async create(
		config: VideoConfig,
		call: VideoCall,
		fetchImpl: FetchLike,
	): Promise<VideoCreateResult> {
		if (!config.apiKey)
			return failure(LABEL, "provider-error", "no API key is set", {
				problem: "key",
			});
		if (call.imageUrl)
			return failure(
				LABEL,
				"invalid",
				"this connection does not start from an image",
			);
		const body = {
			model: call.model,
			input: call.prompt,
			background: true,
			// Background interactions must be stored, or Google answers 400.
			store: true,
			response_format: {
				type: "video",
				aspect_ratio: call.aspectRatio,
				resolution: call.resolution,
				duration: `${call.durationSeconds}s`,
			},
		};
		let response: Response | undefined;
		let text: string;
		try {
			response = await fetchImpl(`${base(config)}/interactions`, {
				method: "POST",
				headers: headers(config),
				body: JSON.stringify(body),
				signal: call.signal,
			});
			// A create that finished at once carries the video: read enough for it.
			text = await readLimited(response, MAX_INLINE_VIDEO_BYTES);
		} catch (error) {
			return createFailure(LABEL, call.signal, error, response);
		}
		const interaction = parseJson(text);
		if (!response.ok)
			return httpFailure(
				LABEL,
				response,
				errorMessage(interaction, config.apiKey),
			);
		const id = field(interaction, "id");
		if (typeof id !== "string" || !id || id.length > 300)
			return failure(
				LABEL,
				"timeout",
				"the answer did not name an interaction",
			);
		const status = field(interaction, "status");
		if (status === "failed") {
			const { code, message } = interactionError(interaction, config.apiKey);
			const said = `${code ? ` (${providerMessage(code)})` : ""}${message ? `: ${message}` : ""}`;
			return SAFETY.test(`${code} ${message}`)
				? failure(LABEL, "refused", `Google refused the prompt${said}`)
				: failure(
						LABEL,
						"provider-error",
						`the video could not be started${said}`,
					);
		}
		return {
			outcome: "accepted",
			providerJobId: id,
			status:
				status === "in_progress" || status === "completed"
					? "running"
					: "queued",
		};
	},

	async poll(
		config: VideoConfig,
		providerJobId: string,
		signal: AbortSignal,
		fetchImpl: FetchLike,
	): Promise<VideoPollResult> {
		let response: Response;
		let text: string;
		try {
			response = await fetchImpl(interactionUrl(config, providerJobId), {
				method: "GET",
				headers: headers(config),
				signal,
			});
			text = await readLimited(response, MAX_INLINE_VIDEO_BYTES);
		} catch (error) {
			if (error instanceof ResponseTooLarge)
				return {
					state: "failed",
					code: "provider_error",
					detail: "Google: the video is larger than the gateway returns",
					billed: true,
				};
			return {
				state: "unknown",
				detail: signal.aborted
					? "Google: the status check ran out of time"
					: "Google: Google could not be reached",
			};
		}
		const interaction = parseJson(text);
		if (response.status === 404) return { state: "gone" };
		if (!response.ok) {
			const failed = httpFailure(
				LABEL,
				response,
				errorMessage(interaction, config.apiKey),
			);
			return {
				state: "unknown",
				detail: failed.detail,
				...(failed.problem ? { problem: failed.problem } : {}),
				...(response.status === 429
					? { retryAfterMs: retryAfterMs(response) }
					: {}),
			};
		}
		switch (field(interaction, "status")) {
			case "in_progress":
				return { state: "running", progress: null };
			case "completed":
				return findVideoBlock(interaction)?.data
					? { state: "succeeded", delivery: { kind: "bytes" } }
					: {
							state: "failed",
							code: "provider_error",
							detail: "Google: the finished interaction had no video",
							billed: true,
						};
			case "failed": {
				const { code, message } = interactionError(interaction, config.apiKey);
				const said = `${code ? ` (${providerMessage(code)})` : ""}${message ? `: ${message}` : ""}`;
				const moderated = SAFETY.test(`${code} ${message}`);
				return {
					state: "failed",
					code: moderated ? "moderated" : "provider_error",
					detail: moderated
						? `Google: Google refused the prompt${said}`
						: `Google: the video could not be made${said}`,
					billed: moderated,
				};
			}
			case "cancelled":
				return { state: "canceled" };
			case "requires_action":
			case "incomplete":
			case "requires_continuation":
				return {
					state: "failed",
					code: "provider_error",
					detail: "Google: the interaction stopped before making a video",
					billed: false,
				};
			default:
				return { state: "running", progress: null };
		}
	},

	async cancel(
		config: VideoConfig,
		providerJobId: string,
		signal: AbortSignal,
		fetchImpl: FetchLike,
	): Promise<void> {
		try {
			const response = await fetchImpl(
				`${interactionUrl(config, providerJobId)}/cancel`,
				{ method: "POST", headers: headers(config), signal },
			);
			void response.body?.cancel().catch(() => {});
		} catch {
			// The job is canceled here whether or not Google heard.
		}
	},

	async content(
		config: VideoConfig,
		providerJobId: string,
		signal: AbortSignal,
		fetchImpl: FetchLike,
	): Promise<VideoContent> {
		let response: Response;
		let text: string;
		try {
			response = await fetchImpl(interactionUrl(config, providerJobId), {
				method: "GET",
				headers: headers(config),
				signal,
			});
			text = await readLimited(response, MAX_INLINE_VIDEO_BYTES);
		} catch (error) {
			return {
				kind: "error",
				detail:
					error instanceof ResponseTooLarge
						? "the video is larger than the gateway returns"
						: "Google could not be reached",
			};
		}
		if (response.status === 404) return { kind: "gone" };
		if (!response.ok)
			return {
				kind: "error",
				detail: `Google answered HTTP ${response.status}`,
			};
		const data = findVideoBlock(parseJson(text))?.data;
		if (!data) return { kind: "gone" };
		const bytes = Buffer.from(data, "base64");
		if (!bytes.byteLength) return { kind: "gone" };
		return {
			kind: "ok",
			bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength),
			contentType: "video/mp4",
		};
	},
};
