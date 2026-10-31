import type {
	FailoverPolicy,
	RoutingConfig,
	RoutingSettings,
} from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import type { FailoverPolicyStore } from "../failover.js";
import type { ProviderRegistry } from "../providers/registry.js";

export class RoutingError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
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

/** Serializes writes and publishes settings only after MongoDB acknowledges them. */
export class RoutingSettingsStore {
	private config: RoutingConfig;
	private client?: MongoClient;
	private loaded = false;
	private loading?: Promise<void>;
	private writes: Promise<unknown> = Promise.resolve();
	constructor(
		private readonly registry: ProviderRegistry,
		private readonly failover: FailoverPolicyStore,
		private readonly mongodbUrl?: string,
	) {
		this.config = defaultRoutingConfig(failover.get());
	}
	private collection() {
		this.client ??= new MongoClient(this.mongodbUrl as string, {
			serverSelectionTimeoutMS: 1500,
			timeoutMS: 3000,
		});
		return this.client
			.db()
			.collection<{ _id: string; config: RoutingConfig }>("gateway_routing");
	}
	async initialize(): Promise<void> {
		if (this.loaded) return;
		this.loading ??= (async () => {
			try {
				if (this.mongodbUrl) {
					const saved = await this.collection().findOne({ _id: "default" });
					if (saved) {
						this.config = saved.config;
						this.failover.update(saved.config.failover);
					}
				}
				this.loaded = true;
			} catch {
				throw new RoutingError(
					"Routing settings are unavailable. Check MongoDB and retry.",
					503,
				);
			}
		})().finally(() => {
			this.loading = undefined;
		});
		return this.loading;
	}
	get(): RoutingConfig {
		return structuredClone({ ...this.config, failover: this.failover.get() });
	}
	async settings(): Promise<RoutingSettings> {
		await this.initialize();
		return {
			config: this.get(),
			persistence: this.mongodbUrl ? "mongodb" : "memory",
		};
	}
	update(config: RoutingConfig) {
		return this.enqueue(() => this.save(config));
	}
	updateFailover(patch: Partial<FailoverPolicy>) {
		return this.enqueue(async () => {
			await this.initialize();
			const config = this.get();
			config.failover = { ...config.failover, ...patch };
			await this.save(config, false);
			return this.failover.get();
		});
	}
	private enqueue<T>(write: () => Promise<T>): Promise<T> {
		const result = this.writes.then(write);
		this.writes = result.catch(() => {});
		return result;
	}
	private async save(
		config: RoutingConfig,
		validate = true,
	): Promise<RoutingSettings> {
		await this.initialize();
		const next = structuredClone(config);
		if (validate) validateRouting(next, this.registry);
		if (this.mongodbUrl) {
			try {
				await this.collection().replaceOne(
					{ _id: "default" },
					{ _id: "default", config: next },
					{ upsert: true },
				);
			} catch {
				throw new RoutingError(
					"Could not save routing settings. Check MongoDB and retry.",
					503,
				);
			}
		}
		this.config = next;
		this.failover.update(next.failover);
		return this.settings();
	}
	async close() {
		await this.writes;
		await this.client?.close();
	}
}
