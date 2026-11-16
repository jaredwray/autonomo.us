import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import {
	type EventRepository,
	MemoryEventRepository,
	MongoEventRepository,
	mutate,
	type Subscription,
} from "../src/mcp-events/repository.js";
import { controlPlaneConnection } from "../src/mongo.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
const url = uniqueMongoUrl("mcpevents");
const mongo = controlPlaneConnection(url);
it("keeps the integration database name within MongoDB's 63-byte limit", () => {
	const name = decodeURIComponent(new URL(url).pathname.slice(1));
	expect(Buffer.byteLength(name, "utf8")).toBeLessThanOrEqual(63);
});
afterAll(async () => {
	await mongo.close();
	if (available) {
		const cleanup = new MongoClient(url);
		try {
			await cleanup.db().dropDatabase();
		} finally {
			await cleanup.close();
		}
	}
});
function row(): Subscription {
	return {
		id: randomUUID(),
		workspaceId: randomUUID(),
		agentId: randomUUID(),
		arguments: { channel_id: "channel" },
		name: "channel.message",
		url: "https://receiver.example.com/",
		secret: "not-a-real-credential",
		expiresAt: Date.now() + 86400000,
		verifiedUntil: Date.now() + 300000,
		active: true,
		queue: [],
		seen: [],
		leaseId: null,
		leaseUntil: 0,
		version: 0,
	};
}
for (const kind of ["memory", "mongodb"] as const) {
	describe.skipIf(kind === "mongodb" && !available)(
		`${kind} MCP event repository`,
		() => {
			const repository: EventRepository =
				kind === "memory"
					? new MemoryEventRepository()
					: new MongoEventRepository(mongo);
			it("keeps unique subscription identities, scoped channel lookup and compare-and-set", async () => {
				const value = row();
				expect(await repository.insert(value)).toBe(true);
				expect(await repository.insert(value)).toBe(false);
				expect(await repository.get(value.id)).toEqual(value);
				expect(
					await repository.channel(value.workspaceId, "channel"),
				).toHaveLength(1);
				expect(
					await repository.channel("other-workspace", "channel"),
				).toHaveLength(0);
				expect(await repository.replace({ ...value, version: 1 }, 0)).toBe(
					true,
				);
				expect(await repository.replace({ ...value, version: 1 }, 0)).toBe(
					false,
				);
				await Promise.all([
					mutate(repository, value.id, (x) => ({
						...x,
						seen: [...x.seen, "first"],
					})),
					mutate(repository, value.id, (x) => ({
						...x,
						seen: [...x.seen, "second"],
					})),
				]);
				expect((await repository.get(value.id))?.seen.sort()).toEqual([
					"first",
					"second",
				]);
			});
			it("recovers durable due work after reopening without stealing a live lease", async () => {
				const value = row();
				value.queue = [
					{
						attempts: 1,
						dueAt: 100,
						event: {
							eventId: "event",
							name: value.name,
							timestamp: new Date().toISOString(),
							cursor: null,
							data: {
								channel_id: "channel",
								message_id: "message",
								seq: 1,
								thread_id: null,
								author: { id: "user", kind: "user", name: "Person" },
							},
						},
					},
				];
				value.leaseUntil = 200;
				await repository.insert(value);
				const reopened =
					kind === "mongodb" ? new MongoEventRepository(mongo) : repository;
				expect((await reopened.due(199)).some((x) => x.id === value.id)).toBe(
					false,
				);
				expect(
					(await reopened.due(200)).find((x) => x.id === value.id),
				).toEqual(value);
				if (kind === "mongodb") {
					await mongo.close();
					expect(await reopened.get(value.id)).toEqual(value);
				}
			});
		},
	);
}
