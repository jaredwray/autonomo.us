import {
	type AddModelRequest,
	type ManagedProvider,
	PROVIDER_NAMES,
	type ProviderSettings,
} from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import type { ApiConfig, ProviderConfig } from "../config.js";
import { type ProviderRegistry, providerFromConfig } from "./registry.js";

export class ProviderSettingsError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
	}
}

/** Credentials are server-only. Public methods return explicit safe projections. */
export class ProviderSettingsStore {
	private readonly configs = new Map<string, ProviderConfig>();
	private client?: MongoClient;
	private loaded = false;
	private loading?: Promise<void>;
	private writes: Promise<unknown> = Promise.resolve();

	constructor(
		private readonly config: ApiConfig,
		private readonly registry: ProviderRegistry,
	) {
		for (const provider of config.providers)
			this.configs.set(provider.name, provider);
	}

	private collection() {
		this.client ??= new MongoClient(this.config.mongodbUrl as string, {
			serverSelectionTimeoutMS: 1500,
			timeoutMS: 3000,
		});
		return this.client
			.db()
			.collection<{ _id: string; config: ProviderConfig }>("gateway_providers");
	}

	async initialize(): Promise<void> {
		if (this.loaded) return;
		this.loading ??= this.load().finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}

	private async load(): Promise<void> {
		if (this.config.mongodbUrl) {
			try {
				const documents = await this.collection().find({}).toArray();
				for (const { config } of documents) {
					this.registry.register(providerFromConfig(config));
					this.configs.set(config.name, config);
				}
			} catch {
				throw new ProviderSettingsError(
					"Model settings are unavailable. Check the MongoDB connection and retry.",
					503,
				);
			}
		}
		this.loaded = true;
	}

	async settings(): Promise<ProviderSettings> {
		await this.initialize();
		return {
			connections: [...this.configs.values()]
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
				configured: Boolean(this.configs.get(id)?.apiKey),
				...(id === "cloudflare"
					? { accountId: this.cloudflareAccountId() }
					: {}),
			})),
			persistence: this.config.mongodbUrl ? "mongodb" : "memory",
		};
	}

	private cloudflareAccountId() {
		const config = this.configs.get("cloudflare");
		return config?.kind === "cloudflare" ? config.accountId : undefined;
	}

	add(input: AddModelRequest) {
		// Serialize read/merge/write so concurrent additions cannot lose models.
		const result = this.writes.then(() => this.addModel(input));
		this.writes = result.catch(() => {});
		return result;
	}

	private async addModel(input: AddModelRequest) {
		await this.initialize();
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
		const existing = this.configs.get(connectionId);
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
		const apiKey = input.apiKey?.trim() || existing?.apiKey;
		if (!apiKey)
			throw new ProviderSettingsError(
				"An API key is required to connect this provider.",
				400,
			);
		const model = input.model.trim();
		const accountId =
			input.accountId?.trim() ||
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
		const provider = providerFromConfig(config);
		if (this.config.mongodbUrl) {
			try {
				await this.collection().replaceOne(
					{ _id: config.name },
					{ _id: config.name, config },
					{ upsert: true },
				);
			} catch {
				throw new ProviderSettingsError(
					"Could not save the model. Check the MongoDB connection and retry.",
					503,
				);
			}
		}
		// Only publish the change after durable storage succeeds.
		this.configs.set(config.name, config);
		this.registry.register(provider);
		return {
			id: `${config.name}/${model}`,
			provider: config.name,
			model,
			...(provider.capability ? { capability: provider.capability } : {}),
		};
	}

	async close(): Promise<void> {
		await this.writes;
		await this.client?.close();
	}
}
