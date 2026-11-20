/**
 * Video generation for agents and scripts: the `video_*` tools, the
 * `/v1/<workspace>/video` routes, and the providers a workspace connects.
 * See docs/VIDEO_MODELS_PLAN.md.
 */
import type { TelemetryCaller } from "./analytics.js";

/** Provider kinds a video connection can be. */
export const VIDEO_KINDS = ["google", "runway", "luma"] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];

export const VIDEO_KIND_LABELS: Record<VideoKind, string> = {
	google: "Google Gemini Omni",
	runway: "Runway",
	luma: "Luma Ray",
};

export const VIDEO_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const VIDEO_JOB_ID_PATTERN = /^vid_[0-9a-f-]{36}$/;
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export const VIDEO_RESOLUTIONS = [
	"360p",
	"480p",
	"540p",
	"720p",
	"1080p",
] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const VIDEO_LIMITS = {
	/** Video connections per workspace. */
	connections: 10,
	promptLength: 4000,
	urlLength: 2048,
	minDurationSeconds: 2,
	maxDurationSeconds: 30,
	maxWaitSeconds: 60,
	defaultListLimit: 20,
	maxListLimit: 100,
	/** What an agent may ask `video_list` for. */
	maxAgentListLimit: 20,
	maxCallerVideosPerDay: 10_000,
	keyLength: 4096,
	/** How long the gateway keeps a job record. */
	jobRetentionDays: 30,
	/** Polls of one job are at least this far apart, whoever asks. */
	pollIntervalMs: 5000,
	/** Luma only: what one credit may cost, in US dollars. */
	maxCreditPriceUsd: 10,
} as const;

/** What one model can make. Prices stay on the server. */
export type VideoModel = {
	/** The provider's own id. */
	id: string;
	label: string;
	inputs: ReadonlyArray<"text" | "image">;
	/** Whole seconds: a range, or the only values allowed. */
	durations: { min: number; max: number } | readonly number[];
	aspectRatios: readonly VideoAspectRatio[];
	resolutions: readonly VideoResolution[];
	/** The longest prompt the model takes, in characters. */
	promptLength: number;
	defaults: {
		durationSeconds: number;
		aspectRatio: VideoAspectRatio;
		resolution: VideoResolution;
	};
	/** Whether the video comes with a soundtrack. */
	audio: boolean;
};

/**
 * The models each kind offers. Limits come from each provider's API
 * reference (docs/VIDEO_MODELS_PLAN.md §4); the provider still checks.
 */
export const VIDEO_MODELS: Record<VideoKind, readonly VideoModel[]> = {
	google: [
		{
			id: "gemini-omni-1.2-flash",
			label: "Gemini Omni 1.2 Flash",
			// Images reach Gemini as uploaded bytes, which the gateway does not fetch.
			inputs: ["text"],
			// Google returns up to 15 s, but advises URI delivery above 4 MB;
			// until that is built, videos stay short enough to return inline.
			durations: { min: 3, max: 10 },
			aspectRatios: ["16:9", "9:16"],
			// 1080p and 4K are upscaled and too large to return inline.
			resolutions: ["360p", "720p"],
			promptLength: 4000,
			defaults: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" },
			audio: true,
		},
	],
	runway: [
		{
			id: "seedance2_5",
			label: "Seedance 2.5",
			inputs: ["text", "image"],
			durations: { min: 4, max: 30 },
			aspectRatios: ["16:9", "9:16", "1:1"],
			resolutions: ["480p", "720p", "1080p"],
			promptLength: 4000,
			defaults: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" },
			audio: true,
		},
		{
			id: "gen4.5",
			label: "Runway Gen-4.5",
			inputs: ["text", "image"],
			durations: { min: 2, max: 10 },
			aspectRatios: ["16:9", "9:16"],
			resolutions: ["720p"],
			promptLength: 1000,
			defaults: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" },
			audio: false,
		},
	],
	luma: [
		{
			id: "ray-3.2",
			label: "Luma Ray 3.2",
			inputs: ["text", "image"],
			durations: [5, 10],
			aspectRatios: ["16:9", "9:16", "1:1"],
			resolutions: ["360p", "540p", "720p", "1080p"],
			promptLength: 4000,
			defaults: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p" },
			audio: false,
		},
	],
};

/** The model a connection uses when neither it nor the caller names one. */
export const DEFAULT_VIDEO_MODEL: Record<VideoKind, string> = {
	google: "gemini-omni-1.2-flash",
	runway: "seedance2_5",
	luma: "ray-3.2",
};

export function videoModel(
	kind: VideoKind,
	id: string,
): VideoModel | undefined {
	return VIDEO_MODELS[kind]?.find((model) => model.id === id);
}

/** The durations a model allows, in words, such as `4 to 30` or `5 or 10`. */
export function videoDurationsText(model: VideoModel): string {
	const { durations } = model;
	if ("min" in durations) return `${durations.min} to ${durations.max}`;
	return durations.length > 1
		? `${durations.slice(0, -1).join(", ")} or ${durations.at(-1)}`
		: String(durations[0]);
}

/** Whether a model makes a video of `seconds`. */
export function videoDurationAllowed(
	model: VideoModel,
	seconds: number,
): boolean {
	const { durations } = model;
	if (!Number.isInteger(seconds)) return false;
	return "min" in durations
		? seconds >= durations.min && seconds <= durations.max
		: durations.includes(seconds);
}

/** Why a model cannot make this, naming what it allows, or null when it can. */
export function videoModelProblem(
	model: VideoModel,
	want: {
		durationSeconds: number;
		aspectRatio: VideoAspectRatio;
		resolution: VideoResolution;
		image: boolean;
		promptLength?: number;
	},
): string | null {
	if (want.image && !model.inputs.includes("image"))
		return `${model.id} does not start from an image.`;
	if (!videoDurationAllowed(model, want.durationSeconds))
		return `${model.id} makes videos of ${videoDurationsText(model)} seconds.`;
	if (!model.aspectRatios.includes(want.aspectRatio))
		return `${model.id} makes ${model.aspectRatios.join(", ")} videos.`;
	if (!model.resolutions.includes(want.resolution))
		return `${model.id} makes ${model.resolutions.join(", ")} videos.`;
	if (want.promptLength !== undefined && want.promptLength > model.promptLength)
		return `${model.id} takes prompts of up to ${model.promptLength} characters.`;
	return null;
}

/** One workspace's video settings. */
export type VideoPolicy = {
	/** Connection names, first tried first. Ones not listed follow in the order added. */
	order: string[];
	/** Videos one person, token, or agent may start in a UTC day. */
	callerVideosPerDay: number;
	/** The longest video anyone may ask for, in seconds. */
	maxDurationSeconds: number;
	revision: number;
};

export const DEFAULT_VIDEO_POLICY: Omit<VideoPolicy, "revision"> = {
	order: [],
	callerVideosPerDay: 10,
	maxDurationSeconds: 10,
};

export type UpdateVideoPolicyRequest = Omit<VideoPolicy, "revision"> & {
	/** The revision the caller read; a stale one is refused with 409. */
	revision: number;
};

/** Something wrong with a connection that a person has to fix. */
export type VideoProblem = {
	kind: "key" | "credits";
	detail: string;
	at: string;
};

/** A connection as the API shows it. Never the key. */
export type VideoConnection = {
	name: string;
	kind: VideoKind;
	keyConfigured: boolean;
	enabled: boolean;
	defaultModel?: string;
	/** Luma only: what one credit costs on your plan, in US dollars. */
	creditPriceUsd?: number;
	source: "saved" | "environment";
	usage: { month: string; videos: number; costUsd: number };
	problem: VideoProblem | null;
};

export type CreateVideoConnectionRequest = {
	name: string;
	kind: VideoKind;
	apiKey: string;
	enabled?: boolean;
	defaultModel?: string;
	creditPriceUsd?: number;
};

/** Fields to change. `apiKey` omitted keeps the saved key; `defaultModel: ""` clears it. */
export type UpdateVideoConnectionRequest = Partial<
	Omit<CreateVideoConnectionRequest, "name" | "kind">
>;

export type VideoSettings = {
	/** False when the gateway's operator turned video off (`VIDEO_DISABLED`). */
	available: boolean;
	/** True when this workspace has a connection that can be used now. */
	configured: boolean;
	connections: VideoConnection[];
	policy: VideoPolicy;
	/** Estimated video spend this month (UTC). Limits on it are budgets. */
	spend: { month: string; spentUsd: number };
	persistence: "mongodb" | "memory";
};

export type VideoGenerateRequest = {
	prompt: string;
	/** A connection name. Omitted: the workspace's first usable one. */
	provider?: string;
	model?: string;
	durationSeconds?: number;
	aspectRatio?: VideoAspectRatio;
	resolution?: VideoResolution;
	/** An https image to start from, for models that take one. */
	imageUrl?: string;
};

export const VIDEO_JOB_STATUSES = [
	"queued",
	"running",
	"succeeded",
	"failed",
	"canceled",
	"expired",
] as const;
export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];

/** Whether a job has stopped changing (an expired one has only lost its video). */
export const videoJobFinished = (status: VideoJobStatus): boolean =>
	status !== "queued" && status !== "running";

export type VideoJobErrorCode =
	| "moderated"
	| "invalid_input"
	| "provider_error"
	| "timeout"
	| "not_started";

export type VideoAttempt = {
	/** A connection name. */
	provider: string;
	model: string;
	outcome:
		| "accepted"
		| "provider-error"
		| "refused"
		| "invalid"
		| "timeout"
		| "skipped";
	/** Short, and never a key or a provider URL. */
	detail?: string;
};

export type VideoJob = {
	/** `vid_<uuid>`: the gateway's id, never the provider's. */
	id: string;
	status: VideoJobStatus;
	/** 0 to 100 where the provider says; otherwise null. */
	progress: number | null;
	/** A connection name. */
	provider: string;
	kind: VideoKind;
	model: string;
	prompt: string;
	durationSeconds: number;
	aspectRatio: VideoAspectRatio;
	resolution: VideoResolution;
	hasImage: boolean;
	createdBy: TelemetryCaller;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	/** An estimate from list prices, held against the budgets that cover it. */
	costUsd: number;
	/** Set when succeeded: a gateway link that redirects to or streams the MP4. */
	video: { url: string; contentType: "video/mp4"; expiresAt: string } | null;
	/** Set when failed. */
	error: { code: VideoJobErrorCode; message: string } | null;
	/** What was tried to start it. */
	attempts: VideoAttempt[];
};

export type VideoJobList = { jobs: VideoJob[]; nextBefore: string | null };

/** What `video_models` and `GET /video/models` return. */
export type VideoModelList = {
	/** Whether this workspace can make a video now. */
	available: boolean;
	/** Why not, in words an agent can pass on. */
	reason?: string;
	/** Whether the caller holds the grant to start one. */
	canGenerate: boolean;
	providers: Array<{
		name: string;
		kind: VideoKind;
		defaultModel: string;
		models: VideoModel[];
	}>;
	limits: { maxDurationSeconds: number; promptLength: number };
};
