import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type {
	ApiToken,
	ApiTokenAction,
	ApiTokenSecret,
	ApiTokenSettings,
	ApiTokenTtl,
	CreateApiTokenRequest,
	RollApiTokenRequest,
	UpdateApiTokenRequest,
} from "@autonomo.us/common";
import { controlPlaneConnection, type MongoConnection } from "../mongo.js";
import {
	inWorkspace,
	type WorkspaceRef,
	workspaceFilter,
} from "../workspaces/store.js";

type Credential = { hash: string; prefix: string; expiresAt: string | null };
type TokenRecord<Permission extends string> = Omit<
	ApiToken<Permission>,
	"id" | "status" | "previousTokens" | "permissions" | "workspaceId"
> & {
	/** Missing on tokens created before workspaces: those belong to the default workspace. */
	workspaceId?: string;
	/** Legacy records receive the defaults for their token audience. */
	permissions?: Permission[];
	_id: string;
	revision: number;
	credentials: Credential[];
	actions: ApiTokenAction[];
};

export class ApiTokenError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
	}
}

function normalizePermissions<Permission extends string>(
	permissions: readonly Permission[],
	profile: TokenProfile<Permission>,
): Permission[] {
	if (
		!Array.isArray(permissions) ||
		permissions.some(
			(permission) => !Object.hasOwn(profile.permissions, permission),
		) ||
		new Set(permissions).size !== permissions.length
	) {
		throw new ApiTokenError("Choose valid, unique token permissions.");
	}
	return (Object.keys(profile.permissions) as Permission[]).filter(
		(permission) =>
			permissions.includes(permission) &&
			!(
				permission.endsWith(":read") &&
				permissions.includes(permission.replace(":read", ":edit") as Permission)
			),
	);
}

function effectivePermissions<Permission extends string>(
	record: TokenRecord<Permission>,
	profile: TokenProfile<Permission>,
) {
	return normalizePermissions(
		record.permissions === undefined
			? profile.defaultPermissions
			: record.permissions,
		profile,
	);
}

function permissionSummary<Permission extends string>(
	permissions: Permission[],
	profile: TokenProfile<Permission>,
) {
	return (
		permissions
			.map((permission) => profile.permissions[permission])
			.join(", ") || "None"
	);
}

export function tokenHash(secret: string) {
	return createHash("sha256").update(secret).digest("hex");
}

export function secretMatches(secret: string, hash: string) {
	return timingSafeEqual(
		Buffer.from(tokenHash(secret), "hex"),
		Buffer.from(hash, "hex"),
	);
}

function expiresAt(ttl: ApiTokenTtl, now: number) {
	return ttl === "never"
		? null
		: new Date(now + ttl * 86_400_000).toISOString();
}

function issue(id: string, expiry: string | null, prefix: string) {
	const secret = `${prefix}_${id}_${randomBytes(32).toString("base64url")}`;
	const credential: Credential = {
		hash: tokenHash(secret),
		prefix: `${secret.slice(0, 12)}…${secret.slice(-4)}`,
		expiresAt: expiry,
	};
	return { secret, credential };
}

function live(credential: Credential, now: number) {
	return (
		credential.expiresAt === null || Date.parse(credential.expiresAt) > now
	);
}

/** Never serialize a stored record: only this explicit public projection. */
function publicToken<Permission extends string>(
	record: TokenRecord<Permission>,
	now: number,
	profile: TokenProfile<Permission>,
	workspace: WorkspaceRef,
): ApiToken<Permission> {
	return {
		id: record._id,
		workspaceId: record.workspaceId ?? workspace.id,
		name: record.name,
		description: record.description,
		permissions: effectivePermissions(record, profile),
		ttlDays: record.ttlDays,
		prefix: record.prefix,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		expiresAt: record.expiresAt,
		revokedAt: record.revokedAt,
		status: record.revokedAt
			? "revoked"
			: record.credentials.some((item) => live(item, now))
				? "active"
				: "expired",
		previousTokens: record.credentials
			.slice(1)
			.filter((item) => live(item, now))
			.map((item) => ({
				prefix: item.prefix,
				expiresAt: item.expiresAt as string,
			})),
	};
}

export type TokenProfile<Permission extends string> = {
	collection: string;
	prefix: string;
	label: string;
	permissions: Record<Permission, string>;
	defaultPermissions: readonly Permission[];
};

/** A token as the access hook sees it. A null `workspaceId` means the default workspace. */
export type AuthenticatedToken<Permission extends string> = Omit<
	ApiToken<Permission>,
	"workspaceId"
> & { workspaceId: string | null };

/**
 * Each Mongo document commits credentials and their audit events atomically.
 * Reads go to Mongo every time so revocation works across API replicas. Every
 * token belongs to one workspace, and every by-id operation filters on it, so
 * a request in workspace A can never read or change workspace B's token.
 */
export class TokenStore<Permission extends string> {
	private readonly mongo?: MongoConnection;
	private readonly records = new Map<string, TokenRecord<Permission>>();
	private indexed = false;
	constructor(
		private readonly profile: TokenProfile<Permission>,
		mongo?: string | MongoConnection,
		private readonly now = Date.now,
	) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}
	private get mongodbUrl() {
		return Boolean(this.mongo);
	}
	private collection() {
		return (this.mongo as MongoConnection).collection<TokenRecord<Permission>>(
			this.profile.collection,
		);
	}
	async ensureIndexes(): Promise<void> {
		if (!this.mongo || this.indexed) return;
		await this.collection().createIndex({ workspaceId: 1 });
		this.indexed = true;
	}
	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof ApiTokenError) throw error;
			throw new ApiTokenError(
				`${this.profile.label} tokens are unavailable. Check MongoDB and retry.`,
				503,
			);
		}
	}
	private async read(workspace: WorkspaceRef, id: string) {
		const record = this.mongodbUrl
			? await this.storage(() =>
					this.collection().findOne({
						_id: id,
						workspaceId: workspaceFilter(workspace),
					}),
				)
			: this.records.get(id);
		return record && inWorkspace(record.workspaceId, workspace)
			? structuredClone(record)
			: null;
	}
	/** IDs of a workspace's tokens, revoked ones included. */
	async ids(workspace: WorkspaceRef): Promise<Set<string>> {
		if (!this.mongodbUrl)
			return new Set(
				[...this.records.values()]
					.filter((record) => inWorkspace(record.workspaceId, workspace))
					.map((record) => record._id),
			);
		const records = await this.storage(() =>
			this.collection()
				.find(
					{ workspaceId: workspaceFilter(workspace) },
					{ projection: { _id: 1, workspaceId: 1 } },
				)
				.toArray(),
		);
		return new Set(
			records
				.filter((record) => inWorkspace(record.workspaceId, workspace))
				.map((record) => String(record._id)),
		);
	}
	async settings(
		workspace: WorkspaceRef,
		authenticationRequired: boolean,
	): Promise<ApiTokenSettings<Permission>> {
		const records = this.mongodbUrl
			? await this.storage(() =>
					this.collection()
						.find({ workspaceId: workspaceFilter(workspace) })
						.toArray(),
				)
			: [...this.records.values()].filter((record) =>
					inWorkspace(record.workspaceId, workspace),
				);
		return {
			tokens: records
				.map((record) =>
					publicToken(record, this.now(), this.profile, workspace),
				)
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
			actions: records
				.flatMap((record) => structuredClone(record.actions))
				.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
				.slice(0, 100),
			persistence: this.mongodbUrl ? "mongodb" : "memory",
			authenticationRequired,
		};
	}
	private action(
		record: TokenRecord<Permission>,
		action: ApiTokenAction["action"],
		actor: ApiTokenAction["actor"],
		detail: string,
		actorName?: string,
	) {
		record.actions.unshift({
			id: randomUUID(),
			tokenId: record._id,
			tokenName: record.name,
			action,
			timestamp: record.updatedAt,
			actor,
			...(actor === "user" && actorName ? { actorName } : {}),
			detail,
		});
		// Bound each document; settings returns the latest 100 actions overall.
		record.actions = record.actions.slice(0, 100);
	}
	async create(
		workspace: WorkspaceRef,
		input: CreateApiTokenRequest<Permission>,
		actor: ApiTokenAction["actor"],
		actorName?: string,
	): Promise<ApiTokenSecret<Permission>> {
		const now = this.now();
		const id = randomUUID();
		const expiry = expiresAt(input.ttlDays, now);
		const { secret, credential } = issue(id, expiry, this.profile.prefix);
		const record: TokenRecord<Permission> = {
			_id: id,
			workspaceId: workspace.id,
			revision: 0,
			name: input.name.trim(),
			description: input.description.trim(),
			permissions: normalizePermissions(
				input.permissions === undefined
					? this.profile.defaultPermissions
					: input.permissions,
				this.profile,
			),
			ttlDays: input.ttlDays,
			prefix: credential.prefix,
			createdAt: new Date(now).toISOString(),
			updatedAt: new Date(now).toISOString(),
			expiresAt: expiry,
			revokedAt: null,
			credentials: [credential],
			actions: [],
		};
		this.action(
			record,
			"created",
			actor,
			`${expiry ? `Expires ${expiry}.` : "Never expires."} Permissions: ${permissionSummary(effectivePermissions(record, this.profile), this.profile)}.`,
			actorName,
		);
		if (this.mongodbUrl) {
			await this.ensureIndexes().catch(() => {});
			await this.storage(() => this.collection().insertOne(record));
		} else this.records.set(id, record);
		return {
			token: publicToken(record, now, this.profile, workspace),
			secret,
		};
	}
	private async mutate<T>(
		workspace: WorkspaceRef,
		id: string,
		change: (record: TokenRecord<Permission>, now: number) => T,
	): Promise<T> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const record = await this.read(workspace, id);
			if (!record) throw new ApiTokenError("Token not found.", 404);
			const revision = record.revision;
			record.workspaceId ??= workspace.id;
			const now = this.now();
			record.updatedAt = new Date(now).toISOString();
			const result = change(record, now);
			record.revision++;
			if (this.mongodbUrl) {
				const write = await this.storage(() =>
					this.collection().replaceOne({ _id: id, revision }, record),
				);
				if (!write.matchedCount) continue;
			} else {
				if (this.records.get(id)?.revision !== revision) continue;
				this.records.set(id, record);
			}
			return result;
		}
		throw new ApiTokenError(
			"Token changed during this request. Refresh and try again.",
			409,
		);
	}
	update(
		workspace: WorkspaceRef,
		id: string,
		input: UpdateApiTokenRequest<Permission>,
		actor: ApiTokenAction["actor"],
		actorName?: string,
	) {
		return this.mutate(workspace, id, (record, now) => {
			if (record.revokedAt)
				throw new ApiTokenError("Revoked tokens cannot be edited.", 409);
			record.name = input.name.trim();
			record.description = input.description.trim();
			const before = effectivePermissions(record, this.profile);
			record.permissions =
				input.permissions === undefined
					? before
					: normalizePermissions(input.permissions, this.profile);
			const changed = before.join() !== record.permissions.join();
			this.action(
				record,
				"updated",
				actor,
				changed
					? `Permissions changed from ${permissionSummary(before, this.profile)} to ${permissionSummary(record.permissions, this.profile)}. Name and description saved.`
					: "Name and description updated.",
				actorName,
			);
			return publicToken(record, now, this.profile, workspace);
		});
	}
	roll(
		workspace: WorkspaceRef,
		id: string,
		input: RollApiTokenRequest,
		actor: ApiTokenAction["actor"],
		actorName?: string,
	): Promise<ApiTokenSecret<Permission>> {
		return this.mutate(workspace, id, (record, now) => {
			if (record.revokedAt)
				throw new ApiTokenError("Revoked tokens cannot be rolled.", 409);
			record.permissions = effectivePermissions(record, this.profile);
			const deadline = new Date(
				now + input.previousTokenTtlSeconds * 1000,
			).toISOString();
			const previous = record.credentials.flatMap((credential, index) => {
				if (!live(credential, now)) return [];
				if (index > 0) return [credential]; // Earlier rolls keep their original deadlines.
				const expiresAt =
					credential.expiresAt && credential.expiresAt < deadline
						? credential.expiresAt
						: deadline;
				return Date.parse(expiresAt) > now
					? [{ ...credential, expiresAt }]
					: [];
			});
			if (previous.length >= 20)
				throw new ApiTokenError(
					"Too many overlapping tokens. Wait for previous tokens to expire or revoke this token.",
					409,
				);
			const expiry = expiresAt(input.ttlDays, now);
			const { secret, credential } = issue(id, expiry, this.profile.prefix);
			record.credentials = [credential, ...previous];
			record.prefix = credential.prefix;
			record.ttlDays = input.ttlDays;
			record.expiresAt = expiry;
			this.action(
				record,
				"rolled",
				actor,
				`Previous token overlap: ${input.previousTokenTtlSeconds} seconds (never beyond its existing expiry). New token ${expiry ? `expires ${expiry}` : "never expires"}.`,
				actorName,
			);
			return {
				token: publicToken(record, now, this.profile, workspace),
				secret,
			};
		});
	}
	revoke(
		workspace: WorkspaceRef,
		id: string,
		actor: ApiTokenAction["actor"],
		actorName?: string,
	) {
		return this.mutate(workspace, id, (record, now) => {
			if (!record.revokedAt) {
				record.revokedAt = record.updatedAt;
				record.credentials = [];
				this.action(
					record,
					"revoked",
					actor,
					"All current and previous token values revoked immediately.",
					actorName,
				);
			}
			return publicToken(record, now, this.profile, workspace);
		});
	}
	async authenticate(
		secret: string,
	): Promise<AuthenticatedToken<Permission> | null> {
		const match =
			/^([a-z]+)_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_[A-Za-z0-9_-]{43}$/.exec(
				secret,
			);
		if (!match || match[1] !== this.profile.prefix) return null;
		const id = match[2];
		const stored = this.mongodbUrl
			? await this.storage(() => this.collection().findOne({ _id: id }))
			: this.records.get(id);
		if (!stored || stored.revokedAt) return null;
		return stored.credentials.some(
			(item) => live(item, this.now()) && secretMatches(secret, item.hash),
		)
			? {
					...publicToken(stored, this.now(), this.profile, {
						id: "",
						isDefault: false,
					}),
					workspaceId: stored.workspaceId ?? null,
				}
			: null;
	}
	async close() {
		await this.mongo?.close();
	}
}
