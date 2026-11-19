import type { VideoResolution } from "@autonomo.us/common";
import type {
	FetchLike,
	VideoAdapter,
	VideoCall,
	VideoConfig,
	VideoCreateResult,
	VideoPollResult,
} from "../types.js";
import {
	createFailure,
	failure,
	field,
	httpFailure,
	jsonHeaders,
	MAX_ANSWER_BYTES,
	parseJson,
	providerMessage,
	readLimited,
	retryAfterMs,
	safeResultUrl,
} from "./shared.js";

const ENDPOINT = "https://agents.lumalabs.ai";
const LABEL = "Luma";
/** Luma's presigned links last an hour; every poll mints a new one. */
const LINK_TTL_MS = 55 * 60_000;
/** How long Luma keeps the file behind the links: not published, so a week, ended sooner by a `gone` poll. */
export const LUMA_RESULT_TTL_MS = 7 * 24 * 3_600_000;
/** What a credit costs when the connection does not say. */
const DEFAULT_CREDIT_USD = 0.01;
const UNKNOWN_USD_PER_SECOND = 0.5;

/** Credits per video, by duration and resolution (Luma Agents API pricing). */
const CREDITS: Record<number, Partial<Record<VideoResolution, number>>> = {
	5: { "360p": 20, "540p": 50, "720p": 100, "1080p": 400 },
	10: { "360p": 60, "540p": 150, "720p": 300, "1080p": 1200 },
};

function base(config: VideoConfig) {
	return (config.baseUrl ?? ENDPOINT).replace(/\/+$/, "");
}

function headers(config: VideoConfig): Record<string, string> {
	return jsonHeaders({ authorization: `Bearer ${config.apiKey}` });
}

/** Luma's error text: `detail`, a string or FastAPI's list of problems. */
function errorMessage(body: unknown, apiKey?: string): string {
	const detail = field(body, "detail");
	if (typeof detail === "string") return providerMessage(detail, apiKey);
	if (Array.isArray(detail)) {
		const first = detail[0];
		const message = field(first, "msg");
		const location = field(first, "loc");
		return providerMessage(
			typeof message === "string"
				? `${Array.isArray(location) ? `${location.join(".")}: ` : ""}${message}`
				: "",
			apiKey,
		);
	}
	return "";
}

/** Credits Luma reports it charged, once billing settles, or null when it has not said. */
function chargedCredits(generation: unknown): number | null {
	const credits = field(field(generation, "usage"), "credits_charged");
	return typeof credits === "number" && Number.isFinite(credits)
		? credits
		: null;
}

/**
 * Luma Ray through the Luma Agents API: one create endpoint and one poll
 * endpoint. Luma has no cancel. Luma downloads a start image itself, from
 * a public URL, so the gateway never fetches it.
 */
export const lumaAdapter: VideoAdapter = {
	kind: "luma",
	resultTtlMs: LUMA_RESULT_TTL_MS,

	estimateCostUsd(config, call): number {
		const credits = CREDITS[call.durationSeconds]?.[call.resolution];
		if (credits === undefined)
			return UNKNOWN_USD_PER_SECOND * call.durationSeconds;
		return credits * (config.creditPriceUsd ?? DEFAULT_CREDIT_USD);
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
		const body = {
			model: call.model,
			type: "video",
			prompt: call.prompt,
			aspect_ratio: call.aspectRatio,
			video: {
				duration: `${call.durationSeconds}s`,
				resolution: call.resolution,
				...(call.imageUrl ? { start_frame: { url: call.imageUrl } } : {}),
			},
		};
		let response: Response | undefined;
		let text: string;
		try {
			response = await fetchImpl(`${base(config)}/v1/generations`, {
				method: "POST",
				headers: headers(config),
				body: JSON.stringify(body),
				signal: call.signal,
			});
			text = await readLimited(response, MAX_ANSWER_BYTES);
		} catch (error) {
			return createFailure(LABEL, call.signal, error, response);
		}
		const parsed = parseJson(text);
		if (!response.ok)
			return httpFailure(LABEL, response, errorMessage(parsed, config.apiKey));
		const id = field(parsed, "id");
		if (typeof id !== "string" || !id || id.length > 200)
			return failure(LABEL, "timeout", "the answer did not name a generation");
		return {
			outcome: "accepted",
			providerJobId: id,
			status: field(parsed, "state") === "processing" ? "running" : "queued",
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
			response = await fetchImpl(
				`${base(config)}/v1/generations/${encodeURIComponent(providerJobId)}`,
				{ method: "GET", headers: headers(config), signal },
			);
			text = await readLimited(response, MAX_ANSWER_BYTES);
		} catch {
			return {
				state: "unknown",
				detail: signal.aborted
					? "Luma: the status check ran out of time"
					: "Luma: Luma could not be reached",
			};
		}
		const generation = parseJson(text);
		if (response.status === 404) return { state: "gone" };
		if (!response.ok) {
			const failed = httpFailure(
				LABEL,
				response,
				errorMessage(generation, config.apiKey),
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
		switch (field(generation, "state")) {
			case "queued":
				return { state: "queued", progress: null };
			case "processing":
				return { state: "running", progress: null };
			case "completed": {
				const output = field(generation, "output");
				const video = Array.isArray(output)
					? output.find((item) => field(item, "type") === "video")
					: undefined;
				const url = safeResultUrl(field(video, "url"));
				if (!url)
					return {
						state: "failed",
						code: "provider_error",
						detail: "Luma: the finished generation had no usable video link",
						billed: true,
					};
				return {
					state: "succeeded",
					delivery: { kind: "url", url, ttlMs: LINK_TTL_MS },
				};
			}
			case "failed": {
				const code = field(generation, "failure_code");
				const codeText = typeof code === "string" ? code : "";
				const reason = providerMessage(
					field(generation, "failure_reason"),
					config.apiKey,
				);
				const tag = `${codeText ? ` (${providerMessage(codeText)})` : ""}${reason ? `: ${reason}` : ""}`;
				const credits = chargedCredits(generation);
				switch (codeText) {
					case "content_moderated":
						// What Luma reports it charged decides; until it says, the
						// refusal counts as spent, so the budget reads high, never low.
						return {
							state: "failed",
							code: "moderated",
							detail: `Luma: Luma refused the prompt${tag}`,
							billed: credits === null || credits > 0,
						};
					case "image_too_large":
					case "unsupported_format":
					case "corrupt_input":
					case "invalid_request":
						return {
							state: "failed",
							code: "invalid_input",
							detail: `Luma: Luma could not use the request${tag}`,
							billed: false,
						};
					case "output_not_found":
						return { state: "gone" };
					case "budget_exhausted":
						return {
							state: "failed",
							code: "provider_error",
							detail: `Luma: the account is out of credits${tag}`,
							billed: false,
							problem: "credits",
						};
					default:
						return {
							state: "failed",
							code: "provider_error",
							detail: `Luma: the video could not be made${tag}`,
							billed: false,
						};
				}
			}
			default:
				return { state: "running", progress: null };
		}
	},
};
