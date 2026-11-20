import { randomUUID } from "node:crypto";
import {
	type TelemetryCaller,
	type UpdateVideoLimitRequest,
	VIDEO_LIMITS,
	type VideoLimit,
	type VideoLimitCovers,
	type VideoLimitInput,
	videoLimitCovers,
	videoLimitProblem,
	videoModelLabel,
} from "@autonomo.us/common";
import { normalizeAppliesTo } from "../budgets/service.js";
import { ServiceError } from "../service-error.js";
import type { WorkspaceRef } from "../workspaces/store.js";
import type { VideoLimitCount, VideoStore } from "./store.js";

/**
 * Video limits: policies that cap how many videos each person, API token,
 * or agent may start in a UTC day, and how long a video may be, for
 * everyone or chosen agents, on every video model or one. Every limit that
 * covers a video applies, so the strictest wins.
 */
export class VideoLimits {
	private readonly now: () => Date;

	constructor(
		private readonly store: VideoStore,
		private readonly options: {
			now?: () => Date;
			/** The ids of the workspace's agents, to check the agents a limit names. */
			knownAgents?: (workspace: WorkspaceRef) => Promise<Set<string>>;
		} = {},
	) {
		this.now = options.now ?? (() => new Date());
	}

	async list(workspace: WorkspaceRef): Promise<VideoLimit[]> {
		return (await this.store.limits(workspace.id)).limits;
	}

	async create(
		workspace: WorkspaceRef,
		input: VideoLimitInput,
	): Promise<VideoLimit> {
		const at = this.now().toISOString();
		const limit: VideoLimit = {
			id: randomUUID(),
			...(await this.check(workspace, input)),
			enabled: input.enabled ?? true,
			createdAt: at,
			updatedAt: at,
		};
		await this.change(workspace.id, async (limits) => {
			if (limits.length >= VIDEO_LIMITS.limitPolicies)
				throw new ServiceError(
					`A workspace holds at most ${VIDEO_LIMITS.limitPolicies} video limits.`,
					409,
				);
			return [...limits, limit];
		});
		return limit;
	}

	/** Changes the fields sent, merged into the limit as it is on each try. */
	async update(
		workspace: WorkspaceRef,
		id: string,
		input: UpdateVideoLimitRequest,
	): Promise<VideoLimit> {
		let updated: VideoLimit | undefined;
		await this.change(workspace.id, async (limits) => {
			const current = limits.find((limit) => limit.id === id);
			if (!current) throw new ServiceError("Video limit not found.", 404);
			const checked = await this.check(
				workspace,
				{
					appliesTo: input.appliesTo ?? current.appliesTo,
					covers: input.covers ?? current.covers,
					videosPerDay:
						input.videosPerDay !== undefined
							? input.videosPerDay
							: current.videosPerDay,
					maxDurationSeconds:
						input.maxDurationSeconds !== undefined
							? input.maxDurationSeconds
							: current.maxDurationSeconds,
				},
				current,
				input.covers !== undefined,
			);
			updated = {
				...current,
				...checked,
				enabled: input.enabled ?? current.enabled,
				updatedAt: this.now().toISOString(),
			};
			const next = updated;
			return limits.map((limit) => (limit.id === id ? next : limit));
		});
		if (!updated) throw new ServiceError("Video limit not found.", 404);
		return updated;
	}

	async remove(workspace: WorkspaceRef, id: string): Promise<void> {
		let found = false;
		await this.change(workspace.id, async (limits) => {
			found = limits.some((limit) => limit.id === id);
			return limits.filter((limit) => limit.id !== id);
		});
		if (!found) throw new ServiceError("Video limit not found.", 404);
	}

	/** Applies `edit` to a fresh read; a lost race is retried with another. */
	private async change(
		workspaceId: string,
		edit: (limits: VideoLimit[]) => Promise<VideoLimit[]>,
	): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const { limits, revision } = await this.store.limits(workspaceId);
			// Only a lost write is retried; a refusal from `edit` is final.
			const next = await edit(limits);
			try {
				await this.store.writeLimits(workspaceId, next, revision);
				return;
			} catch (error) {
				const raced = error instanceof ServiceError && error.statusCode === 409;
				if (!raced || attempt >= 4) throw error;
			}
		}
	}

	/**
	 * Checks what a person sent. Agents a limit already names may have been
	 * removed since; a video model is checked only when it is sent.
	 */
	private async check(
		workspace: WorkspaceRef,
		input: VideoLimitInput,
		current?: VideoLimit,
		coversSent = true,
	): Promise<
		Pick<
			VideoLimit,
			"appliesTo" | "covers" | "videosPerDay" | "maxDurationSeconds"
		>
	> {
		const appliesTo = normalizeAppliesTo(input.appliesTo);
		const covers = coversSent
			? normalizeLimitCovers(input.covers)
			: input.covers;
		const videosPerDay = input.videosPerDay ?? null;
		const maxDurationSeconds = input.maxDurationSeconds ?? null;
		const problem = videoLimitProblem({
			appliesTo,
			covers,
			videosPerDay,
			maxDurationSeconds,
		});
		if (problem) throw new ServiceError(problem);
		if (appliesTo.kind === "agents" && this.options.knownAgents) {
			const before = new Set(
				current?.appliesTo.kind === "agents" ? current.appliesTo.agentIds : [],
			);
			const added = appliesTo.agentIds.filter((id) => !before.has(id));
			if (added.length) {
				const known = await this.options.knownAgents(workspace);
				const unknown = added.find((id) => !known.has(id));
				if (unknown)
					throw new ServiceError(
						`${unknown} is not an agent in this workspace.`,
					);
			}
		}
		return { appliesTo, covers, videosPerDay, maxDurationSeconds };
	}

	/**
	 * What the limits that cover this caller's video on `model` allow: the
	 * longest video (the shortest cap among them), and each limit's count of
	 * the caller's videos today with its cap.
	 */
	async forVideo(
		workspace: WorkspaceRef,
		caller: TelemetryCaller,
		model: string,
	): Promise<{ maxDurationSeconds: number; counts: VideoLimitCount[] }> {
		const limits = (await this.list(workspace)).filter((limit) =>
			videoLimitCovers(limit, caller, model),
		);
		const day = this.store.today();
		return {
			maxDurationSeconds: Math.min(
				VIDEO_LIMITS.maxDurationSeconds,
				...limits.map(
					(limit) =>
						limit.maxDurationSeconds ?? VIDEO_LIMITS.maxDurationSeconds,
				),
			),
			counts: limits
				.filter((limit) => limit.videosPerDay !== null)
				.map((limit) => ({
					key: this.store.limitKey(workspace, limit, caller.id, day),
					cap: limit.videosPerDay ?? 0,
					...(limit.covers.kind === "video-model"
						? { model: limit.covers.model }
						: {}),
				})),
		};
	}

	/**
	 * The longest video this caller may make on any model, and shorter caps
	 * for single models, for `video_models` and the form that makes a video.
	 */
	async durations(
		workspace: WorkspaceRef,
		caller: TelemetryCaller | undefined,
		models: string[],
	): Promise<{ all: number; byModel: Record<string, number> }> {
		const limits = (await this.list(workspace)).filter(
			(limit) =>
				limit.maxDurationSeconds !== null &&
				videoLimitCovers(
					limit,
					caller,
					limit.covers.kind === "video-model" ? limit.covers.model : "",
				),
		);
		const all = Math.min(
			VIDEO_LIMITS.maxDurationSeconds,
			...limits
				.filter((limit) => limit.covers.kind === "video")
				.map((limit) => limit.maxDurationSeconds ?? Number.POSITIVE_INFINITY),
		);
		const byModel: Record<string, number> = {};
		for (const model of models) {
			const cap = Math.min(
				all,
				...limits
					.filter(
						(limit) =>
							limit.covers.kind === "video-model" &&
							limit.covers.model === model,
					)
					.map((limit) => limit.maxDurationSeconds ?? Number.POSITIVE_INFINITY),
			);
			if (cap < all) byModel[model] = cap;
		}
		return { all, byModel };
	}
}

function normalizeLimitCovers(input: VideoLimitCovers): VideoLimitCovers {
	if (input?.kind === "video") return { kind: "video" };
	if (input?.kind === "video-model") {
		const model = String(input.model ?? "").trim();
		if (model && videoModelLabel(model) === model)
			throw new ServiceError(`${model} is not a video model.`);
		return { kind: "video-model", model };
	}
	throw new ServiceError("A limit covers every video model or one.");
}
