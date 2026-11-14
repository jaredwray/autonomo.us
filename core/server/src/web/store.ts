import {
	COUNTRY_PATTERN,
	type CreateProxyRequest,
	DEFAULT_PROXY_LEVEL,
	DEFAULT_WEB_POLICY,
	PROXY_KINDS,
	PROXY_LEVELS,
	PROXY_NAME_PATTERN,
	type ProxyConnection,
	type ProxyKind,
	type ProxyProblem,
	type UpdateProxyRequest,
	type UpdateWebPolicyRequest,
	WEB_LIMITS,
	type WebDomainRule,
	type WebPolicy,
	type WebStep,
} from "@autonomo.us/common";
import {
	controlPlaneConnection,
	isDuplicateKey,
	type MongoConnection,
} from "../mongo.js";
import { ServiceError } from "../service-error.js";
import type { WorkspaceRef } from "../workspaces/store.js";
import type { ProxyConfig } from "./types.js";

type ProxyDocument = {
	_id: string;
	workspaceId: string;
	config: ProxyConfig;
	problem: ProxyProblem | null;
};
type PolicyDocument = {
	_id: string;
	policy: Omit<WebPolicy, "revision">;
	revision: number;
};
type UsageDocument = {
	_id: string;
	workspaceId: string;
	requests: number;
	/** Millionths of a US dollar, so sums stay exact. */
	costMicros: number;
	expiresAt: Date;
};
type Counter = { requests: number; costMicros: number };

const HOST_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const DAY_MS = 86_400_000;

export const toMicros = (usd: number) =>
	Number.isFinite(usd) && usd > 0 ? Math.round(usd * 1_000_000) : 0;
const fromMicros = (micros: number) => micros / 1_000_000;

/** `YYYY-MM` and `YYYY-MM-DD` in UTC. */
export function usagePeriods(now: Date) {
	const iso = now.toISOString();
	return { month: iso.slice(0, 7), day: iso.slice(0, 10) };
}

/** What a reservation was refused for. */
export type ReservationRefusal = "caller" | "connection" | "budget";

/** Units held against the caps before a provider call. */
export type Reservation = {
	workspaceId: string;
	keys: { budget: string; caller: string; connection: string };
	costMicros: number;
};

/**
 * Proxy connections, the web policy, and spend counters, per workspace.
 * Connections and policy are read on every request so every replica and
 * Worker isolate sees a change on its next request, as model connections
 * are. Keys stay on the server: public methods return safe projections.
 * Environment connections belong to the default workspace only.
 */
export class ProxyStore {
	private readonly env = new Map<string, ProxyConfig>();
	private readonly mongo?: MongoConnection;
	/** Memory mode: connections per workspace. */
	private readonly memory = new Map<
		string,
		Map<string, { config: ProxyConfig; problem: ProxyProblem | null }>
	>();
	private readonly memoryPolicies = new Map<string, WebPolicy>();
	/** Problems of environment connections, which have no document. */
	private readonly envProblems = new Map<string, ProxyProblem | null>();
	private readonly counters = new Map<string, Counter>();
	private indexed = false;

	constructor(
		envProxies: ProxyConfig[],
		mongo?: string | MongoConnection,
		private readonly now: () => Date = () => new Date(),
	) {
		for (const config of envProxies) this.env.set(config.name, config);
		this.mongo =
			typeof mongo === "string" ? controlPlaneConnection(mongo) : mongo;
	}

	get persistence(): "mongodb" | "memory" {
		return this.mongo ? "mongodb" : "memory";
	}

	private proxies() {
		return (this.mongo as MongoConnection).collection<ProxyDocument>(
			"gateway_proxies",
		);
	}
	private policies() {
		return (this.mongo as MongoConnection).collection<PolicyDocument>(
			"gateway_web_policy",
		);
	}
	private usage() {
		return (this.mongo as MongoConnection).collection<UsageDocument>(
			"gateway_web_usage",
		);
	}

	async ensureIndexes(): Promise<void> {
		if (!this.mongo || this.indexed) return;
		await Promise.all([
			this.proxies().createIndex({ workspaceId: 1 }),
			// Day and month counters delete themselves once nobody reads them.
			this.usage().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
		]);
		this.indexed = true;
	}

	private unavailable(error: unknown): never {
		if (error instanceof ServiceError) throw error;
		throw new ServiceError(
			"Proxy settings are unavailable. Check the MongoDB connection and retry.",
			503,
			{ cause: error },
		);
	}

	/** Saved connections with their problems, keyed by name. */
	private async saved(
		workspace: WorkspaceRef,
	): Promise<
		Map<string, { config: ProxyConfig; problem: ProxyProblem | null }>
	> {
		if (!this.mongo)
			return new Map(
				[...(this.memory.get(workspace.id)?.entries() ?? [])].map(
					([name, entry]) => [name, structuredClone(entry)],
				),
			);
		try {
			const documents = await this.proxies()
				.find({ workspaceId: { $eq: workspace.id } })
				.toArray();
			return new Map(
				documents.map((document) => [
					document.config.name,
					{ config: document.config, problem: document.problem ?? null },
				]),
			);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/**
	 * Every connection in the workspace with its problem and source. Saved
	 * connections win over an environment one with the same name.
	 */
	async entries(workspace: WorkspaceRef): Promise<
		Array<{
			config: ProxyConfig;
			problem: ProxyProblem | null;
			source: "saved" | "environment";
		}>
	> {
		const saved = await this.saved(workspace);
		const result: Array<{
			config: ProxyConfig;
			problem: ProxyProblem | null;
			source: "saved" | "environment";
		}> = [];
		if (workspace.isDefault)
			for (const [name, config] of this.env)
				if (!saved.has(name))
					result.push({
						config: structuredClone(config),
						problem: this.envProblems.get(name) ?? null,
						source: "environment",
					});
		for (const entry of saved.values())
			result.push({ ...entry, source: "saved" });
		return result;
	}

	async connection(
		workspace: WorkspaceRef,
		name: string,
	): Promise<ProxyConfig | undefined> {
		return (await this.entries(workspace)).find(
			(entry) => entry.config.name === name,
		)?.config;
	}

	/** The connections as the dashboard sees them, with this month's usage. */
	async list(workspace: WorkspaceRef): Promise<ProxyConnection[]> {
		const entries = await this.entries(workspace);
		const { month } = usagePeriods(this.now());
		const counters = await this.readCounters(
			entries.map((entry) =>
				this.connectionKey(workspace, entry.config.name, month),
			),
		);
		return entries.map(({ config, problem, source }, index) =>
			publicConnection(config, problem, source, month, counters[index]),
		);
	}

	private validate(config: ProxyConfig): ProxyConfig {
		if (!PROXY_NAME_PATTERN.test(config.name))
			throw new ServiceError(
				"Use a name starting with a lowercase letter, followed by letters, numbers, dashes or underscores (up to 64 characters).",
			);
		if (!(PROXY_KINDS as readonly string[]).includes(config.kind))
			throw new ServiceError(
				`The provider is one of ${PROXY_KINDS.join(", ")}.`,
			);
		if (!config.apiKey || config.apiKey.length > WEB_LIMITS.keyLength)
			throw new ServiceError("An API key is required for this connection.");
		if (config.kind === "cloudflare-browser") {
			if (!/^[a-fA-F0-9]{32}$/.test(config.accountId ?? ""))
				throw new ServiceError(
					"Enter a valid Cloudflare account ID (32 hexadecimal characters).",
				);
		} else if (config.accountId)
			throw new ServiceError("Account ID is only used by Cloudflare.");
		if (config.kind === "brightdata") {
			if (!config.zone || !/^[A-Za-z0-9_-]{1,64}$/.test(config.zone))
				throw new ServiceError(
					"Enter the name of your Bright Data Web Unlocker zone.",
				);
			const price = config.pricePer1000Usd;
			if (
				price !== undefined &&
				(!Number.isFinite(price) || price < 0 || price > 1000)
			)
				throw new ServiceError(
					"The price per 1,000 requests is between 0 and 1,000 dollars.",
				);
		} else {
			if (config.zone)
				throw new ServiceError("A zone is only used by Bright Data.");
			if (config.pricePer1000Usd !== undefined)
				throw new ServiceError(
					"A price per 1,000 requests is only used by Bright Data; the others report what each request cost.",
				);
		}
		if (config.country !== undefined) {
			if (config.kind === "cloudflare-browser")
				throw new ServiceError(
					"Cloudflare Browser Run cannot choose a country.",
				);
			if (!COUNTRY_PATTERN.test(config.country))
				throw new ServiceError(
					"A country is a two-letter code such as us or de.",
				);
		}
		const cap = config.monthlyRequestCap;
		if (
			cap !== null &&
			(!Number.isInteger(cap) ||
				cap < 0 ||
				cap > WEB_LIMITS.maxMonthlyRequestCap)
		)
			throw new ServiceError(
				`A monthly request cap is a whole number up to ${WEB_LIMITS.maxMonthlyRequestCap.toLocaleString("en-US")}, or none.`,
			);
		return config;
	}

	async create(
		workspace: WorkspaceRef,
		input: CreateProxyRequest,
	): Promise<ProxyConnection> {
		const config = this.validate({
			name: input.name,
			kind: input.kind,
			apiKey: input.apiKey?.trim(),
			...(input.accountId?.trim() ? { accountId: input.accountId.trim() } : {}),
			...(input.zone?.trim() ? { zone: input.zone.trim() } : {}),
			...(input.country?.trim()
				? { country: input.country.trim().toLowerCase() }
				: {}),
			...(input.pricePer1000Usd !== undefined
				? { pricePer1000Usd: input.pricePer1000Usd }
				: {}),
			enabled: input.enabled ?? true,
			monthlyRequestCap: input.monthlyRequestCap ?? null,
		});
		const entries = await this.entries(workspace);
		if (entries.some((entry) => entry.config.name === config.name))
			throw new ServiceError(
				"A proxy with this name already exists. Choose another name.",
				409,
			);
		if (entries.length >= WEB_LIMITS.connections)
			throw new ServiceError(
				`A workspace holds at most ${WEB_LIMITS.connections} proxies.`,
				409,
			);
		if (!this.mongo) {
			const saved = this.memory.get(workspace.id) ?? new Map();
			saved.set(config.name, {
				config: structuredClone(config),
				problem: null,
			});
			this.memory.set(workspace.id, saved);
		} else
			try {
				await this.ensureIndexes().catch(() => {});
				await this.proxies().insertOne({
					_id: this.documentId(workspace, config.name),
					workspaceId: workspace.id,
					config,
					problem: null,
				});
			} catch (error) {
				if (isDuplicateKey(error))
					throw new ServiceError(
						"A proxy with this name already exists. Choose another name.",
						409,
					);
				this.unavailable(error);
			}
		return publicConnection(
			config,
			null,
			"saved",
			usagePeriods(this.now()).month,
		);
	}

	/**
	 * Changes the fields the request names. The key changes only when one is
	 * sent, and a changed key clears a reported problem.
	 */
	async update(
		workspace: WorkspaceRef,
		name: string,
		input: UpdateProxyRequest,
	): Promise<ProxyConnection> {
		const entry = (await this.entries(workspace)).find(
			(item) => item.config.name === name,
		);
		if (!entry) throw new ServiceError("Proxy not found.", 404);
		// Every replica reads the same environment, so a change made here could
		// not reach the others. Taking it out of the ladder stops its use.
		if (entry.source === "environment")
			throw new ServiceError(
				"This proxy comes from the gateway's environment and cannot be changed here. Take it out of the ladder to stop using it.",
				409,
			);
		const next: ProxyConfig = { ...entry.config };
		const set = <K extends keyof ProxyConfig>(
			key: K,
			value: ProxyConfig[K] | undefined,
		) => {
			if (value === undefined) return;
			if (value === "" || value === null) delete next[key];
			else next[key] = value;
		};
		if (input.apiKey?.trim()) next.apiKey = input.apiKey.trim();
		set("accountId", input.accountId?.trim());
		set("zone", input.zone?.trim());
		set(
			"country",
			input.country === undefined
				? undefined
				: input.country.trim().toLowerCase(),
		);
		if (input.pricePer1000Usd !== undefined)
			next.pricePer1000Usd = input.pricePer1000Usd;
		if (input.enabled !== undefined) next.enabled = input.enabled === true;
		if (input.monthlyRequestCap !== undefined)
			next.monthlyRequestCap = input.monthlyRequestCap;
		this.validate(next);
		const problem = input.apiKey?.trim() ? null : entry.problem;
		if (!this.mongo) {
			this.memory
				.get(workspace.id)
				?.set(name, { config: structuredClone(next), problem });
		} else
			try {
				const result = await this.proxies().updateOne(
					{ _id: { $eq: this.documentId(workspace, name) } },
					{ $set: { config: next, problem } },
				);
				if (!result.matchedCount)
					throw new ServiceError("Proxy not found.", 404);
			} catch (error) {
				this.unavailable(error);
			}
		const { month } = usagePeriods(this.now());
		const [usage] = await this.readCounters([
			this.connectionKey(workspace, name, month),
		]);
		return publicConnection(next, problem, entry.source, month, usage);
	}

	async remove(workspace: WorkspaceRef, name: string): Promise<void> {
		const entry = (await this.entries(workspace)).find(
			(item) => item.config.name === name,
		);
		if (!entry) throw new ServiceError("Proxy not found.", 404);
		if (entry.source === "environment")
			throw new ServiceError(
				"This proxy comes from the gateway's environment. Take it out of the ladder instead, or remove its variable.",
				409,
			);
		if (!this.mongo) this.memory.get(workspace.id)?.delete(name);
		else
			try {
				await this.proxies().deleteOne({
					_id: { $eq: this.documentId(workspace, name) },
				});
			} catch (error) {
				this.unavailable(error);
			}
		// Its steps leave the ladder; a lost race is retried on a fresh read.
		for (let attempt = 0; attempt < 5; attempt++) {
			const policy = await this.policy(workspace);
			const ladder = policy.ladder.filter(
				(step) => step.kind !== "proxy" || step.connection !== name,
			);
			if (ladder.length === policy.ladder.length) return;
			try {
				await this.writePolicy(
					workspace,
					{ ...policy, ladder },
					policy.revision,
				);
				return;
			} catch (error) {
				if (!(error instanceof ServiceError && error.statusCode === 409))
					throw error;
			}
		}
	}

	/** Records a problem a person has to fix, or clears it with null. */
	async setProblem(
		workspace: WorkspaceRef,
		name: string,
		problem: ProxyProblem | null,
	): Promise<void> {
		const saved = await this.saved(workspace);
		if (!saved.has(name)) {
			if (workspace.isDefault && this.env.has(name))
				this.envProblems.set(name, problem);
			return;
		}
		if (!this.mongo) {
			const entry = this.memory.get(workspace.id)?.get(name);
			if (entry) entry.problem = problem;
			return;
		}
		await this.proxies()
			.updateOne(
				{ _id: { $eq: this.documentId(workspace, name) } },
				{ $set: { problem } },
			)
			.catch(() => {});
	}

	private documentId(workspace: WorkspaceRef, name: string) {
		return `${workspace.id}:${name}`;
	}

	/** The policy the default workspace starts with names its environment connections. */
	private seedPolicy(workspace: WorkspaceRef): WebPolicy {
		const ladder: WebStep[] = [{ kind: "direct" }];
		if (workspace.isDefault) {
			const order: ProxyKind[] = [
				"cloudflare-browser",
				"zenrows",
				"brightdata",
			];
			for (const kind of order)
				for (const config of this.env.values())
					if (config.kind === kind)
						ladder.push({
							kind: "proxy",
							connection: config.name,
							level: DEFAULT_PROXY_LEVEL[kind],
						});
		}
		return { ...structuredClone(DEFAULT_WEB_POLICY), ladder, revision: 0 };
	}

	async policy(workspace: WorkspaceRef): Promise<WebPolicy> {
		if (!this.mongo)
			return structuredClone(
				this.memoryPolicies.get(workspace.id) ?? this.seedPolicy(workspace),
			);
		try {
			const saved = await this.policies().findOne({
				_id: { $eq: workspace.id },
			});
			return saved
				? { ...DEFAULT_WEB_POLICY, ...saved.policy, revision: saved.revision }
				: this.seedPolicy(workspace);
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** Replaces the policy if nobody changed it since `input.revision`. */
	async updatePolicy(
		workspace: WorkspaceRef,
		input: UpdateWebPolicyRequest,
	): Promise<WebPolicy> {
		const connections = new Map(
			(await this.entries(workspace)).map((entry) => [
				entry.config.name,
				entry.config,
			]),
		);
		const policy = validatePolicy(input, connections);
		return this.writePolicy(workspace, policy, input.revision);
	}

	private async writePolicy(
		workspace: WorkspaceRef,
		policy: Omit<WebPolicy, "revision">,
		revision: number,
	): Promise<WebPolicy> {
		const changed = () =>
			new ServiceError(
				"The web settings changed during your request. Reload and try again.",
				409,
			);
		const stored = {
			ladder: policy.ladder,
			domains: policy.domains,
			allowOnly: policy.allowOnly,
			callerProxyRequestsPerDay: policy.callerProxyRequestsPerDay,
			monthlyBudgetUsd: policy.monthlyBudgetUsd,
		};
		if (!this.mongo) {
			if ((this.memoryPolicies.get(workspace.id)?.revision ?? 0) !== revision)
				throw changed();
			const next = { ...structuredClone(stored), revision: revision + 1 };
			this.memoryPolicies.set(workspace.id, next);
			return structuredClone(next);
		}
		try {
			if (revision === 0) {
				// The first save creates the document; a second first save loses.
				await this.policies().insertOne({
					_id: workspace.id,
					policy: stored,
					revision: 1,
				});
			} else {
				const result = await this.policies().replaceOne(
					{ _id: { $eq: workspace.id }, revision: { $eq: revision } },
					{ policy: stored, revision: revision + 1 },
				);
				if (!result.matchedCount) throw changed();
			}
		} catch (error) {
			if (isDuplicateKey(error)) throw changed();
			this.unavailable(error);
		}
		return { ...stored, revision: revision + 1 };
	}

	connectionKey(workspace: WorkspaceRef, name: string, month: string) {
		return `${workspace.id}:connection:${name}:${month}`;
	}
	budgetKey(workspace: WorkspaceRef, month: string) {
		return `${workspace.id}:budget:${month}`;
	}
	callerKey(workspace: WorkspaceRef, callerId: string, day: string) {
		return `${workspace.id}:caller:${callerId}:${day}`;
	}

	private async readCounters(keys: string[]): Promise<Counter[]> {
		if (!this.mongo)
			return keys.map((key) => ({
				...(this.counters.get(key) ?? { requests: 0, costMicros: 0 }),
			}));
		if (!keys.length) return [];
		try {
			const documents = await this.usage()
				.find({ _id: { $in: keys } })
				.toArray();
			const byKey = new Map(
				documents.map((document) => [document._id, document]),
			);
			return keys.map((key) => ({
				requests: byKey.get(key)?.requests ?? 0,
				costMicros: byKey.get(key)?.costMicros ?? 0,
			}));
		} catch (error) {
			this.unavailable(error);
		}
	}

	/** This month's spend across every proxy, against the policy's budget. */
	async budget(workspace: WorkspaceRef, policy: WebPolicy) {
		const { month } = usagePeriods(this.now());
		const [counter] = await this.readCounters([
			this.budgetKey(workspace, month),
		]);
		return {
			month,
			spentUsd: fromMicros(counter.costMicros),
			limitUsd: policy.monthlyBudgetUsd,
		};
	}

	/**
	 * Adds `requests` and `costMicros` to a counter only if it stays within
	 * the caps. Two calls that arrive together cannot both take the last unit:
	 * the filter and the increment are one operation.
	 */
	private async increment(
		workspaceId: string,
		key: string,
		amount: Counter,
		caps: { requests?: number; costMicros?: number },
		expiresAt: Date,
	): Promise<boolean> {
		if (
			(caps.requests !== undefined && amount.requests > caps.requests) ||
			(caps.costMicros !== undefined && amount.costMicros > caps.costMicros)
		)
			return false;
		if (!this.mongo) {
			const current = this.counters.get(key) ?? { requests: 0, costMicros: 0 };
			if (
				(caps.requests !== undefined &&
					current.requests + amount.requests > caps.requests) ||
				(caps.costMicros !== undefined &&
					current.costMicros + amount.costMicros > caps.costMicros)
			)
				return false;
			this.counters.set(key, {
				requests: current.requests + amount.requests,
				costMicros: current.costMicros + amount.costMicros,
			});
			return true;
		}
		const filter: Record<string, unknown> = { _id: { $eq: key } };
		if (caps.requests !== undefined)
			filter.requests = { $lte: caps.requests - amount.requests };
		if (caps.costMicros !== undefined)
			filter.costMicros = { $lte: caps.costMicros - amount.costMicros };
		try {
			await this.usage().updateOne(
				filter,
				{
					$inc: { requests: amount.requests, costMicros: amount.costMicros },
					$setOnInsert: { workspaceId, expiresAt },
				},
				{ upsert: true },
			);
			return true;
		} catch (error) {
			// The counter exists and is over the cap, so the upsert collided.
			if (isDuplicateKey(error)) return false;
			this.unavailable(error);
		}
	}

	private async adjust(key: string, amount: Counter) {
		if (!amount.requests && !amount.costMicros) return;
		if (!this.mongo) {
			const current = this.counters.get(key);
			if (!current) return;
			current.requests = Math.max(0, current.requests + amount.requests);
			current.costMicros = Math.max(0, current.costMicros + amount.costMicros);
			return;
		}
		await this.usage()
			.updateOne(
				{ _id: { $eq: key } },
				{ $inc: { requests: amount.requests, costMicros: amount.costMicros } },
			)
			.catch(() => {});
	}

	/**
	 * Holds one request and the most it can cost against the workspace's
	 * monthly budget, the caller's daily cap, and the connection's monthly cap,
	 * in that order, undoing what it took if a later cap refuses.
	 */
	async reserve(
		workspace: WorkspaceRef,
		input: {
			connection: ProxyConfig;
			callerId: string;
			callerCap: number;
			budgetUsd: number;
			maxCostUsd: number;
		},
	): Promise<Reservation | { refused: ReservationRefusal }> {
		const now = this.now();
		const { month, day } = usagePeriods(now);
		const keys = {
			budget: this.budgetKey(workspace, month),
			caller: this.callerKey(workspace, input.callerId, day),
			connection: this.connectionKey(workspace, input.connection.name, month),
		};
		const costMicros = toMicros(input.maxCostUsd);
		const monthEnd = new Date(
			Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
		);
		const monthExpiry = new Date(monthEnd.getTime() + 400 * DAY_MS);
		const dayExpiry = new Date(Date.parse(`${day}T00:00:00Z`) + 2 * DAY_MS);
		if (
			!(await this.increment(
				workspace.id,
				keys.budget,
				{ requests: 1, costMicros },
				{ costMicros: toMicros(input.budgetUsd) },
				monthExpiry,
			))
		)
			return { refused: "budget" };
		if (
			!(await this.increment(
				workspace.id,
				keys.caller,
				{ requests: 1, costMicros: 0 },
				{ requests: input.callerCap },
				dayExpiry,
			))
		) {
			await this.adjust(keys.budget, { requests: -1, costMicros: -costMicros });
			return { refused: "caller" };
		}
		if (
			!(await this.increment(
				workspace.id,
				keys.connection,
				{ requests: 1, costMicros },
				input.connection.monthlyRequestCap === null
					? {}
					: { requests: input.connection.monthlyRequestCap },
				monthExpiry,
			))
		) {
			await this.adjust(keys.budget, { requests: -1, costMicros: -costMicros });
			await this.adjust(keys.caller, { requests: -1, costMicros: 0 });
			return { refused: "connection" };
		}
		return { workspaceId: workspace.id, keys, costMicros };
	}

	/**
	 * Settles a reservation once the provider has answered: gives everything
	 * back when nothing was billed, otherwise replaces the held cost with the
	 * actual one.
	 */
	async settle(
		reservation: Reservation,
		outcome: { billed: boolean; costUsd: number },
	): Promise<void> {
		const { keys, costMicros } = reservation;
		if (!outcome.billed) {
			await Promise.all([
				this.adjust(keys.budget, { requests: -1, costMicros: -costMicros }),
				this.adjust(keys.caller, { requests: -1, costMicros: 0 }),
				this.adjust(keys.connection, { requests: -1, costMicros: -costMicros }),
			]);
			return;
		}
		const difference = toMicros(outcome.costUsd) - costMicros;
		await Promise.all([
			this.adjust(keys.budget, { requests: 0, costMicros: difference }),
			this.adjust(keys.connection, { requests: 0, costMicros: difference }),
		]);
	}

	async close(): Promise<void> {
		await this.mongo?.close();
	}
}

function publicConnection(
	config: ProxyConfig,
	problem: ProxyProblem | null,
	source: "saved" | "environment",
	month: string,
	usage: Counter = { requests: 0, costMicros: 0 },
): ProxyConnection {
	return {
		name: config.name,
		kind: config.kind,
		keyConfigured: Boolean(config.apiKey),
		...(config.accountId ? { accountId: config.accountId } : {}),
		...(config.zone ? { zone: config.zone } : {}),
		...(config.country ? { country: config.country } : {}),
		...(config.kind === "brightdata"
			? { pricePer1000Usd: config.pricePer1000Usd ?? 1.5 }
			: {}),
		enabled: config.enabled,
		monthlyRequestCap: config.monthlyRequestCap,
		source,
		usage: {
			month,
			requests: usage.requests,
			costUsd: fromMicros(usage.costMicros),
		},
		problem,
	};
}

/** Checks a policy a person sent against the workspace's connections. */
export function validatePolicy(
	input: UpdateWebPolicyRequest,
	connections: Map<string, ProxyConfig>,
): Omit<WebPolicy, "revision"> {
	if (
		!Array.isArray(input.ladder) ||
		input.ladder.length > WEB_LIMITS.ladderSteps
	)
		throw new ServiceError(
			`A ladder has at most ${WEB_LIMITS.ladderSteps} steps.`,
		);
	const seen = new Set<string>();
	const ladder: WebStep[] = input.ladder.map((step) => {
		if (step.kind === "direct") {
			if (seen.has("direct"))
				throw new ServiceError("The plain request can be in the ladder once.");
			seen.add("direct");
			return { kind: "direct" };
		}
		if (typeof step.connection !== "string" || typeof step.level !== "string")
			throw new ServiceError("A proxy step names a connection and a level.");
		const config = connections.get(step.connection);
		if (!config)
			throw new ServiceError(
				`The ladder names ${step.connection}, which is not a proxy in this workspace.`,
			);
		if (!PROXY_LEVELS[config.kind].includes(step.level))
			throw new ServiceError(
				`${step.connection} does not have the ${step.level} level. Use one of ${PROXY_LEVELS[config.kind].join(", ")}.`,
			);
		const label = `${step.connection}:${step.level}`;
		if (seen.has(label))
			throw new ServiceError(`${label} is in the ladder twice.`);
		seen.add(label);
		return { kind: "proxy", connection: step.connection, level: step.level };
	});
	if (
		!Array.isArray(input.domains) ||
		input.domains.length > WEB_LIMITS.domainRules
	)
		throw new ServiceError(
			`A workspace has at most ${WEB_LIMITS.domainRules} domain rules.`,
		);
	const hosts = new Set<string>();
	const domains: WebDomainRule[] = input.domains.map((rule) => {
		const match = rule.match.trim().toLowerCase().replace(/\.$/, "");
		if (!HOST_PATTERN.test(match))
			throw new ServiceError(
				`${rule.match} is not a host name. Use a host such as example.com.`,
			);
		if (hosts.has(match))
			throw new ServiceError(`${match} has more than one rule.`);
		hosts.add(match);
		return { match, rule: rule.rule };
	});
	const perDay = input.callerProxyRequestsPerDay;
	if (
		!Number.isInteger(perDay) ||
		perDay < 0 ||
		perDay > WEB_LIMITS.maxCallerProxyRequestsPerDay
	)
		throw new ServiceError(
			`Proxied requests a day is a whole number from 0 to ${WEB_LIMITS.maxCallerProxyRequestsPerDay.toLocaleString("en-US")}.`,
		);
	const budget = input.monthlyBudgetUsd;
	if (
		typeof budget !== "number" ||
		!Number.isFinite(budget) ||
		budget < 0 ||
		budget > WEB_LIMITS.maxMonthlyBudgetUsd
	)
		throw new ServiceError(
			`The monthly budget is from 0 to ${WEB_LIMITS.maxMonthlyBudgetUsd.toLocaleString("en-US")} dollars.`,
		);
	return {
		ladder,
		domains,
		allowOnly: input.allowOnly === true,
		callerProxyRequestsPerDay: perDay,
		monthlyBudgetUsd: Math.round(budget * 100) / 100,
	};
}

/** The rule for a host: the most specific match, if any. */
export function domainRule(
	policy: Pick<WebPolicy, "domains">,
	host: string,
): WebDomainRule | undefined {
	let best: WebDomainRule | undefined;
	for (const rule of policy.domains)
		if (
			(host === rule.match || host.endsWith(`.${rule.match}`)) &&
			(!best || rule.match.length > best.match.length)
		)
			best = rule;
	return best;
}
