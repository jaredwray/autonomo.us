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
/** A setup marker whose owner never appeared within this window was abandoned. */
export const SETUP_STALE_MS = 60_000;
/**
 * A setup must start creating its owner this long before its marker turns
 * stale: longer than index creation plus one insert can take, so a stalled
 * setup can never add an owner after a retry has replaced its marker.
 */
export const SETUP_MARGIN_MS = 15_000;
/** Upper bound on holding the owner-change lock if a request dies mid-change. */
export const OWNER_LOCK_MS = 60_000;
/**
 * A holder stops committing this long before its lease ends: longer than one
 * MongoDB write can take (1.5 s server selection + 3 s socket deadline), so an
 * expired holder can never commit after another request takes the lock.
 */
export const OWNER_LOCK_MARGIN_MS = 15_000;
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
	/** Serializes changes that remove an owner, so two can't drop the last one. */
	ownerLock?: { holder: string; expiresAt: string } | null;
};
type InviteRecord = Omit<TeamInvite, "id" | "status"> & {
	_id: string;
	revision: number;
	hash: string;
	acceptedUserId: string | null;
};
type Stored = { _id: string; revision: number };

const iso = (time: number) => new Date(time).toISOString();
export const normalizeEmail = (email: string) => email.trim().toLowerCase();
const incorrect = () => new AccountError("Incorrect email or password.", 401);
const invalidInvite = () =>
	new AccountError(
		"This invite link is invalid, expired, or already used. Ask an admin for a new one.",
		404,
	);
const missingMember = () => new AccountError("Team member not found.", 404);
const changedMember = () =>
	new AccountError(
		"This member changed during your request. Refresh and try again.",
		409,
	);
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

const actorName = (actor: TeamMember) => actor.name || actor.email;

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
	/** With a revision, deletes only if the record is unchanged since it was read. */
	async remove(id: string, revision?: number) {
		if (!this.mongo) {
			const current = this.memory.get(id);
			if (!current || (revision !== undefined && current.revision !== revision))
				return false;
			return this.memory.delete(id);
		}
		return (
			(
				await this.mongo().deleteOne({
					_id: id as never,
					...(revision === undefined ? {} : { revision }),
				})
			).deletedCount > 0
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

	/**
	 * Setup is complete only once its marker names an owner that exists. A
	 * marker without its owner is either still being written (pending) or was
	 * left behind by a crash or rollback, after which setup can run again.
	 */
	private async setupState(record: SetupRecord | null) {
		if (!record?.completedAt) return "open" as const;
		const ownerId = record.ownerId;
		if (ownerId && (await this.storage(() => this.users.get(ownerId))))
			return "complete" as const;
		return this.now() - Date.parse(record.completedAt) < SETUP_STALE_MS
			? ("pending" as const)
			: ("open" as const);
	}

	async isSetupComplete(): Promise<boolean> {
		if (this.completed) return true;
		const record = await this.storage(() => this.setup.get("default"));
		// Only a committed setup is cached; later requests then skip the reads.
		if ((await this.setupState(record)) === "complete") this.completed = true;
		return this.completed;
	}

	async status(setupTokenConfigured: boolean): Promise<AuthStatus> {
		const setupComplete = await this.isSetupComplete();
		return {
			setupComplete,
			setupTokenRequired: setupTokenConfigured && !setupComplete,
			persistence: this.persistence,
		};
	}

	/** Creates the first owner and marks setup complete in one guarded step. */
	async completeSetup(input: SetupRequest): Promise<AuthSession> {
		assertPassword(input.password);
		const seen = await this.storage(() => this.setup.get("default"));
		const state = await this.setupState(seen);
		if (state === "complete") {
			this.completed = true;
			throw this.setupDone();
		}
		if (state === "pending")
			throw new AccountError(
				"Setup is finishing in another request. Try again in a minute.",
				409,
			);
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
		const claimedAt = await this.mutate(
			this.setup,
			"default",
			(setup, at) => {
				// Any write since we looked means another setup got there first.
				if (setup.revision !== (seen?.revision ?? 0)) throw this.setupDone();
				setup.completedAt = iso(at);
				setup.ownerId = record._id;
				return at;
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
			if (this.now() - claimedAt >= SETUP_STALE_MS - SETUP_MARGIN_MS)
				throw new AccountError(
					"Setup took too long and was not saved. Try again.",
					503,
				);
			await this.insertUser(record);
		} catch (error) {
			// Reopen setup so it can be retried. If this fails too, the marker
			// without an owner is treated as abandoned after SETUP_STALE_MS.
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
		if (failures.length >= SIGN_IN_MAX_FAILURES) throw this.throttled(failures);
		const valid = await verifyPassword(input.password, user.passwordHash);
		type Outcome =
			| { kind: "throttled"; failures: string[] }
			| { kind: "incorrect" }
			| { kind: "signed-in"; session: AuthSession };
		const outcome = await this.mutate<UserRecord, Outcome>(
			this.users,
			user._id,
			(record, now) => {
				// Re-check at commit: concurrent guesses must not slip past the limit,
				// and a correct guess beyond it must not be confirmed.
				const recent = recentFailures(record, now);
				if (recent.length >= SIGN_IN_MAX_FAILURES)
					return { kind: "throttled", failures: recent };
				if (!valid || record.passwordHash !== user.passwordHash) {
					record.failedSignIns = [iso(now), ...recent];
					return { kind: "incorrect" };
				}
				record.failedSignIns = [];
				record.lastSignInAt = iso(now);
				return {
					kind: "signed-in",
					session: { ...issueSession(record, now), user: publicMember(record) },
				};
			},
			incorrect(),
		);
		if (outcome.kind === "throttled") throw this.throttled(outcome.failures);
		if (outcome.kind === "incorrect") throw incorrect();
		return outcome.session;
	}
	private throttled(failures: string[]) {
		const wait =
			SIGN_IN_WINDOW_MS - (this.now() - Date.parse(failures.at(-1) ?? ""));
		return new AccountError(
			`Too many failed sign-in attempts. Try again in ${Math.max(1, Math.ceil(wait / 60_000))} minutes.`,
			429,
		);
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
				// A reset or sign-out since we verified wins over this change.
				if (
					current.passwordHash !== record.passwordHash ||
					!current.sessions.some((session) => session.hash === keep)
				)
					throw new AccountError(
						"Your account changed during this request. Sign in again and retry.",
						409,
					);
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

	static canManage(actor: TeamMember) {
		return actor.role !== "member";
	}

	async team(actor: TeamMember): Promise<TeamSettings> {
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
			currentUserId: actor.id,
			canManage: AccountStore.canManage(actor),
		};
	}

	private authorize(actor: TeamMember, roles: TeamRole[]) {
		if (!AccountStore.canManage(actor))
			throw new AccountError(
				"Only owners and admins can manage the team.",
				403,
			);
		if (roles.includes("owner") && actor.role !== "owner")
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
		actor: TeamMember,
	): Promise<TeamMember> {
		this.authorize(actor, [input.role]);
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

	/**
	 * Runs a change that may remove an owner while holding a lease on the setup
	 * record, so concurrent demotions or removals see each other's results and
	 * cannot leave the team without an owner. `fence` must run immediately
	 * before the final write: it refuses to commit once the lease is too close
	 * to expiring, so a stalled holder cannot race the next one.
	 */
	private async withOwnerLock<T>(
		work: (fence: () => void) => Promise<T>,
	): Promise<T> {
		const holder = randomUUID();
		const deadline = this.now() + OWNER_LOCK_MS - OWNER_LOCK_MARGIN_MS;
		const fence = () => {
			if (this.now() >= deadline)
				throw new AccountError(
					"This owner change took too long and was not saved. Try again.",
					503,
				);
		};
		await this.mutate(
			this.setup,
			"default",
			(setup, now) => {
				if (setup.ownerLock && Date.parse(setup.ownerLock.expiresAt) > now)
					throw new AccountError(
						"Another owner change is in progress. Try again in a moment.",
						409,
					);
				setup.ownerLock = { holder, expiresAt: iso(now + OWNER_LOCK_MS) };
			},
			new AccountError("Finish setup before managing the team.", 409),
		);
		try {
			return await work(fence);
		} finally {
			await this.mutate(
				this.setup,
				"default",
				(setup) => {
					if (setup.ownerLock?.holder === holder) setup.ownerLock = null;
				},
				new AccountError("Not found.", 404),
			).catch(() => {});
		}
	}

	async updateMember(
		id: string,
		input: UpdateTeamMemberRequest,
		actor: TeamMember,
	): Promise<TeamMember> {
		const current = await this.member(id);
		this.authorize(actor, [current.role, input.role]);
		const demotes = current.role === "owner" && input.role !== "owner";
		const apply = async (fence?: () => void) => {
			const owners = demotes ? await this.ownerCount() : 0;
			return this.mutate(
				this.users,
				id,
				(record, now) => {
					this.authorize(actor, [record.role, input.role]);
					if (record.role === "owner" && input.role !== "owner") {
						// Became an owner after we looked: retry so the lock applies.
						if (!demotes) throw changedMember();
						if (owners <= 1) throw lastOwner();
					}
					fence?.();
					record.name = input.name.trim();
					record.role = input.role;
					record.updatedAt = iso(now);
					return publicMember(record);
				},
				missingMember(),
			);
		};
		return demotes ? this.withOwnerLock(apply) : apply();
	}

	/** Sets a new password for another member and signs them out everywhere. */
	async resetPassword(
		id: string,
		password: string,
		actor: TeamMember,
	): Promise<TeamMember> {
		const current = await this.member(id);
		this.authorize(actor, [current.role]);
		if (actor.id === id)
			throw new AccountError("Use Change password for your own account.", 409);
		assertPassword(password);
		const passwordHash = await hashPassword(password);
		return this.mutate(
			this.users,
			id,
			(record, now) => {
				// The member may have been promoted while the password hashed.
				this.authorize(actor, [record.role]);
				record.passwordHash = passwordHash;
				record.sessions = [];
				record.failedSignIns = [];
				record.updatedAt = iso(now);
				return publicMember(record);
			},
			missingMember(),
		);
	}

	async removeMember(id: string, actor: TeamMember): Promise<TeamMember> {
		const seen = await this.member(id);
		this.authorize(actor, [seen.role]);
		if (actor.id === id)
			throw new AccountError(
				"You can't remove yourself. Ask another owner or admin.",
				409,
			);
		const remove = async (fence?: () => void) => {
			const record = seen.role === "owner" ? await this.member(id) : seen;
			if (record.role !== seen.role) throw changedMember();
			if (record.role === "owner" && (await this.ownerCount()) <= 1)
				throw lastOwner();
			fence?.();
			// Sessions live in the member document, so removal signs them out
			// everywhere. The revision check refuses a member changed meanwhile.
			if (!(await this.storage(() => this.users.remove(id, record.revision))))
				throw changedMember();
			return publicMember(record);
		};
		return seen.role === "owner" ? this.withOwnerLock(remove) : remove();
	}

	async createInvite(
		input: CreateTeamInviteRequest,
		actor: TeamMember,
	): Promise<TeamInviteSecret> {
		this.authorize(actor, [input.role]);
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

	async revokeInvite(id: string, actor: TeamMember): Promise<TeamInvite> {
		const invite = await this.storage(() => this.invites.get(id));
		if (!invite) throw new AccountError("Invite not found.", 404);
		this.authorize(actor, [invite.role]);
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
