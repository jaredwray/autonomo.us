import type {
	FailoverPolicy,
	RoutingConfig,
	RoutingSettings,
} from "@autonomo.us/common";
import { DEFAULT_FAILOVER_POLICY, mergeFailoverPolicy } from "../failover.js";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import type { ProviderRegistry } from "../providers/registry.js";
import type { WorkspaceRef } from "../workspaces/store.js";

export class RoutingError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export function defaultRoutingConfig(failover: FailoverPolicy): RoutingConfig {
	return {
		auto: {
			enabled: false,
			decisionModel: "",
			targets: [],
			fallbackTarget: "",
			timeoutMs: 10_000,
		},
		pools: [],
		failover,
		rules: [],
	};
}

/** No recursive aliases: pools contain concrete models; auto may choose a pool. */
export function validateRouting(
	config: RoutingConfig,
	registry: ProviderRegistry,
) {
	const poolConnection = registry
		.listProviders()
		.some((provider) => provider.name === "pool");
	if (poolConnection && config.pools.length)
		throw new RoutingError(
			"A legacy connection named 'pool' already uses the pool/ prefix. Use a different connection name before creating routing pools.",
		);
	const chat = (id: string) => {
		if (!id.includes("/") || (id.startsWith("pool/") && !poolConnection))
			throw new RoutingError(`Use a connection/model target: ${id}`);
		try {
			registry.resolve(id);
		} catch {
			throw new RoutingError(`Unknown chat target: ${id}`);
		}
	};
	const unique = (ids: string[], label: string) => {
		if (new Set(ids).size !== ids.length)
			throw new RoutingError(`Duplicate ${label}.`);
	};
	unique(
		config.pools.map((p) => p.id),
		"pool IDs",
	);
	for (const pool of config.pools) {
		unique(
			pool.members.map((m) => m.model),
			`members in pool ${pool.id}`,
		);
		for (const member of pool.members) chat(member.model);
	}
	const target = (id: string) => {
		if (id.startsWith("pool/") && !poolConnection) {
			if (!config.pools.some((p) => `pool/${p.id}` === id))
				throw new RoutingError(`Unknown pool: ${id}`);
		} else chat(id);
	};
	unique(
		config.auto.targets.map((t) => t.target),
		"Auto targets",
	);
	for (const item of config.auto.targets) target(item.target);
	if (config.auto.decisionModel) {
		try {
			registry.resolveProvider(config.auto.decisionModel);
		} catch {
			throw new RoutingError("Unknown decision model.");
		}
	}
	if (config.auto.fallbackTarget) target(config.auto.fallbackTarget);
	if (config.auto.enabled) {
		if (!config.auto.decisionModel || config.auto.targets.length < 2)
			throw new RoutingError(
				"Auto needs a decision model and at least two targets.",
			);
		if (
			!config.auto.targets.some((t) => t.target === config.auto.fallbackTarget)
		)
			throw new RoutingError(
				"Choose an Auto fallback from its allowed targets.",
			);
	}
	unique(
		config.rules.map((r) => r.model),
		"failover rules",
	);
	for (const rule of config.rules) {
		target(rule.model);
		for (const id of rule.targets) chat(id);
	}
	for (const id of config.failover.targets) chat(id);
}

type RoutingDocument = {
	_id: string;
	config: RoutingConfig;
	/** Compare-and-swap counter; missing on documents saved before workspaces. */
	revision?: number;
};
type Stored = { config: RoutingConfig; revision: number };

/**
 * One routing document per workspace, read on every request so a change is
 * visible to every replica and Worker isolate on its next request. Writes are
 * a compare-and-swap on `revision`: a lost race returns 409 instead of
 * silently merging. The default workspace keeps its document at `_id:
 * "default"`, an internal key that never appears in a URI.
 */
export class RoutingSettingsStore {
	private readonly mongo?: MongoConnection;
	/** Memory mode: this server's routing, keyed by workspace id. */
	private readonly memory = new Map<string, Stored>();
	private readonly seedPolicy: FailoverPolicy;

	constructor(seedPolicy: FailoverPolicy, mongo?: string | MongoConnection) {
		// Copied once: the environment (or injected) policy seeds only the
		// default workspace, and only when its document is first created.
		this.seedPolicy = mergeFailoverPolicy(seedPolicy);
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}

	get persistence(): "mongodb" | "memory" {
		return this.mongo ? "mongodb" : "memory";
	}

	private collection() {
		return (this.mongo as MongoConnection).collection<RoutingDocument>(
			"gateway_routing",
		);
	}

	private key(workspace: WorkspaceRef) {
		return workspace.isDefault ? "default" : workspace.id;
	}

	private seed(workspace: WorkspaceRef): RoutingConfig {
		return defaultRoutingConfig(
			workspace.isDefault
				? structuredClone(this.seedPolicy)
				: { ...DEFAULT_FAILOVER_POLICY, targets: [] },
		);
	}

	private async read(workspace: WorkspaceRef): Promise<Stored> {
		if (!this.mongo) {
			const stored = this.memory.get(workspace.id) ?? {
				config: this.seed(workspace),
				revision: 0,
			};
			return structuredClone(stored);
		}
		try {
			const collection = this.collection();
			const _id = this.key(workspace);
			// The first read creates the document. Concurrent requests use
			// whichever defaults were saved first.
			let saved = await collection.findOne({ _id });
			if (!saved) {
				try {
					saved = await collection.findOneAndUpdate(
						{ _id },
						{ $setOnInsert: { config: this.seed(workspace), revision: 0 } },
						{ upsert: true, returnDocument: "after" },
					);
				} catch (error) {
					if (!isDuplicateKey(error)) throw error;
					saved = await collection.findOne({ _id });
				}
			}
			if (!saved) throw new Error("Could not initialize routing settings.");
			return {
				config: {
					...saved.config,
					failover: mergeFailoverPolicy(saved.config.failover),
				},
				revision: saved.revision ?? 0,
			};
		} catch (error) {
			throw new RoutingError(
				"Routing settings are unavailable. Check MongoDB and retry.",
				503,
				{ cause: error },
			);
		}
	}

	async config(workspace: WorkspaceRef): Promise<RoutingConfig> {
		return (await this.read(workspace)).config;
	}

	async settings(workspace: WorkspaceRef): Promise<RoutingSettings> {
		return {
			config: await this.config(workspace),
			persistence: this.persistence,
		};
	}

	async update(
		workspace: WorkspaceRef,
		config: RoutingConfig,
		registry: ProviderRegistry,
	): Promise<RoutingSettings> {
		const next = structuredClone(config);
		validateRouting(next, registry);
		next.failover = mergeFailoverPolicy(next.failover);
		const { revision } = await this.read(workspace);
		await this.write(workspace, next, revision);
		return { config: next, persistence: this.persistence };
	}

	/**
	 * A partial edit merged on the server, so a lost race is retried against a
	 * fresh read: concurrent edits to different fields both apply. A full
	 * `update` is a client's snapshot instead, and a lost race returns 409.
	 */
	async updateFailover(
		workspace: WorkspaceRef,
		patch: Partial<FailoverPolicy>,
	): Promise<FailoverPolicy> {
		for (let attempt = 0; ; attempt++) {
			const { config, revision } = await this.read(workspace);
			config.failover = mergeFailoverPolicy(config.failover, patch);
			try {
				await this.write(workspace, config, revision);
				return config.failover;
			} catch (error) {
				if (
					attempt >= 4 ||
					!(error instanceof RoutingError) ||
					error.statusCode !== 409
				)
					throw error;
			}
		}
	}

	private async write(
		workspace: WorkspaceRef,
		config: RoutingConfig,
		revision: number,
	) {
		const changed = () =>
			new RoutingError(
				"Routing changed during your request. Refresh and try again.",
				409,
			);
		if (!this.mongo) {
			if ((this.memory.get(workspace.id)?.revision ?? 0) !== revision)
				throw changed();
			this.memory.set(workspace.id, {
				config: structuredClone(config),
				revision: revision + 1,
			});
			return;
		}
		const _id = this.key(workspace);
		let matched: number;
		try {
			matched = (
				await this.collection().replaceOne(
					// A document saved before workspaces has no revision: match it as 0.
					{
						_id,
						revision:
							revision === 0
								? { $in: [0, null as unknown as number] }
								: revision,
					},
					{ config, revision: revision + 1 },
				)
			).matchedCount;
		} catch {
			throw new RoutingError(
				"Could not save routing settings. Check MongoDB and retry.",
				503,
			);
		}
		if (!matched) throw changed();
	}

	async close() {
		await this.mongo?.close();
	}
}
