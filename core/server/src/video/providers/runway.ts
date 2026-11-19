import type { VideoAspectRatio, VideoResolution } from "@autonomo.us/common";
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

const ENDPOINT = "https://api.dev.runwayml.com";
const VERSION = "2024-11-06";
const LABEL = "Runway";
const USD_PER_CREDIT = 0.01;
/** Runway's output links "expire within 24-48 hours". */
const RESULT_TTL_MS = 24 * 3_600_000;
/** What a second costs where the table has no row, so a gap cannot slip under the budget. */
const UNKNOWN_USD_PER_SECOND = 0.5;

/** Credits a second of output costs, by model and resolution, and each model's minimum. */
const CREDITS: Record<
	string,
	{ perSecond: Partial<Record<VideoResolution, number>>; minimum: number }
> = {
	seedance2_5: {
		perSecond: { "480p": 20, "720p": 30, "1080p": 68 },
		minimum: 80,
	},
	"gen4.5": { perSecond: { "720p": 12 }, minimum: 0 },
};

/** Runway names an output's size by its pixels: `ratio`. */
const RATIOS: Partial<
	Record<VideoResolution, Partial<Record<VideoAspectRatio, string>>>
> = {
	"480p": { "16:9": "854:480", "9:16": "480:854", "1:1": "640:640" },
	"720p": { "16:9": "1280:720", "9:16": "720:1280", "1:1": "960:960" },
	"1080p": { "16:9": "1920:1080", "9:16": "1080:1920", "1:1": "1440:1440" },
};

function base(config: VideoConfig) {
	return (config.baseUrl ?? ENDPOINT).replace(/\/+$/, "");
}

function headers(config: VideoConfig): Record<string, string> {
	return jsonHeaders({
		authorization: `Bearer ${config.apiKey}`,
		"x-runway-version": VERSION,
	});
}

/** Runway's error text: `error`, then the first validation issue. */
function errorMessage(body: unknown, apiKey?: string): string {
	const error = field(body, "error");
	const issues = field(body, "issues");
	const issue = Array.isArray(issues) ? field(issues[0], "message") : undefined;
	const path = Array.isArray(issues) ? field(issues[0], "path") : undefined;
	return providerMessage(
		[
			typeof error === "string" ? error : "",
			typeof issue === "string"
				? `${Array.isArray(path) ? `${path.join(".")}: ` : ""}${issue}`
				: "",
		]
			.filter(Boolean)
			.join(" — "),
		apiKey,
	);
}

/** Credits a finished task reports it charged, or null when it did not say. */
function chargedCredits(task: unknown): number | null {
	const credits = field(field(task, "cost"), "credits");
	return typeof credits === "number" && Number.isFinite(credits)
		? credits
		: null;
}

/**
 * Runway's developer API: one create endpoint per input kind and one task
 * endpoint to follow it. Runway downloads a start image itself, from an
 * https URL, so the gateway never fetches it.
 */
export const runwayAdapter: VideoAdapter = {
	kind: "runway",
	resultTtlMs: RESULT_TTL_MS,

	estimateCostUsd(_config, call): number {
		const price = CREDITS[call.model];
		const perSecond = price?.perSecond[call.resolution];
		if (perSecond === undefined)
			return UNKNOWN_USD_PER_SECOND * call.durationSeconds;
		return (
			Math.max(perSecond * call.durationSeconds, price.minimum) * USD_PER_CREDIT
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
		const ratio = RATIOS[call.resolution]?.[call.aspectRatio];
		if (!ratio)
			return failure(
				LABEL,
				"invalid",
				`no ${call.aspectRatio} size at ${call.resolution}`,
			);
		const body = {
			model: call.model,
			promptText: call.prompt,
			ratio,
			duration: call.durationSeconds,
			...(call.imageUrl ? { promptImage: call.imageUrl } : {}),
		};
		const path = call.imageUrl ? "/v1/image_to_video" : "/v1/text_to_video";
		let response: Response | undefined;
		let text: string;
		try {
			response = await fetchImpl(`${base(config)}${path}`, {
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
			// Runway may have started a task it did not name: treat it as maybe-billed.
			return failure(LABEL, "timeout", "the answer did not name a task");
		return { outcome: "accepted", providerJobId: id, status: "queued" };
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
				`${base(config)}/v1/tasks/${encodeURIComponent(providerJobId)}`,
				{ method: "GET", headers: headers(config), signal },
			);
			text = await readLimited(response, MAX_ANSWER_BYTES);
		} catch {
			return {
				state: "unknown",
				detail: signal.aborted
					? "Runway: the status check ran out of time"
					: "Runway: Runway could not be reached",
			};
		}
		const task = parseJson(text);
		if (response.status === 404) return { state: "gone" };
		if (!response.ok) {
			const failed = httpFailure(
				LABEL,
				response,
				errorMessage(task, config.apiKey),
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
		const status = field(task, "status");
		switch (status) {
			case "PENDING":
			case "THROTTLED":
				return { state: "queued", progress: null };
			case "RUNNING": {
				const progress = field(task, "progress");
				return {
					state: "running",
					progress:
						typeof progress === "number" && progress >= 0 && progress <= 1
							? Math.round(progress * 100)
							: null,
				};
			}
			case "SUCCEEDED": {
				const output = field(task, "output");
				const url = safeResultUrl(Array.isArray(output) ? output[0] : null);
				if (!url)
					return {
						state: "failed",
						code: "provider_error",
						detail: "Runway: the finished task had no usable video link",
						billed: true,
					};
				return {
					state: "succeeded",
					delivery: { kind: "url", url, ttlMs: RESULT_TTL_MS },
				};
			}
			case "FAILED": {
				const code = field(task, "failureCode");
				const codeText = typeof code === "string" ? code : "";
				const reason = providerMessage(field(task, "failure"), config.apiKey);
				const credits = chargedCredits(task);
				const moderated =
					codeText.startsWith("SAFETY.") ||
					codeText.startsWith("INPUT_PREPROCESSING.SAFETY.");
				const detail = `Runway: ${
					moderated
						? "Runway refused the prompt"
						: codeText === "ASSET.INVALID"
							? "Runway could not use the image"
							: "the video could not be made"
				}${codeText ? ` (${providerMessage(codeText)})` : ""}${reason ? `: ${reason}` : ""}`;
				return {
					state: "failed",
					code: moderated
						? "moderated"
						: codeText === "ASSET.INVALID"
							? "invalid_input"
							: "provider_error",
					detail,
					// What Runway reports it charged decides; without it, input
					// moderation is the one failure Runway does not refund.
					billed:
						credits !== null
							? credits > 0
							: codeText.startsWith("SAFETY.INPUT"),
				};
			}
			case "CANCELLED":
			case "CANCELED":
				return { state: "canceled" };
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
				`${base(config)}/v1/tasks/${encodeURIComponent(providerJobId)}`,
				{ method: "DELETE", headers: headers(config), signal },
			);
			void response.body?.cancel().catch(() => {});
		} catch {
			// A cancel that does not arrive leaves the task to finish; the job is canceled here either way.
		}
	},
};
