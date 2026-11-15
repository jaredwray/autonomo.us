import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
	type AgentWebhookRepository,
	MemoryAgentWebhookRepository,
	MongoAgentWebhookRepository,
	mutateWebhook,
	type StoredAgentWebhook,
} from "../src/agent-webhooks/repository.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn(
		"[agent-webhooks-repository] no MongoDB — skipping the MongoDB half.",
	);
const mongoUrl = uniqueMongoUrl("webhookrepo");
const cleanup = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
afterAll(async () => {
	if (available) await cleanup.db().dropDatabase();
	await cleanup.close();
});

const T0 = "2026-11-15T10:00:00.000Z";
const T1 = "2026-11-15T10:01:00.000Z";
const T2 = "2026-11-15T10:02:00.000Z";

function webhook(
	workspaceId: string,
	extra: Partial<StoredAgentWebhook> = {},
): StoredAgentWebhook {
	return {
		agentId: randomUUID(),
		workspaceId,
		url: "https://hooks.example.com/agent",
		secret: "whsec_c2VjcmV0",
		authKey: null,
		headers: [],
		events: ["mentions", "messages", "proposals"],
		status: "active",
		disabledReason: null,
		consecutiveFailures: 0,
		lastDeliveryAt: null,
		lastFailureAt: null,
		lastError: null,
		createdAt: T0,
		createdBy: "Founder",
		updatedAt: T0,
		queue: [],
		omitted: 0,
		delivery: null,
		dueAt: null,
		leaseId: null,
		leaseUntil: null,
		recentKeys: [],
		version: 1,
		...extra,
	};
}

const contracts: Array<[string, () => AgentWebhookRepository]> = [
	["memory", () => new MemoryAgentWebhookRepository()],
];
if (available)
	contracts.push(["mongodb", () => new MongoAgentWebhookRepository(mongoUrl)]);

describe.each(contracts)("%s agent webhook repository", (_name, make) => {
	it("keeps one webhook per agent, inside its workspace", async () => {
		const repository = make();
		const workspace = randomUUID();
		const stored = webhook(workspace);
		expect(await repository.insert(stored)).toBe(true);
		expect(
			await repository.insert({ ...stored, url: "https://x.example/2" }),
		).toBe(false);
		expect(await repository.get(workspace, stored.agentId)).toEqual(stored);
		expect(await repository.get(randomUUID(), stored.agentId)).toBeNull();
		expect(await repository.delete(randomUUID(), stored.agentId)).toBe(false);
		expect(await repository.delete(workspace, stored.agentId)).toBe(true);
		expect(await repository.get(workspace, stored.agentId)).toBeNull();
		await repository.close();
	});

	it("replaces only the version it read", async () => {
		const repository = make();
		const workspace = randomUUID();
		const stored = webhook(workspace);
		await repository.insert(stored);
		const next = {
			...stored,
			url: "https://hooks.example.com/new",
			version: 2,
		};
		expect(await repository.replace(next, 1)).toBe(true);
		// A writer that read version 1 loses.
		expect(await repository.replace({ ...stored, version: 2 }, 1)).toBe(false);
		expect(
			await repository.replace(
				{ ...next, workspaceId: randomUUID(), version: 3 },
				2,
			),
		).toBe(false);
		expect(await repository.get(workspace, stored.agentId)).toMatchObject({
			url: "https://hooks.example.com/new",
			version: 2,
		});

		// mutateWebhook retries from a fresh read when someone wrote in between.
		let calls = 0;
		const result = await mutateWebhook(
			repository,
			workspace,
			stored.agentId,
			(current) => {
				calls++;
				return { ...current, lastError: `try ${calls}` };
			},
			// A stale copy, as if read before the replace above.
			stored,
		);
		expect(calls).toBe(2);
		expect(result).toMatchObject({ lastError: "try 2", version: 3 });
		expect(
			await mutateWebhook(repository, workspace, stored.agentId, () => null),
		).toBeNull();
		expect(
			await mutateWebhook(repository, workspace, randomUUID(), (c) => c),
		).toBeNull();
		await repository.close();
	});

	it("finds active webhooks by agent and those with a POST due", async () => {
		const repository = make();
		const workspace = randomUUID();
		const due = webhook(workspace, { dueAt: T0 });
		const later = webhook(workspace, { dueAt: T2 });
		const paused = webhook(workspace, { status: "paused", dueAt: T0 });
		const idle = webhook(workspace);
		const elsewhere = webhook(randomUUID(), { dueAt: T0 });
		for (const item of [due, later, paused, idle, elsewhere])
			await repository.insert(item);

		const active = await repository.active(workspace, [
			due.agentId,
			paused.agentId,
			idle.agentId,
			elsewhere.agentId,
		]);
		expect(active.map((item) => item.agentId).sort()).toEqual(
			[due.agentId, idle.agentId].sort(),
		);
		expect(await repository.active(workspace, [])).toEqual([]);

		const found = (await repository.due(T1, 50)).map((item) => item.agentId);
		expect(found).toContain(due.agentId);
		expect(found).toContain(elsewhere.agentId);
		expect(found).not.toContain(later.agentId);
		expect(found).not.toContain(paused.agentId);
		expect(found).not.toContain(idle.agentId);
		expect(await repository.due(T1, 1)).toHaveLength(1);
		await repository.close();
	});
});
