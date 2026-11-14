import { DEFAULT_WEB_POLICY, type WebPolicy } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { ServiceError } from "../src/service-error.js";
import { domainRule, ProxyStore, validatePolicy } from "../src/web/store.js";
import type { ProxyConfig } from "../src/web/types.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const DEFAULT = { id: "00000000-0000-4000-8000-000000000001", isDefault: true };
const OTHER = { id: "00000000-0000-4000-8000-000000000002", isDefault: false };
const ENV_ZENROWS: ProxyConfig = {
	name: "zenrows",
	kind: "zenrows",
	apiKey: "zr-env-key",
	enabled: true,
	monthlyRequestCap: null,
};
const ACCOUNT = "0123456789abcdef0123456789abcdef";

const available = await mongoAvailable();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ServiceError)
			return { status: error.statusCode, message: error.message };
		throw error;
	}
	throw new Error("Expected a refusal.");
}

function stores(): Array<[string, () => Promise<ProxyStore>]> {
	const memory: [string, () => Promise<ProxyStore>] = [
		"memory",
		async () => new ProxyStore([ENV_ZENROWS]),
	];
	if (!available) return [memory];
	return [
		memory,
		[
			"mongodb",
			async () => {
				const url = uniqueMongoUrl("webstore");
				const store = new ProxyStore([ENV_ZENROWS], url);
				cleanups.push(async () => {
					const client = new MongoClient(url);
					await client.db().dropDatabase();
					await client.close();
					await store.close();
				});
				return store;
			},
		],
	];
}

describe.each(stores())("proxy store (%s)", (_mode, make) => {
	it("adds a connection and never shows its key", async () => {
		const store = await make();
		const created = await store.create(OTHER, {
			name: "zr-work",
			kind: "zenrows",
			apiKey: "zr-secret",
			country: "DE",
		});
		expect(created).toMatchObject({
			name: "zr-work",
			kind: "zenrows",
			keyConfigured: true,
			country: "de",
			enabled: true,
			monthlyRequestCap: null,
			source: "saved",
			problem: null,
		});
		const listed = await store.list(OTHER);
		expect(listed.map((item) => item.name)).toEqual(["zr-work"]);
		expect(JSON.stringify(listed)).not.toContain("zr-secret");
		expect((await store.connection(OTHER, "zr-work"))?.apiKey).toBe(
			"zr-secret",
		);
	});

	it("keeps environment connections in the default workspace only", async () => {
		const store = await make();
		expect((await store.list(DEFAULT)).map((item) => item.source)).toEqual([
			"environment",
		]);
		expect(await store.list(OTHER)).toEqual([]);
		expect(
			await refusal(store.update(DEFAULT, "zenrows", { enabled: false })),
		).toMatchObject({ status: 409 });
		expect(await refusal(store.remove(DEFAULT, "zenrows"))).toMatchObject({
			status: 409,
		});
	});

	it("starts the default workspace's ladder with its environment connections", async () => {
		const store = await make();
		expect((await store.policy(DEFAULT)).ladder).toEqual([
			{ kind: "direct" },
			{ kind: "proxy", connection: "zenrows", level: "auto" },
		]);
		expect((await store.policy(OTHER)).ladder).toEqual([{ kind: "direct" }]);
	});

	it("refuses connections that are incomplete or duplicated", async () => {
		const store = await make();
		const base = {
			name: "cf",
			kind: "cloudflare-browser" as const,
			apiKey: "t",
		};
		expect(await refusal(store.create(OTHER, base))).toMatchObject({
			status: 400,
			message: expect.stringContaining("account ID"),
		});
		expect(
			await refusal(
				store.create(OTHER, { ...base, accountId: ACCOUNT, country: "us" }),
			),
		).toMatchObject({ status: 400 });
		await store.create(OTHER, { ...base, accountId: ACCOUNT });
		expect(
			await refusal(store.create(OTHER, { ...base, accountId: ACCOUNT })),
		).toMatchObject({ status: 409 });
		expect(
			await refusal(
				store.create(OTHER, { name: "bd", kind: "brightdata", apiKey: "k" }),
			),
		).toMatchObject({ message: expect.stringContaining("zone") });
		expect(
			await refusal(
				store.create(OTHER, { name: "Bad Name", kind: "zenrows", apiKey: "k" }),
			),
		).toMatchObject({ status: 400 });
		expect(
			await refusal(
				store.create(OTHER, { name: "nokey", kind: "zenrows", apiKey: " " }),
			),
		).toMatchObject({ message: expect.stringContaining("API key") });
	});

	it("keeps the key unless a new one is sent, and a new key clears a problem", async () => {
		const store = await make();
		await store.create(OTHER, { name: "zr", kind: "zenrows", apiKey: "first" });
		await store.setProblem(OTHER, "zr", {
			kind: "key",
			detail: "ZenRows refused the key",
			at: new Date().toISOString(),
		});
		const capped = await store.update(OTHER, "zr", { monthlyRequestCap: 50 });
		expect(capped).toMatchObject({
			monthlyRequestCap: 50,
			problem: { kind: "key" },
		});
		expect((await store.connection(OTHER, "zr"))?.apiKey).toBe("first");
		const rekeyed = await store.update(OTHER, "zr", { apiKey: "second" });
		expect(rekeyed.problem).toBeNull();
		expect((await store.connection(OTHER, "zr"))?.apiKey).toBe("second");
	});

	it("takes a removed connection out of the ladder", async () => {
		const store = await make();
		await store.create(OTHER, { name: "zr", kind: "zenrows", apiKey: "k" });
		const policy = await store.policy(OTHER);
		await store.updatePolicy(OTHER, {
			...policy,
			ladder: [
				{ kind: "direct" },
				{ kind: "proxy", connection: "zr", level: "auto" },
			],
		});
		await store.remove(OTHER, "zr");
		expect((await store.policy(OTHER)).ladder).toEqual([{ kind: "direct" }]);
		expect(await store.list(OTHER)).toEqual([]);
	});

	it("refuses a policy saved on top of a newer one", async () => {
		const store = await make();
		const first = await store.policy(OTHER);
		const saved = await store.updatePolicy(OTHER, {
			...first,
			monthlyBudgetUsd: 10,
		});
		expect(saved.revision).toBe(first.revision + 1);
		expect(
			await refusal(
				store.updatePolicy(OTHER, { ...first, monthlyBudgetUsd: 5 }),
			),
		).toMatchObject({ status: 409 });
		expect((await store.policy(OTHER)).monthlyBudgetUsd).toBe(10);
	});

	it("holds requests against the budget, the caller, and the connection", async () => {
		const store = await make();
		const connection: ProxyConfig = {
			name: "zr",
			kind: "zenrows",
			apiKey: "k",
			enabled: true,
			monthlyRequestCap: 3,
		};
		const reserve = (callerId: string, maxCostUsd = 0.01) =>
			store.reserve(OTHER, {
				connection,
				callerId,
				callerCap: 2,
				budgetUsd: 0.03,
				maxCostUsd,
			});
		const one = await reserve("agent:a");
		const two = await reserve("agent:a");
		expect("refused" in one || "refused" in two).toBe(false);
		expect(await reserve("agent:a")).toEqual({ refused: "caller" });
		const three = await reserve("agent:b");
		expect("refused" in three).toBe(false);
		// The budget is held at the most each call can cost.
		expect(await reserve("agent:c")).toEqual({ refused: "budget" });
		// A call that was not billed gives everything back.
		if ("refused" in one) throw new Error("unreachable");
		await store.settle(one, { billed: false, costUsd: 0 });
		const four = await reserve("agent:a", 0.001);
		expect("refused" in four).toBe(false);
		// The connection's cap: three are held.
		expect(await reserve("agent:d", 0.001)).toEqual({ refused: "connection" });
		// Settling at the real cost frees the rest of the budget.
		if ("refused" in two || "refused" in three) throw new Error("unreachable");
		await store.settle(two, { billed: true, costUsd: 0.005 });
		await store.settle(three, { billed: true, costUsd: 0.001 });
		const policy = await store.policy(OTHER);
		const budget = await store.budget(OTHER, {
			...policy,
			monthlyBudgetUsd: 0.03,
		});
		// Two finished at their real cost, one is still held at its most.
		expect(budget.spentUsd).toBeCloseTo(0.007, 6);
	});

	it("never settles a charge above what was held against the budget", async () => {
		const store = await make();
		const connection: ProxyConfig = {
			name: "zr",
			kind: "zenrows",
			apiKey: "k",
			enabled: true,
			monthlyRequestCap: null,
		};
		const held = await store.reserve(OTHER, {
			connection,
			callerId: "agent:a",
			callerCap: 10,
			budgetUsd: 1,
			maxCostUsd: 0.025,
		});
		if ("refused" in held) throw new Error("unreachable");
		expect(await store.settle(held, { billed: true, costUsd: 5 })).toBe(true);
		const policy = await store.policy(OTHER);
		expect((await store.budget(OTHER, policy)).spentUsd).toBe(0.025);
	});

	it("never lets concurrent calls take more than the cap", async () => {
		const store = await make();
		const connection: ProxyConfig = {
			name: "zr",
			kind: "zenrows",
			apiKey: "k",
			enabled: true,
			monthlyRequestCap: null,
		};
		const results = await Promise.all(
			Array.from({ length: 20 }, () =>
				store.reserve(OTHER, {
					connection,
					callerId: "agent:a",
					callerCap: 5,
					budgetUsd: 100,
					maxCostUsd: 0.001,
				}),
			),
		);
		expect(results.filter((result) => !("refused" in result))).toHaveLength(5);
	});
});

describe("web policy validation", () => {
	const connections = new Map<string, ProxyConfig>([
		[
			"zr",
			{
				name: "zr",
				kind: "zenrows",
				apiKey: "k",
				enabled: true,
				monthlyRequestCap: null,
			},
		],
		[
			"cf",
			{
				name: "cf",
				kind: "cloudflare-browser",
				apiKey: "k",
				accountId: ACCOUNT,
				enabled: true,
				monthlyRequestCap: null,
			},
		],
	]);
	const base = { ...DEFAULT_WEB_POLICY, revision: 0 };
	const problem = (policy: Partial<WebPolicy>) => {
		try {
			validatePolicy({ ...base, ...policy }, connections);
			return null;
		} catch (error) {
			return (error as Error).message;
		}
	};

	it("accepts a ladder of known connections at their own levels", () => {
		expect(
			problem({
				ladder: [
					{ kind: "direct" },
					{ kind: "proxy", connection: "cf", level: "render" },
					{ kind: "proxy", connection: "zr", level: "auto" },
				],
			}),
		).toBeNull();
	});

	it("refuses unknown connections, wrong levels, and repeats", () => {
		expect(
			problem({
				ladder: [{ kind: "proxy", connection: "nope", level: "auto" }],
			}),
		).toContain("not a proxy");
		expect(
			problem({ ladder: [{ kind: "proxy", connection: "cf", level: "auto" }] }),
		).toContain("does not have");
		expect(
			problem({ ladder: [{ kind: "direct" }, { kind: "direct" }] }),
		).toContain("once");
	});

	it("checks hosts, limits, and the budget", () => {
		expect(
			problem({ domains: [{ match: "not a host", rule: "deny" }] }),
		).toContain("not a host");
		expect(
			problem({
				domains: [
					{ match: "example.com", rule: "deny" },
					{ match: "EXAMPLE.com", rule: "allow" },
				],
			}),
		).toContain("more than one");
		expect(problem({ callerProxyRequestsPerDay: -1 })).toContain(
			"whole number",
		);
		expect(problem({ monthlyBudgetUsd: Number.NaN })).toContain("budget");
	});

	it("matches the most specific domain rule", () => {
		const policy = {
			domains: [
				{ match: "example.com", rule: "start-at-proxy" as const },
				{ match: "docs.example.com", rule: "direct-only" as const },
			],
		};
		expect(domainRule(policy, "example.com")?.rule).toBe("start-at-proxy");
		expect(domainRule(policy, "www.example.com")?.rule).toBe("start-at-proxy");
		expect(domainRule(policy, "api.docs.example.com")?.rule).toBe(
			"direct-only",
		);
		expect(domainRule(policy, "notexample.com")).toBeUndefined();
	});
});
