import { randomUUID } from "node:crypto";
import { BOT_LIMITS, type BotWebRequest } from "@autonomo.us/common";
import { isDuplicateKey, type MongoConnection } from "../mongo.js";
import { ServiceError } from "../service-error.js";

type RequestDocument = Omit<BotWebRequest, "id"> & { _id: string };

const SHOWN = 50;

const toRequest = ({ _id, ...rest }: RequestDocument): BotWebRequest => ({
	id: _id,
	...rest,
});

/**
 * Sites a bot tried to fetch outside its scope, waiting for a workspace
 * admin. One request waits per bot and host; asking again counts up on it.
 */
export class BotWebRequestStore {
	private readonly memory = new Map<string, BotWebRequest>();
	private indexed = false;

	constructor(
		private readonly mongo?: MongoConnection,
		private readonly now: () => Date = () => new Date(),
	) {}

	private collection() {
		return (this.mongo as MongoConnection).collection<RequestDocument>(
			"gateway_bot_web_requests",
		);
	}

	private async ensureIndexes() {
		if (!this.mongo || this.indexed) return;
		await Promise.all([
			// One waiting request per bot and host, however many replies ask.
			this.collection().createIndex(
				{ botId: 1, host: 1 },
				{ unique: true, partialFilterExpression: { status: "pending" } },
			),
			this.collection().createIndex({
				workspaceId: 1,
				botId: 1,
				requestedAt: -1,
			}),
		]);
		this.indexed = true;
	}

	private unavailable(error: unknown): never {
		if (error instanceof ServiceError) throw error;
		throw new ServiceError(
			"Web access requests are unavailable. Check the MongoDB connection and retry.",
			503,
			{ cause: error },
		);
	}

	/**
	 * Records that a bot asked for a host outside its scope. Returns false when
	 * the bot already has the most requests waiting.
	 */
	async record(input: {
		workspaceId: string;
		botId: string;
		host: string;
		url: string;
		channelId: string | null;
	}): Promise<boolean> {
		const at = this.now().toISOString();
		if (!this.mongo) {
			const waiting = [...this.memory.values()].filter(
				(request) =>
					request.botId === input.botId && request.status === "pending",
			);
			const same = waiting.find((request) => request.host === input.host);
			if (same) {
				same.count += 1;
				same.url = input.url;
				same.channelId = input.channelId;
				return true;
			}
			if (waiting.length >= BOT_LIMITS.maxPendingWebRequests) return false;
			const id = randomUUID();
			this.memory.set(id, {
				id,
				...input,
				status: "pending",
				count: 1,
				requestedAt: at,
				decidedAt: null,
				decidedBy: null,
			});
			return true;
		}
		try {
			await this.ensureIndexes().catch(() => {});
			const collection = this.collection();
			for (let attempt = 0; attempt < 3; attempt++) {
				const bumped = await collection.updateOne(
					{
						botId: { $eq: input.botId },
						host: { $eq: input.host },
						status: { $eq: "pending" },
					},
					{
						$inc: { count: 1 },
						$set: { url: input.url, channelId: input.channelId },
					},
				);
				if (bumped.matchedCount) return true;
				const waiting = await collection.countDocuments({
					botId: { $eq: input.botId },
					status: { $eq: "pending" },
				});
				if (waiting >= BOT_LIMITS.maxPendingWebRequests) return false;
				try {
					await collection.insertOne({
						_id: randomUUID(),
						...input,
						status: "pending",
						count: 1,
						requestedAt: at,
						decidedAt: null,
						decidedBy: null,
					});
					return true;
				} catch (error) {
					// Another reply asked first: count up on its request instead.
					if (!isDuplicateKey(error)) throw error;
				}
			}
			return true;
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Waiting requests first, then the latest decided ones. */
	async list(workspaceId: string, botId: string): Promise<BotWebRequest[]> {
		const order = (a: BotWebRequest, b: BotWebRequest) =>
			a.status === b.status
				? b.requestedAt.localeCompare(a.requestedAt)
				: a.status === "pending"
					? -1
					: b.status === "pending"
						? 1
						: b.requestedAt.localeCompare(a.requestedAt);
		if (!this.mongo)
			return [...this.memory.values()]
				.filter(
					(request) =>
						request.workspaceId === workspaceId && request.botId === botId,
				)
				.sort(order)
				.slice(0, SHOWN)
				.map((request) => ({ ...request }));
		try {
			const documents = await this.collection()
				.find({ workspaceId: { $eq: workspaceId }, botId: { $eq: botId } })
				.sort({ requestedAt: -1 })
				.limit(SHOWN * 2)
				.toArray();
			return documents.map(toRequest).sort(order).slice(0, SHOWN);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Every waiting request in a workspace, oldest first, for the overview. */
	async pending(workspaceId: string): Promise<BotWebRequest[]> {
		if (!this.mongo)
			return [...this.memory.values()]
				.filter(
					(request) =>
						request.workspaceId === workspaceId && request.status === "pending",
				)
				.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt))
				.map((request) => ({ ...request }));
		try {
			const documents = await this.collection()
				.find({ workspaceId: { $eq: workspaceId }, status: { $eq: "pending" } })
				.sort({ requestedAt: 1 })
				// Each bot holds at most this many, and a workspace at most 50 bots.
				.limit(BOT_LIMITS.maxPendingWebRequests * BOT_LIMITS.bots)
				.toArray();
			return documents.map(toRequest);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Decides a waiting request once. A decided or unknown one is refused. */
	async decide(
		workspaceId: string,
		botId: string,
		id: string,
		approve: boolean,
		decidedBy: string,
		/** Runs before the request is marked approved: adding the host. */
		onApprove: (host: string) => Promise<void>,
	): Promise<BotWebRequest> {
		const current = (await this.list(workspaceId, botId)).find(
			(request) => request.id === id,
		);
		if (!current) throw new ServiceError("Request not found.", 404);
		if (current.status !== "pending")
			throw new ServiceError("This request was already decided.", 409);
		if (approve) await onApprove(current.host);
		const decided = {
			status: approve ? ("approved" as const) : ("denied" as const),
			decidedAt: this.now().toISOString(),
			decidedBy,
		};
		if (!this.mongo) {
			const stored = this.memory.get(id);
			if (!stored || stored.status !== "pending")
				throw new ServiceError("This request was already decided.", 409);
			Object.assign(stored, decided);
			return { ...stored };
		}
		try {
			const result = await this.collection().findOneAndUpdate(
				{
					_id: { $eq: id },
					workspaceId: { $eq: workspaceId },
					botId: { $eq: botId },
					status: { $eq: "pending" },
				},
				{ $set: decided },
				{ returnDocument: "after" },
			);
			if (!result)
				throw new ServiceError("This request was already decided.", 409);
			return toRequest(result);
		} catch (error) {
			this.unavailable(error);
		}
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}
