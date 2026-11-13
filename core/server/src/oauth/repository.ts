import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { ServiceError } from "../service-error.js";

export const OAUTH_CLIENTS_COLLECTION = "gateway_oauth_clients";
export const OAUTH_REQUESTS_COLLECTION = "gateway_oauth_requests";
export const OAUTH_GRANTS_COLLECTION = "gateway_oauth_grants";

/** An app that registered itself. Public: it holds no secret. */
export type StoredClient = {
	id: string;
	name: string;
	uri: string | null;
	redirectUris: string[];
	createdAt: string;
	/** Null until a person approves a sign-in from this app. */
	approvedAt: string | null;
	/** When an app nobody approved is forgotten; null once approved. */
	expiresAt: Date | null;
};

/** A sign-in waiting for a person. Its id is the hash of what the browser holds. */
export type StoredRequest = {
	id: string;
	clientId: string;
	redirectUri: string;
	state: string | null;
	codeChallenge: string;
	createdAt: string;
	expiresAt: Date;
	/**
	 * Which of its app's waiting places this sign-in holds. A place is held by
	 * one sign-in at a time, which is what keeps their number bounded.
	 */
	slot: number;
};

export type StoredSecret = { hash: string; expiresAt: string };

/** One app signed in as one agent: the code first, then its tokens. */
export type StoredGrant = {
	id: string;
	workspaceId: string;
	agentId: string;
	clientId: string;
	clientName: string;
	redirectUri: string;
	approvedBy: string;
	createdAt: string;
	/** The authorization code. `usedAt` marks it spent; the hash stays to spot reuse. */
	code: StoredSecret & { challenge: string; usedAt: string | null };
	/** Access tokens that have not expired yet. */
	access: StoredSecret[];
	/** The refresh token the app holds; null until the code is exchanged. */
	refresh: StoredSecret | null;
	/** The one it replaced, to tell a retry a moment later from a copied token. */
	previousRefresh: { hash: string; rotatedAt: string } | null;
	/**
	 * The hash of what every refresh token of this connection starts with, so
	 * an earlier one is recognized without keeping each of them.
	 */
	refreshFamily: string | null;
	lastUsedAt: string | null;
	/** When MongoDB may delete the grant: its code, then its refresh token. */
	expiresAt: Date;
	revision: number;
};

export class OAuthStorageError extends ServiceError {}
const unavailable = (cause: unknown) =>
	new OAuthStorageError(
		"OAuth sign-in is unavailable. Check MongoDB and retry.",
		503,
		{ cause },
	);

/**
 * Storage for OAuth sign-in. Expiry is checked by the service on every read;
 * MongoDB's TTL indexes only clear what has expired.
 */
export interface OAuthRepository {
	readonly persistence: "mongodb" | "memory";
	insertClient(client: StoredClient): Promise<void>;
	getClient(id: string): Promise<StoredClient | null>;
	/** Marks an app approved, so its registration is kept. */
	approveClient(id: string, at: string): Promise<void>;
	/** Registrations nobody has approved and that have not expired. */
	countPendingClients(now: Date): Promise<number>;
	/** Forgets the registration that has waited longest. */
	removeOldestPendingClient(): Promise<void>;

	/**
	 * Saves a sign-in in one of its app's `limit` waiting places. False when
	 * sign-ins that have not expired hold them all. Two inserts never get the
	 * same place, so requests arriving together cannot pass the limit.
	 */
	insertRequest(
		request: Omit<StoredRequest, "slot">,
		limit: number,
		now: Date,
	): Promise<boolean>;
	getRequest(id: string): Promise<StoredRequest | null>;
	/** Returns the request and removes it, so only one caller gets it. */
	takeRequest(id: string): Promise<StoredRequest | null>;

	insertGrant(grant: StoredGrant): Promise<void>;
	getGrant(id: string): Promise<StoredGrant | null>;
	/** Saves the grant only while its stored revision is `expectedRevision`. */
	replaceGrant(grant: StoredGrant, expectedRevision: number): Promise<boolean>;
	removeGrant(id: string): Promise<boolean>;
	/** A workspace's grants, or one agent's. */
	listGrants(workspaceId: string, agentId?: string): Promise<StoredGrant[]>;
	removeGrants(workspaceId: string, agentId: string): Promise<number>;
	close(): Promise<void>;
}

export class MemoryOAuthRepository implements OAuthRepository {
	readonly persistence = "memory" as const;
	private readonly clients = new Map<string, StoredClient>();
	private readonly requests = new Map<string, StoredRequest>();
	private readonly grants = new Map<string, StoredGrant>();
	/** Expired requests and grants are dropped on the next insert. */
	constructor(private readonly now = Date.now) {}

	async insertClient(client: StoredClient) {
		this.clients.set(client.id, structuredClone(client));
	}
	async getClient(id: string) {
		const client = this.clients.get(id);
		return client ? structuredClone(client) : null;
	}
	async approveClient(id: string, at: string) {
		const client = this.clients.get(id);
		if (client) {
			client.approvedAt ??= at;
			client.expiresAt = null;
		}
	}
	private pending() {
		return [...this.clients.values()].filter((client) => client.expiresAt);
	}
	async countPendingClients(now: Date) {
		for (const client of this.pending())
			if ((client.expiresAt as Date) <= now) this.clients.delete(client.id);
		return this.pending().length;
	}
	async removeOldestPendingClient() {
		const oldest = this.pending().sort((a, b) =>
			a.createdAt.localeCompare(b.createdAt),
		)[0];
		if (oldest) this.clients.delete(oldest.id);
	}

	async insertRequest(
		request: Omit<StoredRequest, "slot">,
		limit: number,
		now: Date,
	) {
		for (const [id, stored] of this.requests)
			if (stored.expiresAt <= now) this.requests.delete(id);
		const taken = new Set(
			[...this.requests.values()]
				.filter((stored) => stored.clientId === request.clientId)
				.map((stored) => stored.slot),
		);
		for (let slot = 0; slot < limit; slot++)
			if (!taken.has(slot)) {
				this.requests.set(request.id, { ...structuredClone(request), slot });
				return true;
			}
		return false;
	}
	async getRequest(id: string) {
		const request = this.requests.get(id);
		return request ? structuredClone(request) : null;
	}
	async takeRequest(id: string) {
		const request = this.requests.get(id) ?? null;
		this.requests.delete(id);
		return request;
	}

	async insertGrant(grant: StoredGrant) {
		const now = new Date(this.now());
		for (const [id, stored] of this.grants)
			if (stored.expiresAt <= now) this.grants.delete(id);
		this.grants.set(grant.id, structuredClone(grant));
	}
	async getGrant(id: string) {
		const grant = this.grants.get(id);
		return grant ? structuredClone(grant) : null;
	}
	async replaceGrant(grant: StoredGrant, expectedRevision: number) {
		if (this.grants.get(grant.id)?.revision !== expectedRevision) return false;
		this.grants.set(grant.id, structuredClone(grant));
		return true;
	}
	async removeGrant(id: string) {
		return this.grants.delete(id);
	}
	async listGrants(workspaceId: string, agentId?: string) {
		return [...this.grants.values()]
			.filter(
				(grant) =>
					grant.workspaceId === workspaceId &&
					(agentId === undefined || grant.agentId === agentId),
			)
			.map((grant) => structuredClone(grant));
	}
	async removeGrants(workspaceId: string, agentId: string) {
		let removed = 0;
		for (const grant of await this.listGrants(workspaceId, agentId))
			if (this.grants.delete(grant.id)) removed++;
		return removed;
	}
	async close() {}
}

type Stored<T extends { id: string }> = Omit<T, "id"> & { _id: string };
const stored = <T extends { id: string }>({ id, ...rest }: T) =>
	({ _id: id, ...rest }) as Stored<T>;
const loaded = <T extends { id: string }>(document: Stored<T> | null) => {
	if (!document) return null;
	const { _id, ...rest } = document;
	return { id: _id, ...rest } as unknown as T;
};

export class MongoOAuthRepository implements OAuthRepository {
	readonly persistence = "mongodb" as const;
	private readonly mongo: MongoConnection;
	private indexed?: Promise<void>;
	constructor(mongo: string | MongoConnection) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}
	private clients() {
		return this.mongo.collection<Stored<StoredClient>>(
			OAUTH_CLIENTS_COLLECTION,
		);
	}
	private requests() {
		return this.mongo.collection<Stored<StoredRequest>>(
			OAUTH_REQUESTS_COLLECTION,
		);
	}
	private grants() {
		return this.mongo.collection<Stored<StoredGrant>>(OAUTH_GRANTS_COLLECTION);
	}
	/**
	 * Created on the first write. MongoDB deletes a document once its
	 * `expiresAt` passes; a null `expiresAt` is never deleted.
	 */
	private ensureIndexes(): Promise<void> {
		this.indexed ??= (async () => {
			const ttl = { expireAfterSeconds: 0 };
			await Promise.all([
				this.clients().createIndex({ expiresAt: 1 }, ttl),
				this.clients().createIndex({ approvedAt: 1, createdAt: 1 }),
				this.requests().createIndex({ expiresAt: 1 }, ttl),
				// One sign-in per waiting place: the limit holds under concurrency.
				this.requests().createIndex({ clientId: 1, slot: 1 }, { unique: true }),
				this.grants().createIndex({ expiresAt: 1 }, ttl),
				this.grants().createIndex({ workspaceId: 1, agentId: 1 }),
			]);
		})().catch(() => {
			// Try again on the next write; the stores work without the indexes.
			this.indexed = undefined;
		});
		return this.indexed;
	}
	private async run<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ServiceError) throw error;
			throw unavailable(error);
		}
	}

	async insertClient(client: StoredClient) {
		await this.ensureIndexes();
		await this.run(() => this.clients().insertOne(stored(client)));
	}
	getClient(id: string) {
		return this.run(async () =>
			loaded<StoredClient>(await this.clients().findOne({ _id: { $eq: id } })),
		);
	}
	async approveClient(id: string, at: string) {
		await this.run(() =>
			this.clients().updateOne({ _id: { $eq: id } }, [
				{
					$set: {
						approvedAt: { $ifNull: ["$approvedAt", at] },
						expiresAt: null,
					},
				},
			]),
		);
	}
	countPendingClients(now: Date) {
		return this.run(() =>
			this.clients().countDocuments({
				approvedAt: null,
				expiresAt: { $gt: now },
			}),
		);
	}
	async removeOldestPendingClient() {
		await this.run(() =>
			this.clients().findOneAndDelete(
				{ approvedAt: null },
				{ sort: { createdAt: 1 } },
			),
		);
	}

	async insertRequest(
		request: Omit<StoredRequest, "slot">,
		limit: number,
		now: Date,
	) {
		await this.ensureIndexes();
		return this.run(async () => {
			const own = { clientId: { $eq: request.clientId } };
			// MongoDB clears expired sign-ins about once a minute; do not wait.
			await this.requests().deleteMany({ ...own, expiresAt: { $lte: now } });
			const taken = new Set(
				(
					await this.requests()
						.find(own, { projection: { slot: 1 } })
						.toArray()
				).map((document) => document.slot),
			);
			for (let slot = 0; slot < limit; slot++) {
				if (taken.has(slot)) continue;
				try {
					await this.requests().insertOne(stored({ ...request, slot }));
					return true;
				} catch (error) {
					// Another sign-in took this place a moment ago: try the next.
					if (!isDuplicateKey(error)) throw error;
				}
			}
			return false;
		});
	}
	getRequest(id: string) {
		return this.run(async () =>
			loaded<StoredRequest>(
				await this.requests().findOne({ _id: { $eq: id } }),
			),
		);
	}
	takeRequest(id: string) {
		return this.run(async () =>
			loaded<StoredRequest>(
				await this.requests().findOneAndDelete({ _id: { $eq: id } }),
			),
		);
	}

	async insertGrant(grant: StoredGrant) {
		await this.ensureIndexes();
		await this.run(() => this.grants().insertOne(stored(grant)));
	}
	getGrant(id: string) {
		return this.run(async () =>
			loaded<StoredGrant>(await this.grants().findOne({ _id: { $eq: id } })),
		);
	}
	replaceGrant(grant: StoredGrant, expectedRevision: number) {
		return this.run(async () => {
			const result = await this.grants().replaceOne(
				{ _id: { $eq: grant.id }, revision: expectedRevision },
				stored(grant),
			);
			return result.matchedCount === 1;
		});
	}
	removeGrant(id: string) {
		return this.run(
			async () =>
				(await this.grants().deleteOne({ _id: { $eq: id } })).deletedCount ===
				1,
		);
	}
	listGrants(workspaceId: string, agentId?: string) {
		return this.run(async () =>
			(
				await this.grants()
					.find({
						workspaceId: { $eq: workspaceId },
						...(agentId === undefined ? {} : { agentId: { $eq: agentId } }),
					})
					.toArray()
			).map((document) => loaded<StoredGrant>(document) as StoredGrant),
		);
	}
	removeGrants(workspaceId: string, agentId: string) {
		return this.run(
			async () =>
				(
					await this.grants().deleteMany({
						workspaceId: { $eq: workspaceId },
						agentId: { $eq: agentId },
					})
				).deletedCount,
		);
	}
	async close() {
		await this.mongo.close();
	}
}
