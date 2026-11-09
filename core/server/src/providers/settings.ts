import {
	type AddModelRequest,
	type ManagedProvider,
	PROVIDER_NAMES,
	type ProviderSettings,
} from "@autonomo.us/common";
import type { ApiConfig, ProviderConfig } from "../config.js";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { type WorkspaceRef, workspaceFilter } from "../workspaces/store.js";
import { ProviderRegistry, providerFromConfig } from "./registry.js";

export class ProviderSettingsError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

type ProviderDocument = {
	_id: string;
	/** Missing on connections saved before workspaces: those belong to the default workspace. */
	workspaceId?: string;
	config: ProviderConfig;
};

/**
 * Saved provider connections per workspace, read on every request so every
 * replica and Worker isolate sees a change on its next request. The default
 * workspace keeps its connections at `_id` = connection name, as before
 * workspaces; other workspaces use `<workspaceId>:<connection>`. Saved
 * connection names cannot contain `:`, so the two key spaces never collide.
 *
 * Environment providers (and a registry injected into `createServer`) belong
 * to the default workspace only; they are an overlay applied when the registry
 * is built and are never written into the store. Credentials are server-only:
 * public methods return explicit safe projections.
 */
export class ProviderSettingsStore {
	private readonly env = new Map<string, ProviderConfig>();
	private readonly envRegistry: ProviderRegistry;
	private readonly mongo?: MongoConnection;
	/** Memory mode: this server's saved connections, keyed by workspace id. */
	private readonly memory = new Map<string, Map<string, ProviderConfig>>();
	private indexed = false;

	constructor(
		config: ApiConfig,
		envRegistry: ProviderRegistry,
		mongo?: string | MongoConnection,
	) {
		for (const provider of config.providers)
			this.env.set(provider.name, provider);
		// Copied once: later saves never register into the injected registry.
		this.envRegistry = envRegistry.snapshot();
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}

	get persistence(): "mongodb" | "memory" {
		return this.mongo ? "mongodb" : "memory";
	}

	private collection() {
		return (this.mongo as MongoConnection).collection<ProviderDocument>(
			"gateway_providers",
		);
	}

	async ensureIndexes(): Promise<void> {
		if (!this.mongo || this.indexed) return;
		await this.collection().createIndex({ workspaceId: 1 });
		this.indexed = true;
	}

	private documentId(workspace: WorkspaceRef, name: string) {
		return workspace.isDefault ? name : `${workspace.id}:${name}`;
	}

	/** This workspace's saved connections, keyed by connection name. */
	private async saved(
		workspace: WorkspaceRef,
	): Promise<Map<string, ProviderConfig>> {
		if (!this.mongo)
			return new Map(
				[...(this.memory.get(workspace.id)?.entries() ?? [])].map(
					([name, config]) => [name, structuredClone(config)],
				),
			);
		try {
			const documents = await this.collection()
				.find({ workspaceId: workspaceFilter(workspace) })
				.toArray();
			return new Map(documents.map(({ config }) => [config.name, config]));
		} catch (error) {
			throw new ProviderSettingsError(
				"Model settings are unavailable. Check the MongoDB connection and retry.",
				503,
				{ cause: error },
			);
		}
	}

	/** Saved connections win over environment providers with the same name. */
	private async configs(
		workspace: WorkspaceRef,
	): Promise<Map<string, ProviderConfig>> {
		const saved = await this.saved(workspace);
		return workspace.isDefault ? new Map([...this.env, ...saved]) : saved;
	}

	/** A registry for one request: built fresh, never shared across requests. */
	async registry(workspace: WorkspaceRef): Promise<ProviderRegistry> {
		const registry = workspace.isDefault
			? this.envRegistry.snapshot()
			: new ProviderRegistry();
		for (const config of (await this.saved(workspace)).values())
			registry.register(providerFromConfig(config));
		return registry;
	}

	/** Proves saved settings for the default workspace load (health and startup). */
	async check(workspace: WorkspaceRef): Promise<void> {
		await this.saved(workspace);
	}

	async settings(workspace: WorkspaceRef): Promise<ProviderSettings> {
		const configs = await this.configs(workspace);
		const cloudflare = configs.get("cloudflare");
		return {
			connections: [...configs.values()]
				.filter((config) => config.kind !== "openai-compatible")
				.map((config) => ({
					id: config.name,
					provider: config.kind as ManagedProvider,
					configured: Boolean(config.apiKey),
					...(config.kind === "cloudflare"
						? { accountId: config.accountId }
						: {}),
				})),
			providers: Object.entries(PROVIDER_NAMES).map(([id, name]) => ({
				id: id as ManagedProvider,
				name,
				configured: Boolean(configs.get(id)?.apiKey),
				...(id === "cloudflare"
					? {
							accountId:
								cloudflare?.kind === "cloudflare"
									? cloudflare.accountId
									: undefined,
						}
					: {}),
			})),
			persistence: this.persistence,
		};
	}

	async add(workspace: WorkspaceRef, input: AddModelRequest) {
		const connectionId = input.connectionId ?? input.provider;
		if (!/^[a-z][a-z0-9_-]{0,63}$/.test(connectionId)) {
			throw new ProviderSettingsError(
				"Use a connection name starting with a lowercase letter, followed by letters, numbers, dashes or underscores (up to 64 characters).",
				400,
			);
		}
		if (
			Object.hasOwn(PROVIDER_NAMES, connectionId) &&
			connectionId !== input.provider
		) {
			throw new ProviderSettingsError(
				"This connection name is reserved for another provider.",
				409,
			);
		}
		const configs = await this.configs(workspace);
		const existing = configs.get(connectionId);
		if (connectionId === "pool" && !existing) {
			throw new ProviderSettingsError(
				"The connection name 'pool' is reserved for routing pools.",
				409,
			);
		}
		if (input.createConnection && existing) {
			throw new ProviderSettingsError(
				"A connection with this name already exists. Choose that connection or use a different name.",
				409,
			);
		}
		if (existing && existing.kind !== input.provider) {
			throw new ProviderSettingsError(
				"This provider name is already used by another adapter.",
				409,
			);
		}
		const newKey = input.apiKey?.trim() || undefined;
		const apiKey = newKey ?? existing?.apiKey;
		if (!apiKey)
			throw new ProviderSettingsError(
				"An API key is required to connect this provider.",
				400,
			);
		const model = input.model.trim();
		const newAccount = input.accountId?.trim() || undefined;
		const accountId =
			newAccount ??
			(existing?.kind === "cloudflare" ? existing.accountId : undefined);
		if (
			input.provider === "cloudflare" &&
			!/^[a-fA-F0-9]{32}$/.test(accountId ?? "")
		) {
			throw new ProviderSettingsError(
				"Enter a valid Cloudflare account ID (32 hexadecimal characters).",
				400,
			);
		}
		if (input.accountId && input.provider !== "cloudflare") {
			throw new ProviderSettingsError(
				"Account ID is only used by Cloudflare.",
				400,
			);
		}
		const config: ProviderConfig = {
			kind: input.provider,
			name: connectionId,
			baseURL: existing?.baseURL,
			apiKey,
			...(input.provider === "cloudflare" ? { accountId } : {}),
			models: [...new Set([...(existing?.models ?? []), model])],
		};
		// Validates the config before anything is saved.
		const provider = providerFromConfig(config);
		await this.save(workspace, config, {
			model,
			apiKey: newKey,
			accountId: newAccount,
			create: Boolean(input.createConnection),
		});
		return {
			id: `${config.name}/${model}`,
			provider: config.name,
			model,
			...(provider.capability ? { capability: provider.capability } : {}),
		};
	}

	/**
	 * Inserts a new connection, or updates an existing one field by field, so a
	 * concurrent change from another replica is never overwritten with a value
	 * this request merely read: the key and account change only when the
	 * request supplied them, and models are added with `$addToSet`.
	 */
	private async save(
		workspace: WorkspaceRef,
		config: ProviderConfig,
		change: {
			model: string;
			apiKey?: string;
			accountId?: string;
			create: boolean;
		},
	) {
		if (!this.mongo) {
			const saved = this.memory.get(workspace.id) ?? new Map();
			const current = saved.get(config.name);
			saved.set(
				config.name,
				current
					? {
							...current,
							...(change.apiKey ? { apiKey: change.apiKey } : {}),
							...(change.accountId ? { accountId: change.accountId } : {}),
							models: [...new Set([...current.models, change.model])],
						}
					: structuredClone(config),
			);
			this.memory.set(workspace.id, saved);
			return;
		}
		const _id = this.documentId(workspace, config.name);
		const exists = () =>
			new ProviderSettingsError(
				"A connection with this name already exists. Choose that connection or use a different name.",
				409,
			);
		try {
			await this.ensureIndexes().catch(() => {});
			const collection = this.collection();
			// A concurrent addition can insert the connection between our update
			// and insert; the retry then applies this change field by field.
			for (let attempt = 0; attempt < 3; attempt++) {
				if (!change.create) {
					const update = await collection.updateOne(
						{
							_id,
							workspaceId: workspaceFilter(workspace),
							"config.kind": config.kind,
						},
						{
							$set: {
								workspaceId: workspace.id,
								...(change.apiKey ? { "config.apiKey": change.apiKey } : {}),
								...(change.accountId
									? { "config.accountId": change.accountId }
									: {}),
							},
							$addToSet: { "config.models": change.model },
						},
					);
					if (update.matchedCount) return;
				}
				try {
					await collection.insertOne({
						_id,
						workspaceId: workspace.id,
						config,
					});
					return;
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					// Creating never touches an existing connection.
					if (change.create) throw exists();
				}
			}
			throw new ProviderSettingsError(
				"This connection changed during your request. Refresh and try again.",
				409,
			);
		} catch (error) {
			if (error instanceof ProviderSettingsError) throw error;
			throw new ProviderSettingsError(
				"Could not save the model. Check the MongoDB connection and retry.",
				503,
			);
		}
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}
