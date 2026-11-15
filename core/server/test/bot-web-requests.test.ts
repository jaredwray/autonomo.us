import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { BotWebRequestStore } from "../src/bots/web-requests.js";
import { controlPlaneConnection } from "../src/mongo.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
const mongoUrl = uniqueMongoUrl("botweb");
const cleanup = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
afterAll(async () => {
	if (available) await cleanup.db().dropDatabase();
	await cleanup.close();
});

const implementations: Array<[string, () => BotWebRequestStore]> = [
	["memory", () => new BotWebRequestStore()],
	...(available
		? ([
				[
					"mongodb",
					() => new BotWebRequestStore(controlPlaneConnection(mongoUrl)),
				],
			] as Array<[string, () => BotWebRequestStore]>)
		: []),
];

describe.each(implementations)("bot site requests (%s)", (_name, create) => {
	const store = create();
	afterAll(() => store.close());

	it("lists every bot's waiting requests in a workspace, oldest first", async () => {
		const workspaceId = randomUUID();
		const [reader, writer] = [randomUUID(), randomUUID()];
		const ask = (botId: string, host: string, workspace = workspaceId) =>
			store.record({
				workspaceId: workspace,
				botId,
				host,
				url: `https://${host}/`,
				channelId: null,
			});
		await ask(reader, "example.com");
		await ask(writer, "news.test");
		await ask(reader, "example.com");
		await ask(randomUUID(), "other.test", randomUUID());
		const pending = await store.pending(workspaceId);
		expect(pending.map((item) => [item.host, item.count])).toEqual([
			["example.com", 2],
			["news.test", 1],
		]);
		await store.decide(
			workspaceId,
			writer,
			pending[1].id,
			false,
			"Founder",
			async () => {},
		);
		expect((await store.pending(workspaceId)).map((item) => item.host)).toEqual(
			["example.com"],
		);
	});
});
