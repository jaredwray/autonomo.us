import type {
	VideoAspectRatio,
	VideoJobErrorCode,
	VideoKind,
	VideoResolution,
} from "@autonomo.us/common";
import type { FetchLike } from "../web/types.js";

export type { FetchLike };

/** A connection as the server holds it, key included. Never sent to a client. */
export type VideoConfig = {
	name: string;
	kind: VideoKind;
	apiKey?: string;
	enabled: boolean;
	defaultModel?: string;
	/** Luma only: what one credit costs on the plan, in US dollars. */
	creditPriceUsd?: number;
	/** Environment connections only: another endpoint, for tests. */
	baseUrl?: string;
};

/** One request to start a video. Everything has been checked against the model. */
export type VideoCall = {
	model: string;
	prompt: string;
	durationSeconds: number;
	aspectRatio: VideoAspectRatio;
	resolution: VideoResolution;
	/** An https URL that passed `checkTargetUrl`. */
	imageUrl?: string;
	signal: AbortSignal;
};

/** A call that did not go through. */
export type VideoFailure = {
	/**
	 * `provider-error`: nothing was accepted and another provider may work.
	 * `refused`: the provider's moderation said no. `invalid`: the provider
	 * found the request wrong. `timeout`: the call ran out of time and the
	 * provider may have accepted it.
	 */
	outcome: "provider-error" | "refused" | "invalid" | "timeout";
	/** Short and safe to show: never a key or a provider URL. */
	detail: string;
	/** False when the provider charged nothing. */
	billed: boolean;
	/** Something a person has to fix on the connection. */
	problem?: "key" | "credits";
	/** The provider asked the gateway to slow down. */
	retryAfterMs?: number;
};

export type VideoCreateResult =
	| {
			outcome: "accepted";
			providerJobId: string;
			status: "queued" | "running";
	  }
	| VideoFailure;

/** Where a finished video can be had, as a provider reports it. */
export type VideoDelivery =
	/** A provider link anyone holding it can fetch, for `ttlMs` from now. */
	| { kind: "url"; url: string; ttlMs: number }
	/** Only `content()` can get it, with the connection's key. */
	| { kind: "bytes" };

/** A delivery as a job record keeps it. */
export type StoredDelivery =
	/** `expiresAt` is epoch milliseconds. */
	{ kind: "url"; url: string; expiresAt: number } | { kind: "bytes" };

export type VideoPollResult =
	| { state: "queued" | "running"; progress: number | null }
	| { state: "succeeded"; delivery: VideoDelivery }
	| {
			state: "failed";
			code: VideoJobErrorCode;
			detail: string;
			billed: boolean;
			problem?: "key" | "credits";
	  }
	| { state: "canceled" }
	/** The provider no longer has the job or its video. */
	| { state: "gone" }
	/** The poll itself failed; the job is as it was. */
	| {
			state: "unknown";
			detail: string;
			retryAfterMs?: number;
			problem?: "key" | "credits";
	  };

/** One provider kind: how to start, follow, and fetch a video. */
export interface VideoAdapter {
	readonly kind: VideoKind;
	/** How long a finished video can be fetched, counted from when the gateway saw it finish. */
	readonly resultTtlMs: number;
	/** A list-price estimate, held against the budget before the call. */
	estimateCostUsd(config: VideoConfig, call: Omit<VideoCall, "signal">): number;
	create(
		config: VideoConfig,
		call: VideoCall,
		fetchImpl: FetchLike,
	): Promise<VideoCreateResult>;
	poll(
		config: VideoConfig,
		providerJobId: string,
		signal: AbortSignal,
		fetchImpl: FetchLike,
	): Promise<VideoPollResult>;
	/** Absent where the provider has no cancel. Never throws. */
	cancel?(
		config: VideoConfig,
		providerJobId: string,
		signal: AbortSignal,
		fetchImpl: FetchLike,
	): Promise<void>;
	/** Only for `bytes` delivery: the video, or null when it is gone. */
	content?(
		config: VideoConfig,
		providerJobId: string,
		signal: AbortSignal,
		fetchImpl: FetchLike,
	): Promise<VideoContent>;
}

export type VideoContent =
	| { kind: "ok"; bytes: Uint8Array; contentType: "video/mp4" }
	| { kind: "gone" }
	| { kind: "error"; detail: string };
