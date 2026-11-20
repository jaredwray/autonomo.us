import { randomBytes, randomUUID } from "node:crypto";
import {
	DEFAULT_VIDEO_MODEL,
	type TelemetryCaller,
	VIDEO_ASPECT_RATIOS,
	VIDEO_KIND_LABELS,
	VIDEO_LIMITS,
	VIDEO_MODELS,
	VIDEO_RESOLUTIONS,
	type VideoAttempt,
	type VideoGenerateRequest,
	type VideoJob,
	type VideoJobErrorCode,
	type VideoJobList,
	type VideoKind,
	type VideoModel,
	type VideoModelList,
	type VideoPolicy,
	type VideoProblem,
	type VideoSettings,
	videoJobFinished,
	videoModel,
	videoModelProblem,
} from "@autonomo.us/common";
import type { BudgetService } from "../budgets/service.js";
import { ServiceError } from "../service-error.js";
import type { TelemetryService } from "../telemetry/telemetry.js";
import { checkTargetUrl } from "../web/url-guard.js";
import type { WorkspaceRef } from "../workspaces/store.js";
import type { VideoJobPatch, VideoJobRecord, VideoJobStore } from "./jobs.js";
import { VideoLimits } from "./limits.js";
import { VIDEO_ADAPTERS } from "./providers/index.js";
import type { VideoHold, VideoHoldRefusal, VideoStore } from "./store.js";
import type {
	FetchLike,
	VideoAdapter,
	VideoCall,
	VideoConfig,
	VideoCreateResult,
	VideoFailure,
	VideoPollResult,
} from "./types.js";

export type VideoCaller = TelemetryCaller;
/** Whose jobs a caller may see: agents see only their own. */
export type VideoViewer = { ownOnly?: string };
export type VideoContext = {
	/** The gateway's address, for download links. */
	origin: string;
	signal?: AbortSignal;
	/** Epoch milliseconds; a wait stops here. */
	deadline?: number;
};

export type VideoServiceOptions = {
	store: VideoStore;
	jobs: VideoJobStore;
	/** How provider APIs are called; the global fetch by default. */
	fetchImpl?: FetchLike;
	adapters?: Partial<Record<VideoKind, VideoAdapter>>;
	telemetry?: Pick<TelemetryService, "recordVideo">;
	/** Holds each video's estimate against the budgets that cover it. Omitted: none. */
	budgets?: Pick<BudgetService, "holdVideo" | "release" | "releaseCarried">;
	/** `VIDEO_DISABLED`: every video call is refused. */
	disabled?: boolean;
	/** The ids of the workspace's agents, to check the agents a video limit names. */
	knownAgents?: (workspace: WorkspaceRef) => Promise<Set<string>>;
	now?: () => number;
	/** How a wait sleeps; tests replace it. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

/** What a download link leads to. */
export type VideoDownload =
	| { kind: "redirect"; url: string }
	| {
			kind: "bytes";
			bytes: Uint8Array;
			contentType: "video/mp4";
			filename: string;
	  }
	| { kind: "gone" }
	| { kind: "error"; detail: string };

export const VIDEO_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const DAY_MS = 86_400_000;
const CREATE_MS = 30_000;
const POLL_MS = 20_000;
const CONTENT_MS = 60_000;
const CANCEL_MS = 10_000;
/** A job with no provider id this long after it was created never started. */
const NOT_STARTED_MS = 2 * 60_000;
/** A connection with a problem is skipped this long, as the web ladder does. */
const PROBLEM_HOLD_MS = 15 * 60_000;
/** A provider link this close to expiring is fetched afresh before a redirect. */
const LINK_REFRESH_MS = 5 * 60_000;
const MIN_SLEEP_MS = 250;

const NOT_SET_UP =
	"Video generation is not set up in this workspace. A workspace admin can add a video provider.";
const NO_PROVIDER =
	"This workspace has no video provider. A workspace admin can add one.";
const TURNED_OFF = "Video generation is turned off on this gateway.";
const REFUSALS: Record<VideoHoldRefusal, string> = {
	caller: "Your videos for today are used up.",
};

type Entry = Awaited<ReturnType<VideoStore["entries"]>>[number];
type Candidate = {
	entry: Entry;
	model: VideoModel;
	call: Omit<VideoCall, "signal">;
};

/** A signal that ends after `ms`, or sooner with `signal`. */
function within(ms: number, signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(ms);
	return signal ? AbortSignal.any([timeout, signal]) : timeout;
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal?.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});

function errorCode(
	outcome: VideoFailure["outcome"] | "skipped",
): VideoJobErrorCode {
	switch (outcome) {
		case "refused":
			return "moderated";
		case "invalid":
			return "invalid_input";
		case "timeout":
			return "timeout";
		default:
			return "provider_error";
	}
}

/**
 * Starts videos on a workspace's providers and follows them. Jobs are
 * polled when someone reads them, never in the background, so it runs the
 * same on Node and the Worker. See docs/VIDEO_MODELS_PLAN.md §5.
 */
export class VideoService {
	private readonly adapters: Partial<Record<VideoKind, VideoAdapter>>;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Connections that asked the gateway to slow down, until when. */
	private readonly backoff = new Map<string, number>();
	/** How many videos a day, and how long, each caller may make. */
	readonly limits: VideoLimits;

	constructor(private readonly options: VideoServiceOptions) {
		this.adapters = options.adapters ?? VIDEO_ADAPTERS;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? (() => Date.now());
		this.sleep = options.sleep ?? defaultSleep;
		this.limits = new VideoLimits(options.store, {
			now: () => new Date(this.now()),
			...(options.knownAgents ? { knownAgents: options.knownAgents } : {}),
		});
	}

	get available(): boolean {
		return !this.options.disabled;
	}

	private refuseWhenDisabled() {
		if (this.options.disabled) throw new ServiceError(TURNED_OFF, 503);
	}

	/** Connections that are on and have a key, in the policy's order, then the rest as added. */
	private usable(entries: Entry[], policy: VideoPolicy): Entry[] {
		const ready = entries.filter(
			(entry) => entry.config.enabled && Boolean(entry.config.apiKey),
		);
		const rank = (name: string) => {
			const index = policy.order.indexOf(name);
			return index === -1 ? policy.order.length : index;
		};
		return ready
			.map((entry, index) => ({ entry, index }))
			.sort(
				(a, b) =>
					rank(a.entry.config.name) - rank(b.entry.config.name) ||
					a.index - b.index,
			)
			.map(({ entry }) => entry);
	}

	/**
	 * Holds one video: its estimate against every budget that covers it,
	 * then the caller's daily cap. Either refusal gives back what was taken.
	 */
	private async hold(
		workspace: WorkspaceRef,
		caller: VideoCaller,
		input: {
			connection: string;
			model: string;
			costUsd: number;
		},
	): Promise<VideoHold | { refused: string; by: "budget" | "caller" }> {
		const { store, budgets } = this.options;
		const budget = budgets
			? await budgets.holdVideo(
					workspace.id,
					caller,
					input.model,
					input.costUsd,
				)
			: undefined;
		if (budget && "refused" in budget)
			return { refused: budget.refused, by: "budget" };
		let held: Awaited<ReturnType<VideoStore["hold"]>>;
		try {
			const { counts } = await this.limits.forVideo(
				workspace,
				caller,
				input.model,
			);
			held = await store.hold(workspace, {
				connection: input.connection,
				limits: counts,
				costUsd: input.costUsd,
			});
		} catch (error) {
			if (budget) await budgets?.release(budget).catch(() => {});
			throw error;
		}
		if ("refused" in held) {
			if (budget) await budgets?.release(budget).catch(() => {});
			return { refused: REFUSALS[held.refused], by: "caller" };
		}
		return budget ? { ...held, budget } : held;
	}

	/**
	 * Gives a hold back, here and on the budgets: the provider charged
	 * nothing. A hold taken before budgets existed has no part of its own;
	 * its estimate was carried into the first budget, so it comes back from
	 * there.
	 */
	private async release(hold: VideoHold): Promise<void> {
		const { budgets } = this.options;
		const [workspaceId, month] = hold.keys.budget.split(":budget:");
		await Promise.allSettled([
			this.options.store.release(hold),
			...(budgets
				? [
						hold.budget
							? budgets.release(hold.budget)
							: budgets.releaseCarried(workspaceId, month, hold.costMicros),
					]
				: []),
		]);
	}

	/** What the settings route shows. */
	async settings(workspace: WorkspaceRef): Promise<VideoSettings> {
		const { store } = this.options;
		const policy = await store.policy(workspace);
		const [connections, spend, entries, limits] = await Promise.all([
			store.list(workspace),
			store.spend(workspace),
			store.entries(workspace),
			this.limits.list(workspace),
		]);
		return {
			available: this.available,
			configured: this.available && this.usable(entries, policy).length > 0,
			connections,
			policy,
			limits,
			spend,
			persistence: store.persistence,
		};
	}

	/** What this workspace can make, for `video_models` and `GET /video/models`. */
	async models(
		workspace: WorkspaceRef,
		canGenerate: boolean,
		caller?: VideoCaller,
	): Promise<VideoModelList> {
		this.refuseWhenDisabled();
		const policy = await this.options.store.policy(workspace);
		const usable = this.usable(
			await this.options.store.entries(workspace),
			policy,
		);
		const providers = usable.map(({ config }) => ({
			name: config.name,
			kind: config.kind,
			defaultModel: config.defaultModel ?? DEFAULT_VIDEO_MODEL[config.kind],
			models: [...VIDEO_MODELS[config.kind]],
		}));
		const durations = await this.limits.durations(
			workspace,
			caller,
			providers.flatMap((provider) => provider.models.map((model) => model.id)),
		);
		return {
			available: providers.length > 0,
			...(providers.length ? {} : { reason: NO_PROVIDER }),
			canGenerate,
			providers,
			limits: {
				maxDurationSeconds: durations.all,
				...(Object.keys(durations.byModel).length
					? { modelMaxDurationSeconds: durations.byModel }
					: {}),
				promptLength: VIDEO_LIMITS.promptLength,
			},
		};
	}

	/** Checks what the caller sent, before anything is read or written. */
	private checkRequest(request: VideoGenerateRequest) {
		const prompt =
			typeof request.prompt === "string" ? request.prompt.trim() : "";
		if (!prompt) throw new ServiceError("Describe the video in prompt.");
		if (prompt.length > VIDEO_LIMITS.promptLength)
			throw new ServiceError(
				`A prompt is at most ${VIDEO_LIMITS.promptLength} characters.`,
			);
		const seconds = request.durationSeconds;
		if (seconds !== undefined) {
			if (
				!Number.isInteger(seconds) ||
				seconds < VIDEO_LIMITS.minDurationSeconds ||
				seconds > VIDEO_LIMITS.maxDurationSeconds
			)
				throw new ServiceError(
					`durationSeconds is a whole number from ${VIDEO_LIMITS.minDurationSeconds} to ${VIDEO_LIMITS.maxDurationSeconds}.`,
				);
		}
		if (
			request.aspectRatio !== undefined &&
			!(VIDEO_ASPECT_RATIOS as readonly string[]).includes(request.aspectRatio)
		)
			throw new ServiceError(
				`aspectRatio is one of ${VIDEO_ASPECT_RATIOS.join(", ")}.`,
			);
		if (
			request.resolution !== undefined &&
			!(VIDEO_RESOLUTIONS as readonly string[]).includes(request.resolution)
		)
			throw new ServiceError(
				`resolution is one of ${VIDEO_RESOLUTIONS.join(", ")}.`,
			);
		let imageUrl: string | undefined;
		if (request.imageUrl !== undefined) {
			if (request.imageUrl.length > VIDEO_LIMITS.urlLength)
				throw new ServiceError(
					`imageUrl is at most ${VIDEO_LIMITS.urlLength} characters.`,
				);
			const url = checkTargetUrl(request.imageUrl);
			if (url.protocol !== "https:")
				throw new ServiceError("imageUrl must be an https URL.");
			imageUrl = url.toString();
		}
		return { prompt, imageUrl };
	}

	/** The connections that can make this, each with the model and settings it would use. */
	private candidates(
		usable: Entry[],
		request: VideoGenerateRequest,
		capFor: (model: string) => number,
		prompt: string,
		imageUrl: string | undefined,
	): Candidate[] {
		let pool = usable;
		if (request.provider !== undefined) {
			pool = usable.filter((entry) => entry.config.name === request.provider);
			if (!pool.length)
				throw new ServiceError(
					`${request.provider} is not a video connection that can be used in this workspace. Use one of ${usable.map((entry) => entry.config.name).join(", ")}, or leave provider out.`,
				);
		}
		const problems: string[] = [];
		const candidates: Candidate[] = [];
		for (const entry of pool) {
			const { config } = entry;
			const id =
				request.model ??
				config.defaultModel ??
				DEFAULT_VIDEO_MODEL[config.kind];
			const model = videoModel(config.kind, id);
			if (!model) {
				problems.push(
					`${config.name} has no model ${id}; its models are ${VIDEO_MODELS[config.kind].map((item) => item.id).join(", ")}.`,
				);
				continue;
			}
			const cap = capFor(model.id);
			if (
				request.durationSeconds !== undefined &&
				request.durationSeconds > cap
			) {
				problems.push(
					`${config.name}: a video limit allows ${model.label} videos of up to ${cap} seconds.`,
				);
				continue;
			}
			const want = {
				durationSeconds:
					request.durationSeconds ??
					Math.min(model.defaults.durationSeconds, cap),
				aspectRatio: request.aspectRatio ?? model.defaults.aspectRatio,
				resolution: request.resolution ?? model.defaults.resolution,
			};
			const problem = videoModelProblem(model, {
				...want,
				image: Boolean(imageUrl),
				promptLength: prompt.length,
			});
			if (problem) {
				problems.push(`${config.name}: ${problem}`);
				continue;
			}
			candidates.push({
				entry,
				model,
				call: {
					model: model.id,
					prompt,
					...want,
					...(imageUrl ? { imageUrl } : {}),
				},
			});
		}
		if (!candidates.length)
			throw new ServiceError(
				`No video connection in this workspace can make this. ${problems.join(" ")}`,
			);
		return candidates;
	}

	/** Why a connection is passed over right now, or null. */
	private skipReason(workspace: WorkspaceRef, entry: Entry): string | null {
		const now = this.now();
		const until = this.backoff.get(`${workspace.id}:${entry.config.name}`);
		if (until !== undefined && until > now)
			return "the provider asked the gateway to slow down";
		const problem = entry.problem;
		if (problem && now - Date.parse(problem.at) < PROBLEM_HOLD_MS)
			return `the connection has a problem to fix: ${problem.detail}`;
		return null;
	}

	private async noteProblem(
		workspace: WorkspaceRef,
		name: string,
		kind: VideoProblem["kind"],
		detail: string,
	) {
		await this.options.store
			.setProblem(workspace, name, {
				kind,
				detail,
				at: new Date(this.now()).toISOString(),
			})
			.catch(() => {});
	}

	/**
	 * Starts one video. The job record is written before the provider is
	 * called, so a paid job is never unknown to the gateway. A failure that
	 * cost nothing moves on to the next connection; a refusal, a rejected
	 * request, or a timeout (the provider may have accepted it) stops.
	 */
	async generate(
		workspace: WorkspaceRef,
		caller: VideoCaller,
		request: VideoGenerateRequest,
		context: VideoContext,
	): Promise<VideoJob> {
		this.refuseWhenDisabled();
		const { store, jobs } = this.options;
		const policy = await store.policy(workspace);
		const { prompt, imageUrl } = this.checkRequest(request);
		const usable = this.usable(await store.entries(workspace), policy);
		if (!usable.length) throw new ServiceError(NOT_SET_UP, 409);
		// The longest video the caller's limits allow, on every model and on each.
		const durations = await this.limits.durations(
			workspace,
			caller,
			usable.flatMap(({ config }) =>
				VIDEO_MODELS[config.kind].map((model) => model.id),
			),
		);
		if (
			request.durationSeconds !== undefined &&
			request.durationSeconds > durations.all
		)
			throw new ServiceError(
				`A video limit allows videos of up to ${durations.all} seconds.`,
			);
		const candidates = this.candidates(
			usable,
			request,
			(model) => durations.byModel[model] ?? durations.all,
			prompt,
			imageUrl,
		);

		const id = `vid_${randomUUID()}`;
		const createdAt = new Date(this.now()).toISOString();
		const attempts: VideoAttempt[] = [];
		let inserted = false;
		let held: VideoHold | null = null;
		let last: {
			outcome: VideoFailure["outcome"] | "skipped";
			detail: string;
		} | null = null;
		const fields = (candidate: Candidate, costUsd: number) => ({
			provider: candidate.entry.config.name,
			kind: candidate.entry.config.kind,
			model: candidate.model.id,
			durationSeconds: candidate.call.durationSeconds,
			aspectRatio: candidate.call.aspectRatio,
			resolution: candidate.call.resolution,
			costUsd,
		});
		const record = (candidate: Candidate, costUsd: number): VideoJobRecord => ({
			_id: id,
			workspaceId: workspace.id,
			workspaceDefault: workspace.isDefault,
			status: "queued",
			progress: null,
			...fields(candidate, costUsd),
			prompt,
			hasImage: Boolean(imageUrl),
			createdBy: { id: caller.id, name: caller.name, kind: caller.kind },
			createdAt,
			updatedAt: createdAt,
			completedAt: null,
			error: null,
			attempts: [],
			providerJobId: null,
			delivery: null,
			resultExpiresAt: null,
			downloadToken: randomBytes(32).toString("base64url"),
			hold: null,
			lastPolledAt: null,
			expiresAt: new Date(
				Date.parse(createdAt) + VIDEO_LIMITS.jobRetentionDays * DAY_MS,
			),
		});

		let budgetRefusal: string | undefined;
		let budgetRefusals = 0;
		for (const candidate of candidates) {
			const { config } = candidate.entry;
			const attempt = { provider: config.name, model: candidate.model.id };
			const adapter = this.adapters[config.kind];
			const skip = adapter
				? this.skipReason(workspace, candidate.entry)
				: "the gateway cannot call this provider";
			if (skip || !adapter) {
				attempts.push({ ...attempt, outcome: "skipped", detail: skip ?? "" });
				last = { outcome: "skipped", detail: `${config.name}: ${skip}` };
				continue;
			}
			const costUsd = adapter.estimateCostUsd(config, candidate.call);
			const hold = await this.hold(workspace, caller, {
				connection: config.name,
				model: candidate.model.id,
				costUsd,
			});
			if ("refused" in hold) {
				// A used-up budget passes this model over, as a failure would; the
				// next provider in the order may be covered by none.
				if (hold.by === "budget") {
					budgetRefusal ??= hold.refused;
					budgetRefusals += 1;
					attempts.push({
						...attempt,
						outcome: "skipped",
						detail: hold.refused,
					});
					last = { outcome: "skipped", detail: hold.refused };
					continue;
				}
				if (!inserted) throw new ServiceError(hold.refused, 429);
				attempts.push({
					...attempt,
					outcome: "skipped",
					detail: hold.refused,
				});
				last = { outcome: "skipped", detail: hold.refused };
				break;
			}
			held = hold;
			let current = true;
			try {
				if (!inserted) {
					await jobs.insert({ ...record(candidate, costUsd), hold });
					inserted = true;
				} else
					current = await jobs.update(
						workspace.id,
						id,
						{ ...fields(candidate, costUsd), hold, attempts },
						{ unfinished: true },
					);
			} catch (error) {
				await this.release(hold);
				throw error;
			}
			// Canceled between attempts: start nothing more.
			if (!current) {
				await this.release(hold);
				const saved = await jobs.get(workspace.id, id);
				if (!saved) throw new ServiceError("Video job not found.", 404);
				return this.view(saved, context.origin);
			}

			let result: VideoCreateResult;
			try {
				result = await adapter.create(
					config,
					{ ...candidate.call, signal: within(CREATE_MS) },
					this.fetchImpl,
				);
			} catch {
				// Adapters answer every failure; an exception is a bug, and the
				// provider may have accepted the job, so its hold stays.
				result = {
					outcome: "timeout",
					detail: `${config.name}: the call failed unexpectedly`,
					billed: true,
				};
			}
			if (result.outcome === "accepted") {
				attempts.push({ ...attempt, outcome: "accepted" });
				if (candidate.entry.problem)
					await store.setProblem(workspace, config.name, null).catch(() => {});
				const started = await jobs.update(
					workspace.id,
					id,
					{
						providerJobId: result.providerJobId,
						status: result.status,
						attempts,
						lastPolledAt: this.now(),
					},
					{ unfinished: true },
				);
				// Canceled while it was starting: tell the provider too.
				if (!started && adapter.cancel)
					await adapter.cancel(
						config,
						result.providerJobId,
						within(CANCEL_MS),
						this.fetchImpl,
					);
				const saved = await jobs.get(workspace.id, id);
				if (!saved) throw new ServiceError("Video job not found.", 404);
				if (started) this.recordTelemetry(saved, "started");
				return this.view(saved, context.origin);
			}
			attempts.push({
				...attempt,
				outcome: result.outcome,
				detail: result.detail,
			});
			last = result;
			if (result.problem)
				await this.noteProblem(
					workspace,
					config.name,
					result.problem,
					result.detail,
				);
			if (result.retryAfterMs)
				this.backoff.set(
					`${workspace.id}:${config.name}`,
					this.now() + result.retryAfterMs,
				);
			if (result.outcome !== "timeout" && !result.billed) {
				await this.release(hold);
				held = null;
			}
			if (result.outcome !== "provider-error") break;
		}

		// Nothing accepted it: the job records why, and is returned.
		const failed: VideoJobPatch = {
			status: "failed",
			error: {
				code: last ? errorCode(last.outcome) : "provider_error",
				message: last?.detail ?? "No video connection could start this video.",
			},
			attempts,
			completedAt: new Date(this.now()).toISOString(),
			hold: held,
			// A hold given back cost nothing; one kept shows what it holds.
			...(held ? {} : { costUsd: 0 }),
		};
		// Nothing started because budgets covered every model: refused, as one call would be.
		if (!inserted && budgetRefusal && budgetRefusals === candidates.length)
			throw new ServiceError(budgetRefusal, 429);
		if (!inserted) {
			const first = candidates[0];
			await jobs.insert({
				...record(first, 0),
				...failed,
			} as VideoJobRecord);
		} else await jobs.update(workspace.id, id, failed, { unfinished: true });
		const saved = await jobs.get(workspace.id, id);
		if (!saved) throw new ServiceError("Video job not found.", 404);
		this.recordTelemetry(saved, "finished");
		return this.view(saved, context.origin);
	}

	private async find(
		workspace: WorkspaceRef,
		viewer: VideoViewer,
		id: string,
	): Promise<VideoJobRecord> {
		const record = await this.options.jobs.get(workspace.id, id);
		// Another caller's job and a missing one read the same.
		if (!record || (viewer.ownOnly && record.createdBy.id !== viewer.ownOnly))
			throw new ServiceError("Video job not found.", 404);
		return record;
	}

	/** One job, checked with its provider first when due; `waitSeconds` waits for it to finish. */
	async status(
		workspace: WorkspaceRef,
		viewer: VideoViewer,
		id: string,
		options: { waitSeconds?: number },
		context: VideoContext,
	): Promise<VideoJob> {
		this.refuseWhenDisabled();
		let record = await this.refresh(await this.find(workspace, viewer, id));
		const waitMs =
			Math.max(
				0,
				Math.min(options.waitSeconds ?? 0, VIDEO_LIMITS.maxWaitSeconds),
			) * 1000;
		const until = Math.min(this.now() + waitMs, context.deadline ?? Infinity);
		while (!videoJobFinished(record.status) && !context.signal?.aborted) {
			const next =
				record.lastPolledAt === null
					? VIDEO_LIMITS.pollIntervalMs
					: record.lastPolledAt + VIDEO_LIMITS.pollIntervalMs - this.now();
			const pause = Math.max(
				MIN_SLEEP_MS,
				Math.min(next, VIDEO_LIMITS.pollIntervalMs),
			);
			if (this.now() + pause > until) break;
			await this.sleep(pause, context.signal);
			if (context.signal?.aborted) break;
			record = await this.refresh(record);
		}
		return this.view(record, context.origin);
	}

	/** Stops a job. A finished one is returned as it is. The estimated cost stays counted. */
	async cancel(
		workspace: WorkspaceRef,
		viewer: VideoViewer,
		id: string,
		context: VideoContext,
	): Promise<VideoJob> {
		this.refuseWhenDisabled();
		const { jobs, store } = this.options;
		// The stored status may be old: a job that already finished must not
		// be canceled, and Runway deletes a finished task's video on cancel.
		const record = await this.refresh(await this.find(workspace, viewer, id), {
			force: true,
		});
		if (videoJobFinished(record.status))
			return this.view(record, context.origin);
		const ref = { id: record.workspaceId, isDefault: record.workspaceDefault };
		const adapter = this.adapters[record.kind];
		if (record.providerJobId && adapter?.cancel) {
			const config = await store.connection(ref, record.provider);
			if (config?.kind === record.kind)
				await adapter.cancel(
					config,
					record.providerJobId,
					within(CANCEL_MS),
					this.fetchImpl,
				);
		}
		const won = await jobs.update(
			workspace.id,
			id,
			{ status: "canceled", completedAt: new Date(this.now()).toISOString() },
			{ unfinished: true },
		);
		const saved = (await jobs.get(workspace.id, id)) ?? record;
		if (won) this.recordTelemetry(saved, "finished");
		return this.view(saved, context.origin);
	}

	/** Jobs newest first: an agent's own, or every job in the workspace. */
	async list(
		workspace: WorkspaceRef,
		viewer: VideoViewer,
		options: { before?: string; limit?: number },
		context: VideoContext,
	): Promise<VideoJobList> {
		this.refuseWhenDisabled();
		const limit = Math.max(
			1,
			Math.min(
				options.limit ?? VIDEO_LIMITS.defaultListLimit,
				VIDEO_LIMITS.maxListLimit,
			),
		);
		const { records, more } = await this.options.jobs.list(workspace.id, {
			...(viewer.ownOnly ? { createdById: viewer.ownOnly } : {}),
			...(options.before ? { before: options.before } : {}),
			limit,
		});
		return {
			jobs: records.map((record) => this.view(record, context.origin)),
			nextBefore: more ? (records.at(-1)?._id ?? null) : null,
		};
	}

	/**
	 * Polls an unfinished job when the last check is old enough and saves
	 * what the provider said. The move to a finished state is conditional,
	 * so of two readers exactly one applies it, releases the hold when
	 * nothing was billed, and records telemetry.
	 */
	private async refresh(
		record: VideoJobRecord,
		options: { force?: boolean } = {},
	): Promise<VideoJobRecord> {
		const { jobs, store } = this.options;
		const now = this.now();
		if (videoJobFinished(record.status)) return this.expireIfPast(record);
		if (!record.providerJobId) {
			// Each failover attempt touches the record, so a slow failover is not
			// taken for a gateway that stopped.
			const touched = Math.max(
				Date.parse(record.createdAt),
				Date.parse(record.updatedAt),
			);
			if (now - touched < NOT_STARTED_MS) return record;
			// The gateway stopped mid-start. The provider may have taken the job,
			// so its estimated cost stays counted: high, never low.
			return this.finish(record, {
				status: "failed",
				error: {
					code: "not_started",
					message:
						"The video never started: the gateway stopped while starting it.",
				},
			});
		}
		if (
			!options.force &&
			record.lastPolledAt !== null &&
			now - record.lastPolledAt < VIDEO_LIMITS.pollIntervalMs
		)
			return record;
		const reread = async () =>
			(await jobs.get(record.workspaceId, record._id)) ?? record;
		// Claim this check: of readers who all found it due, one polls.
		const claimed = await jobs.update(
			record.workspaceId,
			record._id,
			{ lastPolledAt: now },
			{ unfinished: true, lastPolledAt: record.lastPolledAt },
		);
		if (!claimed) return reread();
		const ref = { id: record.workspaceId, isDefault: record.workspaceDefault };
		const adapter = this.adapters[record.kind];
		const config = await store.connection(ref, record.provider);
		// The connection was removed: the job stays as it was until its record
		// expires. The claim above still spaces out a waiting reader's checks.
		if (!adapter || !config || config.kind !== record.kind) return reread();
		let result: VideoPollResult;
		try {
			result = await adapter.poll(
				config,
				record.providerJobId,
				within(POLL_MS),
				this.fetchImpl,
			);
		} catch {
			result = { state: "unknown", detail: "the status check failed" };
		}
		return this.applyPoll(record, config, adapter, result);
	}

	private async applyPoll(
		record: VideoJobRecord,
		config: VideoConfig,
		adapter: VideoAdapter,
		result: VideoPollResult,
	): Promise<VideoJobRecord> {
		const { jobs } = this.options;
		const ref = { id: record.workspaceId, isDefault: record.workspaceDefault };
		const now = this.now();
		const reread = async () =>
			(await jobs.get(record.workspaceId, record._id)) ?? record;
		switch (result.state) {
			case "queued":
			case "running":
				await jobs.update(
					record.workspaceId,
					record._id,
					{
						status: result.state,
						progress: result.progress,
						lastPolledAt: now,
					},
					{ unfinished: true },
				);
				return reread();
			case "succeeded":
				return this.finish(record, {
					status: "succeeded",
					progress: 100,
					delivery:
						result.delivery.kind === "url"
							? {
									kind: "url",
									url: result.delivery.url,
									expiresAt: now + result.delivery.ttlMs,
								}
							: { kind: "bytes" },
					resultExpiresAt: new Date(now + adapter.resultTtlMs).toISOString(),
				});
			case "failed":
				if (result.problem)
					await this.noteProblem(
						ref,
						config.name,
						result.problem,
						result.detail,
					);
				return this.finish(
					record,
					{
						status: "failed",
						error: { code: result.code, message: result.detail },
					},
					{ release: !result.billed },
				);
			case "canceled":
				return this.finish(record, { status: "canceled" });
			case "gone":
				return this.finish(record, {
					status: "failed",
					error: {
						code: "provider_error",
						message: `${VIDEO_KIND_LABELS[record.kind]} no longer has this job.`,
					},
				});
			default:
				if (result.problem)
					await this.noteProblem(
						ref,
						config.name,
						result.problem,
						result.detail,
					);
				if (result.retryAfterMs)
					await jobs.update(
						record.workspaceId,
						record._id,
						{
							lastPolledAt:
								now + result.retryAfterMs - VIDEO_LIMITS.pollIntervalMs,
						},
						{ unfinished: true },
					);
				return reread();
		}
	}

	/** Finishes a job if nobody else did; the winner releases the hold when asked and records telemetry. */
	private async finish(
		record: VideoJobRecord,
		patch: VideoJobPatch,
		options: { release?: boolean } = {},
	): Promise<VideoJobRecord> {
		const { jobs } = this.options;
		const won = await jobs.update(
			record.workspaceId,
			record._id,
			{
				...patch,
				completedAt: new Date(this.now()).toISOString(),
				...(options.release ? { hold: null, costUsd: 0 } : {}),
			},
			{ unfinished: true },
		);
		const saved = (await jobs.get(record.workspaceId, record._id)) ?? record;
		if (won) {
			if (options.release && record.hold) await this.release(record.hold);
			this.recordTelemetry(saved, "finished");
		}
		return saved;
	}

	/** A succeeded job whose video the provider no longer keeps becomes expired. */
	private async expireIfPast(record: VideoJobRecord): Promise<VideoJobRecord> {
		if (
			record.status !== "succeeded" ||
			!record.resultExpiresAt ||
			this.now() < Date.parse(record.resultExpiresAt)
		)
			return record;
		await this.options.jobs.update(
			record.workspaceId,
			record._id,
			{ status: "expired" },
			{ status: "succeeded" },
		);
		return { ...record, status: "expired" };
	}

	/**
	 * What a download link leads to: a redirect to the provider's link, the
	 * video itself where only the key can fetch it, or nothing. Null for a
	 * token that names no finished video.
	 */
	async download(
		token: string,
		signal?: AbortSignal,
	): Promise<VideoDownload | null> {
		this.refuseWhenDisabled();
		if (!VIDEO_TOKEN_PATTERN.test(token)) return null;
		const { jobs, store } = this.options;
		const found = await jobs.byToken(token);
		if (!found) return null;
		const record = await this.expireIfPast(found);
		if (record.status === "expired") return { kind: "gone" };
		if (
			record.status !== "succeeded" ||
			!record.delivery ||
			!record.providerJobId
		)
			return null;
		const ref = { id: record.workspaceId, isDefault: record.workspaceDefault };
		const delivery = record.delivery;
		const now = this.now();
		const adapter = this.adapters[record.kind];
		const config = await store.connection(ref, record.provider);
		const usable = adapter && config && config.kind === record.kind;
		const expire = async () => {
			await jobs.update(
				record.workspaceId,
				record._id,
				{ status: "expired" },
				{ status: "succeeded" },
			);
			return { kind: "gone" } as const;
		};
		if (delivery.kind === "url") {
			if (delivery.expiresAt - now > LINK_REFRESH_MS || !usable)
				return delivery.expiresAt > now
					? { kind: "redirect", url: delivery.url }
					: {
							kind: "error",
							detail: "The provider's link has expired and cannot be renewed.",
						};
			// One download renews the link at a time; the others use the saved
			// one while it lasts.
			const due =
				record.lastPolledAt === null ||
				now - record.lastPolledAt >= VIDEO_LIMITS.pollIntervalMs;
			const claimed =
				due &&
				(await jobs.update(
					record.workspaceId,
					record._id,
					{ lastPolledAt: now },
					{ status: "succeeded", lastPolledAt: record.lastPolledAt },
				));
			if (!claimed)
				return delivery.expiresAt > now
					? { kind: "redirect", url: delivery.url }
					: {
							kind: "error",
							detail:
								"The provider's link is being renewed. Try again shortly.",
						};
			let result: VideoPollResult;
			try {
				result = await adapter.poll(
					config,
					record.providerJobId,
					within(POLL_MS, signal),
					this.fetchImpl,
				);
			} catch {
				result = { state: "unknown", detail: "the status check failed" };
			}
			if (result.state === "succeeded" && result.delivery.kind === "url") {
				await jobs.update(
					record.workspaceId,
					record._id,
					{
						delivery: {
							kind: "url",
							url: result.delivery.url,
							expiresAt: now + result.delivery.ttlMs,
						},
					},
					{ status: "succeeded" },
				);
				return { kind: "redirect", url: result.delivery.url };
			}
			if (result.state === "gone") return expire();
			return delivery.expiresAt > now
				? { kind: "redirect", url: delivery.url }
				: { kind: "error", detail: "The provider could not be reached." };
		}
		if (!usable || !adapter.content)
			return {
				kind: "error",
				detail: "The video's connection is no longer available.",
			};
		const content = await adapter.content(
			config,
			record.providerJobId,
			within(CONTENT_MS, signal),
			this.fetchImpl,
		);
		if (content.kind === "gone") return expire();
		if (content.kind === "error")
			return { kind: "error", detail: content.detail };
		return {
			kind: "bytes",
			bytes: content.bytes,
			contentType: "video/mp4",
			filename: `${record._id}.mp4`,
		};
	}

	/** The job as callers see it: no provider id, key, hold, or token apart from the link. */
	view(record: VideoJobRecord, origin: string): VideoJob {
		const expired =
			record.status === "expired" ||
			(record.status === "succeeded" &&
				record.resultExpiresAt !== null &&
				this.now() >= Date.parse(record.resultExpiresAt));
		const status = expired ? "expired" : record.status;
		return {
			id: record._id,
			status,
			progress: record.progress,
			provider: record.provider,
			kind: record.kind,
			model: record.model,
			prompt: record.prompt,
			durationSeconds: record.durationSeconds,
			aspectRatio: record.aspectRatio,
			resolution: record.resolution,
			hasImage: record.hasImage,
			createdBy: record.createdBy,
			createdAt: record.createdAt,
			updatedAt: record.updatedAt,
			completedAt: record.completedAt,
			costUsd: record.costUsd,
			video:
				status === "succeeded" && record.delivery && record.resultExpiresAt
					? {
							url: `${origin.replace(/\/+$/, "")}/video/downloads/${record.downloadToken}`,
							contentType: "video/mp4",
							expiresAt: record.resultExpiresAt,
						}
					: null,
			error: record.error,
			attempts: record.attempts,
		};
	}

	private recordTelemetry(
		record: VideoJobRecord,
		phase: "started" | "finished",
	) {
		this.options.telemetry?.recordVideo({
			workspaceId: record.workspaceId,
			caller: record.createdBy,
			jobId: record._id,
			phase,
			provider: record.provider,
			kind: record.kind,
			model: record.model,
			status: record.status,
			durationSeconds: record.durationSeconds,
			resolution: record.resolution,
			costUsd: record.costUsd,
			latencyMs: Math.max(0, this.now() - Date.parse(record.createdAt)),
			attempts: record.attempts.map((attempt) => ({
				provider: attempt.provider,
				model: attempt.model,
				outcome: attempt.outcome,
			})),
			...(record.error ? { errorCode: record.error.code } : {}),
		});
	}
}
