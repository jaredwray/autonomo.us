import { randomBytes, randomUUID } from "node:crypto";
import {
	type AcceptInviteRequest,
	type AddTeamMemberRequest,
	type AuthSession,
	type AuthStatus,
	type ChangePasswordRequest,
	type CreateTeamInviteRequest,
	type InvitePreview,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	type SetupRequest,
	type SignInRequest,
	type TeamInvite,
	type TeamInviteSecret,
	type TeamMember,
	type TeamRole,
	type TeamSettings,
	type UpdateTeamMemberRequest,
} from "@autonomo.us/common";
import { type Collection, type Document, MongoClient } from "mongodb";
import { mongoOperationDeadlines, requestMongoClient } from "../mongo.js";
import { hashPassword, verifyDecoy, verifyPassword } from "./passwords.js";
import { secretMatches, tokenHash } from "./token-store.js";

export class AccountError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
	}
}

export const SESSION_TTL_MS = 14 * 86_400_000;
export const SIGN_IN_WINDOW_MS = 15 * 60_000;
export const SIGN_IN_MAX_FAILURES = 10;
const MAX_SESSIONS = 10;
const LISTED_INVITES = 50;
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const SESSION_PATTERN = new RegExp(`^ses_(${UUID})_[A-Za-z0-9_-]{43}$`);
const INVITE_PATTERN = new RegExp(`^inv_(${UUID})_[A-Za-z0-9_-]{43}$`);

type Session = { hash: string; createdAt: string; expiresAt: string };
type UserRecord = Omit<TeamMember, "id"> & {
	_id: string;
	revision: number;
	passwordHash: string;
	/** Recent failed sign-ins, newest first, for throttling. */
	failedSignIns: string[];
	sessions: Session[];
};
type SetupRecord = {
	_id: string;
	revision: number;
	completedAt: string | null;
	ownerId: string | null;
};
type InviteRecord = Omit<TeamInvite, "id" | "status"> & {
	_id: string;
	revision: number;
	hash: string;
	acceptedUserId: string | null;
};
type Stored = { _id: string; revision: number };

/** Who is acting on the team: the OWNER_TOKEN, a signed-in member, or pre-setup local mode. */
export type TeamActor =
	| { kind: "owner" }
	| { kind: "local" }
	| { kind: "user"; member: TeamMember };

const iso = (time: number) => new Date(time).toISOString();
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const incorrect = () => new AccountError("Incorrect email or password.", 401);
const invalidInvite = () =>
	new AccountError(
		"This invite link is invalid, expired, or already used. Ask an admin for a new one.",
		404,
	);
const missingMember = () => new AccountError("Team member not found.", 404);
const lastOwner = () =>
	new AccountError(
		"Keep at least one owner. Make another member an owner first.",
		409,
	);

function assertPassword(password: string) {
	const length = [...password].length;
	if (length < PASSWORD_MIN_LENGTH || length > PASSWORD_MAX_LENGTH)
		throw new AccountError(
			`Passwords must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`,
		);
}

function publicMember(record: UserRecord): TeamMember {
	return {
		id: record._id,
		email: record.email,
		name: record.name,
		role: record.role,
		createdAt: record.createdAt,
		updatedAt: record.updatedAt,
		joinedVia: record.joinedVia,
		addedBy: record.addedBy,
		lastSignInAt: record.lastSignInAt,
	};
}

function publicInvite(record: InviteRecord, now: number): TeamInvite {
	return {
		id: record._id,
		role: record.role,
		prefix: record.prefix,
		createdAt: record.createdAt,
		createdBy: record.createdBy,
		expiresAt: record.expiresAt,
		status: record.revokedAt
			? "revoked"
			: record.acceptedAt
				? "accepted"
				: Date.parse(record.expiresAt) <= now
					? "expired"
					: "pending",
		acceptedAt: record.acceptedAt,
		acceptedBy: record.acceptedBy,
		revokedAt: record.revokedAt,
	};
}

function newSecret(prefix: string, id: string) {
	const secret = `${prefix}_${id}_${randomBytes(32).toString("base64url")}`;
	return {
		secret,
		hash: tokenHash(secret),
		masked: `${secret.slice(0, 12)}…${secret.slice(-4)}`,
	};
}

function issueSession(record: UserRecord, now: number) {
	const { secret, hash } = newSecret("ses", record._id);
	const expiresAt = iso(now + SESSION_TTL_MS);
	record.sessions = [
		{ hash, createdAt: iso(now), expiresAt },
		...record.sessions.filter((session) => Date.parse(session.expiresAt) > now),
	].slice(0, MAX_SESSIONS);
	return { token: secret, expiresAt };
}

function recentFailures(record: UserRecord, now: number) {
	return (record.failedSignIns ?? []).filter(
		(failure) => now - Date.parse(failure) < SIGN_IN_WINDOW_MS,
	);
}

function actorName(actor: TeamActor) {
	return actor.kind === "user"
		? actor.member.name || actor.member.email
		: "Owner credential";
}

/** MongoDB or process memory with the same compare-and-swap semantics. */
class Documents<T extends Stored> {
	private readonly memory = new Map<string, T>();
	constructor(
		private readonly mongo?: () => Collection<Document>,
		private readonly unique?: keyof T,
	) {}
	private copy(record: Document | T | null | undefined) {
		return record ? (structuredClone(record) as T) : null;
	}
	async get(id: string) {
		return this.copy(
			this.mongo
				? await this.mongo().findOne({ _id: id as never })
				: this.memory.get(id),
		);
	}
	async findBy(field: keyof T, value: string) {
		return this.copy(
			this.mongo
				? await this.mongo().findOne({ [field]: value })
				: [...this.memory.values()].find((record) => record[field] === value),
		);
	}
	async list() {
		const records = this.mongo
			? await this.mongo().find().toArray()
			: [...this.memory.values()];
		return records.map((record) => this.copy(record) as T);
	}
	/** False when the ID (or the unique field) is already taken. */
	async insert(record: T) {
		if (!this.mongo) {
			const unique = this.unique;
			if (
				this.memory.has(record._id) ||
				(unique &&
					[...this.memory.values()].some(
						(item) => item[unique] === record[unique],
					))
			)
				return false;
			this.memory.set(record._id, structuredClone(record));
			return true;
		}
		try {
			await this.mongo().insertOne(structuredClone(record) as Document);
			return true;
		} catch (error) {
			if ((error as { code?: unknown }).code === 11000) return false;
			throw error;
		}
	}
	async replace(record: T, revision: number) {
		if (!this.mongo) {
			if (this.memory.get(record._id)?.revision !== revision) return false;
			this.memory.set(record._id, structuredClone(record));
			return true;
		}
		const write = await this.mongo().replaceOne(
			{ _id: record._id as never, revision },
			structuredClone(record) as Document,
		);
		return write.matchedCount > 0;
	}
	async remove(id: string) {
		if (!this.mongo) return this.memory.delete(id);
		return (
			(await this.mongo().deleteOne({ _id: id as never })).deletedCount > 0
		);
	}
}

/**
 * Team accounts: first-run setup, email + password sign-in, revocable
 * sessions, invite links, and team management. Reads go to MongoDB on every
 * request so removals and role changes apply across API replicas.
 */
export class AccountStore {
	private client?: MongoClient;
	private readonly users: Documents<UserRecord>;
	private readonly setup: Documents<SetupRecord>;
	private readonly invites: Documents<InviteRecord>;
	private completed = false;
	private indexed = false;
	readonly persistence: "mongodb" | "memory";
	constructor(
		private readonly options: { mongodbUrl?: string; now?: () => number } = {},
	) {
		const mongo = (name: string) =>
			options.mongodbUrl ? () => this.collection(name) : undefined;
		this.persistence = options.mongodbUrl ? "mongodb" : "memory";
		this.users = new Documents(mongo("gateway_users"), "email");
		this.setup = new Documents(mongo("gateway_setup"));
		this.invites = new Documents(mongo("gateway_invites"));
	}
	private now() {
		return (this.options.now ?? Date.now)();
	}
	private collection(name: string) {
		const create = () =>
			new MongoClient(this.options.mongodbUrl as string, {
				serverSelectionTimeoutMS: 1500,
				...mongoOperationDeadlines(3000),
				readPreference: "primary",
			});
		let client = requestMongoClient(this, create);
		if (!client) {
			this.client ??= create();
			client = this.client;
		}
		return client.db().collection(name);
	}
	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof AccountError) throw error;
			throw new AccountError(
				"Team accounts are unavailable. Check MongoDB and retry.",
				503,
			);
		}
	}
	private async mutate<T extends Stored, R>(
		documents: Documents<T>,
		id: string,
		change: (record: T, now: number) => R,
		fallback: (() => T) | AccountError,
	): Promise<R> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const existing = await this.storage(() => documents.get(id));
			if (!existing && fallback instanceof AccountError) throw fallback;
			const record = existing ?? (fallback as () => T)();
			const revision = record.revision;
			const result = change(record, this.now());
			record.revision = revision + 1;
			const saved = await this.storage(() =>
				existing
					? documents.replace(record, revision)
					: documents.insert(record),
			);
			if (saved) return result;
		}
		throw new AccountError(
			"The team changed during this request. Refresh and try again.",
			409,
		);
	}
	private async insertUser(record: UserRecord) {
		if (this.options.mongodbUrl && !this.indexed) {
			await this.collection("gateway_users")
				.createIndex({ email: 1 }, { unique: true, name: "email_unique" })
				.then(() => {
					this.indexed = true;
				})
				// The lookup before each insert still rejects duplicates.
				.catch(() => {});
		}
		if (!(await this.storage(() => this.users.insert(record))))
			throw new AccountError(
				"A team member with this email already exists.",
				409,
			);
	}
	private async assertEmailAvailable(email: string) {
		if (await this.storage(() => this.users.findBy("email", email)))
			throw new AccountError(
				"A team member with this email already exists.",
				409,
			);
	}
	private newUser(
		input: { email: string; name: string; role: TeamRole },
		passwordHash: string,
		joinedVia: TeamMember["joinedVia"],
		addedBy: string | null,
		now: number,
		signedIn: boolean,
	): UserRecord {
		return {
			_id: randomUUID(),
			revision: 0,
			email: normalizeEmail(input.email),
			name: input.name.trim(),
			role: input.role,
			createdAt: iso(now),
			updatedAt: iso(now),
			joinedVia,
			addedBy,
			lastSignInAt: signedIn ? iso(now) : null,
			passwordHash,
			failedSignIns: [],
			sessions: [],
		};
	}

	async isSetupComplete(): Promise<boolean> {
		if (this.completed) return true;
		const record = await this.storage(() => this.setup.get("default"));
		// Completion is permanent, so later requests skip the read.
		if (record?.completedAt) this.completed = true;
		return this.completed;
	}

	async status(ownerCredentialConfigured: boolean): Promise<AuthStatus> {
		return {
			setupComplete: await this.isSetupComplete(),
			ownerCredentialConfigured,
			persistence: this.persistence,
		};
	}

	/** Creates the first owner and marks setup complete in one guarded step. */
	async completeSetup(input: SetupRequest): Promise<AuthSession> {
		assertPassword(input.password);
		if (await this.isSetupComplete()) throw this.setupDone();
		const passwordHash = await hashPassword(input.password);
		const now = this.now();
		const record = this.newUser(
			{ ...input, role: "owner" },
			passwordHash,
			"setup",
			null,
			now,
			true,
		);
		// This compare-and-swap is the only gate: a concurrent setup loses here.
		await this.mutate(
			this.setup,
			"default",
			(setup, at) => {
				if (setup.completedAt) throw this.setupDone();
				setup.completedAt = iso(at);
				setup.ownerId = record._id;
			},
			() => ({
				_id: "default",
				revision: 0,
				completedAt: null,
				ownerId: null,
			}),
		);
		const session = issueSession(record, now);
		try {
			await this.insertUser(record);
		} catch (error) {
			// Reopen setup so it can be retried. If this fails too, setup stays
			// closed (fail closed); OWNER_TOKEN or a database fix recovers it.
			await this.mutate(
				this.setup,
				"default",
				(setup) => {
					if (setup.ownerId === record._id) {
						setup.completedAt = null;
						setup.ownerId = null;
					}
				},
				new AccountError("Not found.", 404),
			).catch(() => {});
			throw error;
		}
		this.completed = true;
		return { ...session, user: publicMember(record) };
	}
	private setupDone() {
		return new AccountError("Setup is already complete. Sign in instead.", 409);
	}

	/**
	 * Unknown emails take the same time and answer as a wrong password. After
	 * repeated failures an account is throttled for the rest of the window.
	 */
	async signIn(input: SignInRequest): Promise<AuthSession> {
		const email = normalizeEmail(input.email);
		const user = await this.storage(() => this.users.findBy("email", email));
		if (!user) {
			await verifyDecoy(input.password);
			throw incorrect();
		}
		const failures = recentFailures(user, this.now());
		if (failures.length >= SIGN_IN_MAX_FAILURES) {
			const wait =
				SIGN_IN_WINDOW_MS - (this.now() - Date.parse(failures.at(-1) ?? ""));
			throw new AccountError(
				`Too many failed sign-in attempts. Try again in ${Math.max(1, Math.ceil(wait / 60_000))} minutes.`,
				429,
			);
		}
		const valid = await verifyPassword(input.password, user.passwordHash);
		const session = await this.mutate(
			this.users,
			user._id,
			(record, now) => {
				if (!valid || record.passwordHash !== user.passwordHash) {
					record.failedSignIns = [iso(now), ...recentFailures(record, now)];
					return null;
				}
				record.failedSignIns = [];
				record.lastSignInAt = iso(now);
				return { ...issueSession(record, now), user: publicMember(record) };
			},
			incorrect(),
		);
		if (!session) throw incorrect();
		return session;
	}

	async authenticate(
		token: string,
	): Promise<{ member: TeamMember; expiresAt: string } | null> {
		const match = SESSION_PATTERN.exec(token);
		if (!match) return null;
		const record = await this.storage(() => this.users.get(match[1]));
		if (!record) return null;
		const now = this.now();
		const session = record.sessions.find(
			(item) =>
				Date.parse(item.expiresAt) > now && secretMatches(token, item.hash),
		);
		return session
			? { member: publicMember(record), expiresAt: session.expiresAt }
			: null;
	}

	async signOut(token: string) {
		const match = SESSION_PATTERN.exec(token);
		if (!match) return;
		const hash = tokenHash(token);
		await this.mutate(
			this.users,
			match[1],
			(record) => {
				record.sessions = record.sessions.filter(
					(session) => session.hash !== hash,
				);
			},
			new AccountError("Not found.", 404),
		).catch((error) => {
			if (!(error instanceof AccountError && error.statusCode === 404))
				throw error;
		});
	}

	/** Self-service change. Other sessions for the account are signed out. */
	async changePassword(
		member: TeamMember,
		currentToken: string,
		input: ChangePasswordRequest,
	) {
		assertPassword(input.newPassword);
		const record = await this.storage(() => this.users.get(member.id));
		if (!record) throw missingMember();
		if (recentFailures(record, this.now()).length >= SIGN_IN_MAX_FAILURES)
			throw new AccountError("Too many failed attempts. Try again later.", 429);
		const valid = await verifyPassword(
			input.currentPassword,
			record.passwordHash,
		);
		const passwordHash = valid ? await hashPassword(input.newPassword) : "";
		const keep = tokenHash(currentToken);
		const changed = await this.mutate(
			this.users,
			member.id,
			(current, now) => {
				if (!valid) {
					current.failedSignIns = [iso(now), ...recentFailures(current, now)];
					return false;
				}
				current.passwordHash = passwordHash;
				current.failedSignIns = [];
				current.sessions = current.sessions.filter(
					(session) => session.hash === keep,
				);
				current.updatedAt = iso(now);
				return true;
			},
			missingMember(),
		);
		if (!changed)
			throw new AccountError("Your current password is incorrect.", 403);
	}

	static canManage(actor: TeamActor) {
		return (
			actor.kind === "owner" ||
			(actor.kind === "user" && actor.member.role !== "member")
		);
	}

	async team(actor: TeamActor): Promise<TeamSettings> {
		const [users, invites] = await Promise.all([
			this.storage(() => this.users.list()),
			this.storage(() => this.invites.list()),
		]);
		const now = this.now();
		return {
			members: users
				.map(publicMember)
				.sort(
					(a, b) =>
						a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
				),
			invites: invites
				.map((invite) => publicInvite(invite, now))
				.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
				.slice(0, LISTED_INVITES),
			persistence: this.persistence,
			currentUserId: actor.kind === "user" ? actor.member.id : null,
			canManage:
				(await this.isSetupComplete()) && AccountStore.canManage(actor),
		};
	}

	private async authorize(actor: TeamActor, roles: TeamRole[]) {
		if (!(await this.isSetupComplete()))
			throw new AccountError("Finish setup before managing the team.", 409);
		if (!AccountStore.canManage(actor))
			throw new AccountError(
				"Only owners and admins can manage the team.",
				403,
			);
		if (
			roles.includes("owner") &&
			actor.kind === "user" &&
			actor.member.role !== "owner"
		)
			throw new AccountError(
				"Only owners can invite, add, change, or remove owners.",
				403,
			);
	}

	private async ownerCount() {
		return (await this.storage(() => this.users.list())).filter(
			(record) => record.role === "owner",
		).length;
	}

	private async member(id: string) {
		const record = await this.storage(() => this.users.get(id));
		if (!record) throw missingMember();
		return record;
	}

	/** Adds an account directly with an initial password the admin shares. */
	async addMember(
		input: AddTeamMemberRequest,
		actor: TeamActor,
	): Promise<TeamMember> {
		await this.authorize(actor, [input.role]);
		assertPassword(input.password);
		await this.assertEmailAvailable(normalizeEmail(input.email));
		const record = this.newUser(
			input,
			await hashPassword(input.password),
			"added",
			actorName(actor),
			this.now(),
			false,
		);
		await this.insertUser(record);
		return publicMember(record);
	}

	async updateMember(
		id: string,
		input: UpdateTeamMemberRequest,
		actor: TeamActor,
	): Promise<TeamMember> {
		const current = await this.member(id);
		await this.authorize(actor, [current.role, input.role]);
		const owners = await this.ownerCount();
		return this.mutate(
			this.users,
			id,
			(record, now) => {
				if (record.role === "owner" && input.role !== "owner" && owners <= 1)
					throw lastOwner();
				record.name = input.name.trim();
				record.role = input.role;
				record.updatedAt = iso(now);
				return publicMember(record);
			},
			missingMember(),
		);
	}

	/** Sets a new password for another member and signs them out everywhere. */
	async resetPassword(
		id: string,
		password: string,
		actor: TeamActor,
	): Promise<TeamMember> {
		const current = await this.member(id);
		await this.authorize(actor, [current.role]);
		if (actor.kind === "user" && actor.member.id === id)
			throw new AccountError("Use Change password for your own account.", 409);
		assertPassword(password);
		const passwordHash = await hashPassword(password);
		return this.mutate(
			this.users,
			id,
			(record, now) => {
				record.passwordHash = passwordHash;
				record.sessions = [];
				record.failedSignIns = [];
				record.updatedAt = iso(now);
				return publicMember(record);
			},
			missingMember(),
		);
	}

	async removeMember(id: string, actor: TeamActor): Promise<TeamMember> {
		const record = await this.member(id);
		await this.authorize(actor, [record.role]);
		if (actor.kind === "user" && actor.member.id === id)
			throw new AccountError(
				"You can't remove yourself. Ask another owner or admin.",
				409,
			);
		if (record.role === "owner" && (await this.ownerCount()) <= 1)
			throw lastOwner();
		// Sessions live in the member document, so removal signs them out everywhere.
		await this.storage(() => this.users.remove(id));
		return publicMember(record);
	}

	async createInvite(
		input: CreateTeamInviteRequest,
		actor: TeamActor,
	): Promise<TeamInviteSecret> {
		await this.authorize(actor, [input.role]);
		const now = this.now();
		const id = randomUUID();
		const { secret, hash, masked } = newSecret("inv", id);
		const record: InviteRecord = {
			_id: id,
			revision: 0,
			hash,
			prefix: masked,
			role: input.role,
			createdAt: iso(now),
			createdBy: actorName(actor),
			expiresAt: iso(now + input.ttlDays * 86_400_000),
			acceptedAt: null,
			acceptedBy: null,
			acceptedUserId: null,
			revokedAt: null,
		};
		await this.storage(() => this.invites.insert(record));
		return { invite: publicInvite(record, now), token: secret };
	}

	async revokeInvite(id: string, actor: TeamActor): Promise<TeamInvite> {
		const invite = await this.storage(() => this.invites.get(id));
		if (!invite) throw new AccountError("Invite not found.", 404);
		await this.authorize(actor, [invite.role]);
		return this.mutate(
			this.invites,
			id,
			(record, now) => {
				if (!record.acceptedAt && !record.revokedAt)
					record.revokedAt = iso(now);
				return publicInvite(record, now);
			},
			new AccountError("Invite not found.", 404),
		);
	}

	private async openInvite(token: string) {
		const match = INVITE_PATTERN.exec(token);
		if (!match) throw invalidInvite();
		const record = await this.storage(() => this.invites.get(match[1]));
		if (
			!record ||
			!secretMatches(token, record.hash) ||
			publicInvite(record, this.now()).status !== "pending"
		)
			throw invalidInvite();
		return record;
	}

	async previewInvite(token: string): Promise<InvitePreview> {
		const record = await this.openInvite(token);
		return {
			role: record.role,
			invitedBy: record.createdBy,
			expiresAt: record.expiresAt,
		};
	}

	/** Redeems a single-use invite link: claims it, then creates the account. */
	async acceptInvite(input: AcceptInviteRequest): Promise<AuthSession> {
		assertPassword(input.password);
		const invite = await this.openInvite(input.token);
		const email = normalizeEmail(input.email);
		await this.assertEmailAvailable(email);
		const passwordHash = await hashPassword(input.password);
		const now = this.now();
		const record = this.newUser(
			{ email, name: input.name, role: invite.role },
			passwordHash,
			"invite",
			invite.createdBy,
			now,
			true,
		);
		await this.mutate(
			this.invites,
			invite._id,
			(current, at) => {
				if (publicInvite(current, at).status !== "pending")
					throw invalidInvite();
				current.acceptedAt = iso(at);
				current.acceptedBy = email;
				current.acceptedUserId = record._id;
			},
			invalidInvite(),
		);
		const session = issueSession(record, now);
		try {
			await this.insertUser(record);
		} catch (error) {
			// Give the link back if the account could not be created.
			await this.mutate(
				this.invites,
				invite._id,
				(current) => {
					if (current.acceptedUserId === record._id) {
						current.acceptedAt = null;
						current.acceptedBy = null;
						current.acceptedUserId = null;
					}
				},
				invalidInvite(),
			).catch(() => {});
			throw error;
		}
		return { ...session, user: publicMember(record) };
	}

	async close() {
		const client = this.client;
		this.client = undefined;
		await client?.close();
	}
}
