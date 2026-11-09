import { describe, expect, it } from "vitest";
import { ROUTE_RULES } from "../src/auth/access.js";
import type { ApiConfig } from "../src/config.js";
import {
	ProviderRegistry,
	providerFromConfig,
} from "../src/providers/registry.js";
import { ProviderSettingsStore } from "../src/providers/settings.js";
import { ModelRouter } from "../src/routing/router.js";
import {
	defaultRoutingConfig,
	RoutingSettingsStore,
} from "../src/routing/settings.js";
import { createServer } from "../src/server.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { WorkspaceStore } from "../src/workspaces/store.js";

const A = { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", isDefault: false };
const B = { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", isDefault: false };
const config: ApiConfig = { providers: [], corsOrigins: [] };
const policy = { enabled: false, targets: [], timeoutMs: 30_000 };

function registry() {
	return new ProviderRegistry().register(
		providerFromConfig({
			kind: "openai-compatible",
			name: "p",
			baseURL: "http://127.0.0.1:1/v1",
			models: ["m1", "m2"],
		}),
	);
}

describe("route scopes", () => {
	it("refuses a route that names a workspace without workspace scope", async () => {
		const server = createServer({ config, logger: false });
		ROUTE_RULES.set("GET /v1/:workspace/leak", { scope: "instance" });
		try {
			expect(() => server.get("/v1/:workspace/leak", () => ({}))).toThrow(
				/names a workspace, so its scope must be "workspace"/,
			);
		} finally {
			ROUTE_RULES.delete("GET /v1/:workspace/leak");
			await server.close();
		}
	});
});

describe("workspace stores (memory mode)", () => {
	it("creates one default workspace with a generated UUID and refuses to archive it", async () => {
		const store = new WorkspaceStore();
		const id = await store.defaultWorkspaceId();
		expect(id).toMatch(/^[0-9a-f-]{36}$/);
		expect(await store.defaultWorkspaceId()).toBe(id);
		const created = await store.create({ name: " Hyphen " }, "Founder");
		expect(created).toMatchObject({ name: "Hyphen", isDefault: false });
		expect((await store.list()).map((item) => item.id)).toEqual([
			id,
			created.id,
		]);
		await expect(store.setArchived(id, true, "Founder")).rejects.toMatchObject({
			statusCode: 409,
		});
		const archived = await store.setArchived(created.id, true, "Founder");
		expect(archived.archivedAt).not.toBeNull();
		expect(
			(await store.actions(created.id)).map((action) => action.action),
		).toEqual(["archived", "created"]);
	});

	it("keeps balancing state separate per workspace", async () => {
		const router = new ModelRouter(new TelemetryService());
		const pools = [
			{
				id: "shared",
				strategy: "least-requests" as const,
				failover: false,
				members: [
					{ model: "p/m1", weight: 1 },
					{ model: "p/m2", weight: 1 },
				],
			},
		];
		const routing = { ...defaultRoutingConfig(policy), pools };
		const plan = (workspaceId: string) =>
			router.plan(
				{ workspaceId, registry: registry(), config: routing },
				{ model: "pool/shared", messages: [] },
			);
		// Two long-running requests on p/m1 in workspace A...
		const busy = [router.acquire(A.id, "p/m1"), router.acquire(A.id, "p/m1")];
		// ...leave A preferring m2, while B, with no traffic of its own, starts at m1.
		expect((await plan(A.id)).candidates[0].id).toBe("p/m2");
		expect((await plan(B.id)).candidates[0].id).toBe("p/m1");
		for (const release of busy) release();
	});

	it("returns 409 when a full routing replacement loses a race, but merges failover patches", async () => {
		const store = new RoutingSettingsStore(policy);
		const config = defaultRoutingConfig(policy);
		const results = await Promise.allSettled([
			store.update(A, { ...config, rules: [] }, registry()),
			store.update(A, config, registry()),
		]);
		expect(results.map((result) => result.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		expect(
			(
				results.find((result) => result.status === "rejected") as {
					reason: { statusCode: number };
				}
			).reason.statusCode,
		).toBe(409);
		await Promise.all([
			store.updateFailover(A, { enabled: true }),
			store.updateFailover(A, { timeoutMs: 1234 }),
		]);
		expect((await store.config(A)).failover).toMatchObject({
			enabled: true,
			timeoutMs: 1234,
		});
		// B never saw A's changes.
		expect((await store.config(B)).failover).toEqual(policy);
	});

	it("keeps memory-mode settings per server and per workspace, and never writes into an injected registry", async () => {
		const injected = registry();
		const first = new ProviderSettingsStore(config, injected);
		const second = new ProviderSettingsStore(config, injected);
		const added = await first.add(A, {
			provider: "google",
			connectionId: "gemini",
			model: "gemini-test",
			apiKey: "test-key",
		});
		expect(added.id).toBe("gemini/gemini-test");
		const ids = async (store: ProviderSettingsStore, workspace = A) =>
			(await store.registry(workspace))
				.listModels()
				.map((model) => model.id)
				.sort();
		expect(await ids(first)).toEqual(["gemini/gemini-test"]);
		// Another server in the same process, and another workspace, see nothing.
		expect(await ids(second)).toEqual([]);
		expect(await ids(first, B)).toEqual([]);
		// The injected registry is the default workspace's overlay, untouched.
		expect(injected.listProviders().map((item) => item.name)).toEqual(["p"]);
		const defaults = {
			id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
			isDefault: true,
		};
		expect(await ids(first, defaults)).toEqual(["p/m1", "p/m2"]);
	});
});
