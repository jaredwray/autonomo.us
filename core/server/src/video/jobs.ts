import type {
	TelemetryCaller,
	VideoAspectRatio,
	VideoAttempt,
	VideoJobErrorCode,
	VideoJobStatus,
	VideoKind,
	VideoResolution,
} from "@autonomo.us/common";
import type { MongoConnection } from "../mongo.js";
import { ServiceError } from "../service-error.js";
import type { VideoHold } from "./store.js";
import type { StoredDelivery } from "./types.js";

export const VIDEO_JOBS_COLLECTION = "gateway_video_jobs";

/** A job as the gateway keeps it. Never sent to a client as is: see `VideoService.view`. */
export type VideoJobRecord = {
	_id: string;
	workspaceId: string;
	/** Whether the job's workspace is the default one, whose environment connections it may use. */
	workspaceDefault: boolean;
	status: VideoJobStatus;
	progress: number | null;
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
	costUsd: number;
	error: { code: VideoJobErrorCode; message: string } | null;
	attempts: VideoAttempt[];
	/** The provider's id; never leaves the server. Null until the provider accepts it. */
	providerJobId: string | null;
	delivery: StoredDelivery | null;
	/** When the provider stops keeping the video, as an ISO time. */
	resultExpiresAt: string | null;
	/** The secret in the job's download link. */
	downloadToken: string;
	/** The estimated cost held against the caps, given back when the provider bills nothing. */
	hold: VideoHold | null;
	/** Epoch milliseconds of the last status check. */
	lastPolledAt: number | null;
	/** When the record deletes itself. */
	expiresAt: Date;
};

const UNFINISHED: VideoJobStatus[] = ["queued", "running"];

export type VideoJobPatch = Partial<
	Omit<VideoJobRecord, "_id" | "workspaceId" | "downloadToken" | "createdAt">
>;

/**
 * Video jobs, per workspace, with a memory mode for gateways without
 * MongoDB. Every read by id also matches the workspace, and every query
 * compares with `$eq`, so a job id from elsewhere finds nothing.
 */
export class VideoJobStore {
	private readonly memory = new Map<string, VideoJobRecord>();
	private indexed = false;

	constructor(
		private readonly mongo?: MongoConnection,
		private readonly now: () => Date = () => new Date(),
	) {}

	get persistence(): "mongodb" | "memory" {
		return this.mongo ? "mongodb" : "memory";
	}

	private collection() {
		return (this.mongo as MongoConnection).collection<VideoJobRecord>(
			VIDEO_JOBS_COLLECTION,
		);
	}

	async ensureIndexes(): Promise<void> {
		if (!this.mongo || this.indexed) return;
		await Promise.all([
			this.collection().createIndex({ downloadToken: 1 }, { unique: true }),
			this.collection().createIndex(
				{ expiresAt: 1 },
				{ expireAfterSeconds: 0 },
			),
		]);
		this.indexed = true;
	}

	private unavailable(error: unknown): never {
		if (error instanceof ServiceError) throw error;
		throw new ServiceError(
			"Video jobs are unavailable. Check the MongoDB connection and retry.",
			503,
			{ cause: error },
		);
	}

	/** Memory mode drops a record once it is past its own expiry, as the TTL index does. */
	private live(record: VideoJobRecord | undefined): VideoJobRecord | null {
		if (!record) return null;
		if (record.expiresAt.getTime() <= this.now().getTime()) {
			this.memory.delete(record._id);
			return null;
		}
		return structuredClone(record);
	}

	async insert(record: VideoJobRecord): Promise<void> {
		if (!this.mongo) {
			this.memory.set(record._id, structuredClone(record));
			return;
		}
		try {
			await this.ensureIndexes().catch(() => {});
			await this.collection().insertOne(structuredClone(record));
		} catch (error) {
			this.unavailable(error);
		}
	}

	async get(workspaceId: string, id: string): Promise<VideoJobRecord | null> {
		if (!this.mongo) {
			const record = this.live(this.memory.get(id));
			return record?.workspaceId === workspaceId ? record : null;
		}
		try {
			return await this.collection().findOne({
				_id: { $eq: id },
				workspaceId: { $eq: workspaceId },
			});
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** The job a download link names, in whichever workspace it is. */
	async byToken(token: string): Promise<VideoJobRecord | null> {
		if (!this.mongo) {
			for (const record of this.memory.values())
				if (record.downloadToken === token) return this.live(record);
			return null;
		}
		try {
			return await this.collection().findOne({ downloadToken: { $eq: token } });
		} catch (error) {
			this.unavailable(error);
		}
	}

	/**
	 * Applies a change, only while the job is unfinished when `unfinished`
	 * is set. True when this call changed it: of two callers finishing the
	 * same job, exactly one wins.
	 */
	async update(
		workspaceId: string,
		id: string,
		patch: VideoJobPatch,
		guard: {
			/** Only while the job is queued or running. */
			unfinished?: boolean;
			/** Only while the job has exactly this status. */
			status?: VideoJobStatus;
			/** Only while the last status check is still this one: a claim on the next. */
			lastPolledAt?: number | null;
		} = {},
	): Promise<boolean> {
		const set = { ...patch, updatedAt: this.now().toISOString() };
		if (!this.mongo) {
			const record = this.live(this.memory.get(id));
			if (!record || record.workspaceId !== workspaceId) return false;
			if (guard.unfinished && !UNFINISHED.includes(record.status)) return false;
			if (guard.status && record.status !== guard.status) return false;
			if (
				guard.lastPolledAt !== undefined &&
				record.lastPolledAt !== guard.lastPolledAt
			)
				return false;
			this.memory.set(id, { ...record, ...structuredClone(set) });
			return true;
		}
		const conditions: Record<string, unknown>[] = [
			{ _id: { $eq: id } },
			{ workspaceId: { $eq: workspaceId } },
		];
		if (guard.unfinished) conditions.push({ status: { $in: UNFINISHED } });
		if (guard.status) conditions.push({ status: { $eq: guard.status } });
		if (guard.lastPolledAt !== undefined)
			conditions.push({ lastPolledAt: { $eq: guard.lastPolledAt } });
		try {
			const result = await this.collection().updateOne(
				{ $and: conditions },
				{ $set: set },
			);
			return result.matchedCount > 0;
		} catch (error) {
			this.unavailable(error);
		}
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}
