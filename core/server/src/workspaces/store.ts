import { randomUUID } from "node:crypto";
import type {
	CreateWorkspaceRequest,
	UpdateWorkspaceRequest,
	Workspace,
	WorkspaceAction,
} from "@autonomo.us/common";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";

/** What every workspace-scoped service needs to know about the request's workspace. */
export type WorkspaceRef = { id: string; isDefault: boolean };

export const WORKSPACE_ID_PATTERN =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * Records saved before workspaces have no `workspaceId` and belong to the
 * default workspace. Every filter for the default workspace, in reads and in
 * writes, must also match a missing field; others match the exact id.
 */
export function workspaceFilter(
	workspace: WorkspaceRef,
): string | { $in: string[] } {
	// `null` in `$in` also matches a missing field. The driver's filter types
	// leave it out, so it is cast to fit; the query is what MongoDB documents.
	return workspace.isDefault
		? { $in: [workspace.id, null as unknown as string] }
		: workspace.id;
}

/** The in-memory equivalent of `workspaceFilter`. */
export function inWorkspace(
	workspaceId: string | null | undefined,
	workspace: WorkspaceRef,
): boolean {
	return (
		workspaceId === workspace.id || (workspace.isDefault && workspaceId == null)
	);
}

export class WorkspaceError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
	}
}

type WorkspaceRecord = Omit<Workspace, "id"> & {
	_id: string;
	revision: number;
	actions: WorkspaceAction[];
};
type InstanceRecord = {
	_id: string;
	defaultWorkspaceId: string;
	createdAt: string;
};

const MAX_ACTIONS = 100;
const notFound = () => new WorkspaceError("Workspace not found.", 404);

export function publicWorkspace(record: WorkspaceRecord): Workspace {
	return {
		id: record._id,
		isDefault: record.isDefault,
		name: record.name,
		description: record.description,
		createdAt: record.createdAt,
		createdBy: record.createdBy,
		updatedAt: record.updatedAt,
		archivedAt: record.archivedAt,
	};
}

/**
 * Workspaces and the instance pointer that names the default one. The default
 * workspace gets a generated UUID like every other; `gateway_instance` records
 * it with a `$setOnInsert` upsert so concurrent startups agree on one id. The
 * id never changes, so it is cached after the first read.
 */
export class WorkspaceStore {
	private readonly mongo?: MongoConnection;
	private readonly memory = new Map<string, WorkspaceRecord>();
	private memoryDefaultId?: string;
	private defaultId?: Promise<string>;
	readonly persistence: "mongodb" | "memory";

	constructor(
		mongo?: string | MongoConnection,
		private readonly now = Date.now,
	) {
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
		this.persistence = this.mongo ? "mongodb" : "memory";
	}

	private workspaces() {
		return (this.mongo as MongoConnection).collection<WorkspaceRecord>(
			"gateway_workspaces",
		);
	}

	private async storage<T>(operation: () => Promise<T>): Promise<T> {
		try {
			return await operation();
		} catch (error) {
			if (error instanceof WorkspaceError) throw error;
			throw new WorkspaceError(
				"Workspaces are unavailable. Check MongoDB and retry.",
				503,
			);
		}
	}

	private newRecord(
		id: string,
		input: { name: string; description: string },
		isDefault: boolean,
		createdBy: string | null,
	): WorkspaceRecord {
		const at = new Date(this.now()).toISOString();
		return {
			_id: id,
			revision: 0,
			isDefault,
			name: input.name,
			description: input.description,
			createdAt: at,
			createdBy,
			updatedAt: at,
			archivedAt: null,
			actions: [
				{
					id: randomUUID(),
					action: "created",
					timestamp: at,
					actorName: createdBy,
					detail: isDefault
						? "Default workspace created for everything that existed before workspaces."
						: `Workspace "${input.name}" created.`,
				},
			],
		};
	}

	/** The default workspace's id, creating the pointer and its document on first use. */
	defaultWorkspaceId(): Promise<string> {
		this.defaultId ??= this.ensureDefault().catch((error) => {
			this.defaultId = undefined;
			throw error;
		});
		return this.defaultId;
	}

	async defaultWorkspace(): Promise<WorkspaceRef> {
		return { id: await this.defaultWorkspaceId(), isDefault: true };
	}

	private async ensureDefault(): Promise<string> {
		const defaults = { name: "Default", description: "" };
		if (!this.mongo) {
			if (!this.memoryDefaultId) {
				this.memoryDefaultId = randomUUID();
				this.memory.set(
					this.memoryDefaultId,
					this.newRecord(this.memoryDefaultId, defaults, true, null),
				);
			}
			return this.memoryDefaultId;
		}
		const mongo = this.mongo;
		return this.storage(async () => {
			const instance = mongo.collection<InstanceRecord>("gateway_instance");
			let pointer = await instance.findOne({ _id: "default" });
			if (!pointer) {
				try {
					pointer = await instance.findOneAndUpdate(
						{ _id: "default" },
						{
							$setOnInsert: {
								defaultWorkspaceId: randomUUID(),
								createdAt: new Date(this.now()).toISOString(),
							},
						},
						{ upsert: true, returnDocument: "after" },
					);
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					// Another startup inserted the pointer first: use its id.
					pointer = await instance.findOne({ _id: "default" });
				}
			}
			if (!pointer) throw new Error("Could not create the default workspace.");
			const id = pointer.defaultWorkspaceId;
			const { _id, ...record } = this.newRecord(id, defaults, true, null);
			try {
				// Idempotent: a crash after the pointer write is repaired here.
				await this.workspaces().updateOne(
					{ _id: id },
					{ $setOnInsert: record },
					{ upsert: true },
				);
			} catch (error) {
				if (!isDuplicateKey(error)) throw error;
			}
			return id;
		});
	}

	async ensureIndexes(): Promise<void> {
		await this.defaultWorkspaceId();
	}

	async get(id: string): Promise<Workspace | null> {
		await this.defaultWorkspaceId();
		const record = this.mongo
			? await this.storage(() => this.workspaces().findOne({ _id: id }))
			: this.memory.get(id);
		return record ? publicWorkspace(record) : null;
	}

	/** Lifecycle history, newest first. */
	async actions(id: string): Promise<WorkspaceAction[]> {
		const record = this.mongo
			? await this.storage(() =>
					this.workspaces().findOne(
						{ _id: id },
						{ projection: { actions: 1 } },
					),
				)
			: this.memory.get(id);
		return structuredClone(record?.actions ?? []);
	}

	async list(): Promise<Workspace[]> {
		await this.defaultWorkspaceId();
		const records = this.mongo
			? await this.storage(() => this.workspaces().find().toArray())
			: [...this.memory.values()];
		return records
			.map(publicWorkspace)
			.sort(
				(a, b) =>
					Number(b.isDefault) - Number(a.isDefault) ||
					a.createdAt.localeCompare(b.createdAt) ||
					a.id.localeCompare(b.id),
			);
	}

	async create(
		input: CreateWorkspaceRequest,
		actorName: string,
	): Promise<Workspace> {
		await this.defaultWorkspaceId();
		const record = this.newRecord(
			randomUUID(),
			{ name: input.name.trim(), description: input.description?.trim() ?? "" },
			false,
			actorName,
		);
		if (this.mongo)
			await this.storage(() => this.workspaces().insertOne(record));
		else this.memory.set(record._id, structuredClone(record));
		return publicWorkspace(record);
	}

	/**
	 * Field-level edits guarded by `revision`, never a whole-document replace,
	 * so a concurrent edit is retried instead of silently overwritten.
	 */
	private async change(
		id: string,
		apply: (record: WorkspaceRecord) => {
			set: Partial<WorkspaceRecord>;
			action: Omit<WorkspaceAction, "id" | "timestamp">;
		} | null,
	): Promise<Workspace> {
		for (let attempt = 0; attempt < 5; attempt++) {
			const current = this.mongo
				? await this.storage(() => this.workspaces().findOne({ _id: id }))
				: structuredClone(this.memory.get(id));
			if (!current) throw notFound();
			const change = apply(current);
			if (!change) return publicWorkspace(current);
			const at = new Date(this.now()).toISOString();
			const action: WorkspaceAction = {
				id: randomUUID(),
				timestamp: at,
				...change.action,
			};
			const set = { ...change.set, updatedAt: at };
			if (this.mongo) {
				const result = await this.storage(() =>
					this.workspaces().findOneAndUpdate(
						{ _id: id, revision: current.revision },
						{
							$set: set,
							$inc: { revision: 1 },
							$push: {
								actions: {
									$each: [action],
									$position: 0,
									$slice: MAX_ACTIONS,
								},
							},
						},
						{ returnDocument: "after" },
					),
				);
				if (result) return publicWorkspace(result);
				continue;
			}
			const stored = this.memory.get(id);
			if (!stored || stored.revision !== current.revision) continue;
			const next: WorkspaceRecord = {
				...current,
				...set,
				revision: current.revision + 1,
				actions: [action, ...current.actions].slice(0, MAX_ACTIONS),
			};
			this.memory.set(id, next);
			return publicWorkspace(next);
		}
		throw new WorkspaceError(
			"This workspace changed during your request. Refresh and try again.",
			409,
		);
	}

	update(
		id: string,
		input: UpdateWorkspaceRequest,
		actorName: string,
	): Promise<Workspace> {
		const name = input.name.trim();
		const description = input.description.trim();
		return this.change(id, (record) =>
			record.name === name && record.description === description
				? null
				: {
						set: { name, description },
						action: {
							action: "updated",
							actorName,
							detail:
								record.name === name
									? "Description updated."
									: `Renamed from "${record.name}" to "${name}".`,
						},
					},
		);
	}

	setArchived(
		id: string,
		archived: boolean,
		actorName: string,
	): Promise<Workspace> {
		return this.change(id, (record) => {
			if (record.isDefault && archived)
				throw new WorkspaceError(
					"The default workspace cannot be archived.",
					409,
				);
			if (Boolean(record.archivedAt) === archived) return null;
			return {
				set: {
					archivedAt: archived ? new Date(this.now()).toISOString() : null,
				},
				action: archived
					? {
							action: "archived",
							actorName,
							detail:
								"Archived: every token and session request to this workspace is refused.",
						}
					: { action: "unarchived", actorName, detail: "Unarchived." },
			};
		});
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}
