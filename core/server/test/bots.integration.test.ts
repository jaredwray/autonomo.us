import type { BotDetails, ChannelMessage } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { runId, type StoredRun } from "../src/bots/repository.js";
import { GATEWAY_COLLECTIONS } from "../src/gateway-data.js";
import { sweepBackgroundWork } from "../src/server.js";
import { startChannels } from "./channel-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";
import { startOpenAIStub } from "./openai-stub.js";

const available = await mongoAvailable();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

describe.skipIf(!available)("bots with MongoDB", () => {
	it("hands a reply interrupted by shutdown to another server", async () => {
		const url = uniqueMongoUrl("botstop");
		const client = new MongoClient(url);
		cleanups.push(async () => {
			await client.db().dropDatabase();
			await client.close();
		});
		const models: Array<string | undefined> = [];
		const stub = await startOpenAIStub({
			onRequest: (body) => models.push(body.model),
		});
		cleanups.push(stub.close);
		const config = {
			mongodbUrl: url,
			providers: [
				{
					name: "stub",
					kind: "openai-compatible" as const,
					baseURL: stub.url,
					// slow-model stalls 1.5 s before answering.
					models: ["slow-model"],
				},
			],
		};
		const one = await startChannels(cleanups, config);
		const two = await startChannels(cleanups, config);
		const channel = await one.createChannel("general");
		const bot = await one.ok<BotDetails>(
			"POST",
			"/v1/bots",
			{ body: { name: "Slow", instructions: "", model: "stub/slow-model" } },
			201,
		);
		await one.addAgent(channel.id, bot.id);
		const asked = await one.post(channel.id, `<@agent:${bot.id}> hello?`);
		// The first server stops while its reply waits on the model.
		while (!models.length)
			await new Promise((resolve) => setTimeout(resolve, 20));
		await one.server.close();
		const runs = client.db().collection("channel_bot_runs");
		expect(await runs.findOne()).toMatchObject({
			status: "running",
			attempts: 1,
			replyMessageId: null,
		});

		// The second server's sweep takes the run over and answers once.
		await sweepBackgroundWork(two.server);
		const replies = (
			await two.read(channel.id, `?after=${asked.seq}`)
		).entries.filter((entry) => entry.type === "message");
		expect(replies).toMatchObject([
			{ author: { id: bot.id }, body: "Slow reply" },
		]);
		expect(await runs.findOne()).toMatchObject({
			status: "succeeded",
			attempts: 2,
		});
		expect(models).toHaveLength(2);
	}, 30_000);

	it("finishes interrupted runs once, across servers, and gives up on repeated crashes", async () => {
		const url = uniqueMongoUrl("bots");
		const client = new MongoClient(url);
		cleanups.push(async () => {
			await client.db().dropDatabase();
			await client.close();
		});
		let calls = 0;
		const stub = await startOpenAIStub({ onRequest: () => calls++ });
		cleanups.push(stub.close);
		const config = {
			mongodbUrl: url,
			providers: [
				{
					name: "stub",
					kind: "openai-compatible" as const,
					baseURL: stub.url,
					models: ["chat-model"],
				},
			],
		};
		const one = await startChannels(cleanups, config);
		const two = await startChannels(cleanups, config);
		const channel = await one.createChannel("general");
		const bot = await one.ok<BotDetails>(
			"POST",
			"/v1/bots",
			{ body: { name: "Helper", instructions: "", model: "stub/chat-model" } },
			201,
		);
		// The bot is added after these messages, so none of them started a run:
		// the runs below are written the way a process that died left them.
		const first = await one.post(channel.id, "first question");
		const second = await one.post(channel.id, "second question");
		const third = await one.post(channel.id, "third question");
		await one.addAgent(channel.id, bot.id);
		const runs = client
			.db()
			.collection<Omit<StoredRun, "id"> & { _id: string }>("channel_bot_runs");
		const left = (
			message: ChannelMessage,
			extra: Partial<StoredRun>,
		): Omit<StoredRun, "id"> & { _id: string } => ({
			_id: runId(bot.id, channel.id, message.seq),
			botId: bot.id,
			workspaceId: one.workspaceId,
			channelId: channel.id,
			triggerSeq: message.seq,
			triggerMessageId: message.id,
			depth: 0,
			status: "pending",
			attempts: 0,
			createdAt: new Date(Date.now() - 60_000).toISOString(),
			startedAt: null,
			finishedAt: null,
			detail: null,
			model: null,
			usage: null,
			replyMessageId: null,
			leaseId: null,
			leaseUntil: null,
			...extra,
		});
		const past = new Date(Date.now() - 1000).toISOString();
		const future = new Date(Date.now() + 60_000).toISOString();
		await runs.insertMany([
			// Written, never started: the process died right after the post.
			left(first, {}),
			// Started twice and interrupted both times.
			left(second, {
				status: "running",
				attempts: 2,
				leaseId: "dead",
				leaseUntil: past,
			}),
			// Another runner is working on it right now.
			left(third, {
				status: "running",
				attempts: 1,
				leaseId: "live",
				leaseUntil: future,
			}),
		]);

		// Both servers sweep at once; the pending run is answered exactly once.
		await Promise.all([
			sweepBackgroundWork(one.server),
			sweepBackgroundWork(two.server),
		]);
		expect(calls).toBe(1);
		const replies = (
			await one.read(channel.id, `?after=${third.seq}`)
		).entries.filter((entry) => entry.type === "message");
		expect(replies).toMatchObject([
			{ author: { kind: "agent", id: bot.id }, body: "Hello there" },
		]);
		const stored = await runs.find().sort({ triggerSeq: 1 }).toArray();
		expect(stored).toMatchObject([
			{ status: "succeeded", attempts: 1, leaseId: null },
			{
				status: "failed",
				detail: "Gave up after 2 interrupted attempts.",
			},
			{ status: "running", attempts: 1, leaseId: "live" },
		]);
		// A second sweep finds nothing left to do.
		await sweepBackgroundWork(two.server);
		expect(calls).toBe(1);

		for (const name of ["gateway_bots", "channel_bot_runs"])
			expect(GATEWAY_COLLECTIONS).toContain(name);
	});
});
