import type {
	BotDetails,
	ChannelMessage,
	CreateBotRequest,
	WorkspaceOverview,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";
import { startOpenAIStub } from "./openai-stub.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

/** A gateway whose default workspace has one connection to a stub provider. */
async function start() {
	const stub = await startOpenAIStub();
	cleanups.push(stub.close);
	const api = await startChannels(cleanups, {
		providers: [
			{
				name: "stub",
				kind: "openai-compatible",
				baseURL: stub.url,
				models: ["chat-model", "broken-model"],
			},
		],
	});
	const bot = (input: Partial<CreateBotRequest> & { name: string }) =>
		api.ok<BotDetails>(
			"POST",
			"/v1/bots",
			{
				body: {
					instructions: "Answer briefly.",
					model: "stub/chat-model",
					...input,
				},
			},
			201,
		);
	/** Waits for the next message in a channel after `seq`. */
	const next = async (channel: string, seq: number) => {
		for (let cursor = seq; ; ) {
			const page = await api.read(channel, `?after=${cursor}&wait=10`);
			const message = page.entries.find(
				(entry): entry is ChannelMessage => entry.type === "message",
			);
			if (message) return message;
			if (page.cursor === cursor) throw new Error("No reply arrived.");
			cursor = page.cursor;
		}
	};
	const overview = (token?: string, query = "") =>
		api.ok<WorkspaceOverview>("GET", `/v1/overview${query}`, { token });
	return { ...api, bot, next, overview };
}

describe("workspace overview", () => {
	it("starts empty, healthy, and tells an owner what they may do", async () => {
		const { overview } = await start();
		const empty = await overview();
		expect(empty).toMatchObject({
			can: {
				decideProposals: true,
				manageAgents: true,
				editProxies: true,
				manageTokens: true,
				manageTeam: true,
			},
			waiting: {
				proposals: 0,
				siteRequests: [],
				proxyProblems: [],
				expiringAgents: [],
				botsAtLimit: [],
				mentions: [],
				invites: 0,
				expiringApiTokens: [],
			},
			budget: { spentUsd: 0, limitUsd: 25 },
			agents: [],
			runs: { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 },
			failedRuns: [],
			recentNotes: [],
			recentDecisions: [],
			health: {
				persistence: "memory",
				telemetry: "none",
				webAvailable: true,
			},
		});
		expect(empty.budget.month).toMatch(/^\d{4}-\d{2}$/);
	});

	it("gathers bots, their limits, replies, and failures", async () => {
		const { createChannel, post, addAgent, bot, next, overview } =
			await start();
		const channel = await createChannel("general");
		const hourly = await bot({ name: "Hourly", limits: { repliesPerHour: 1 } });
		const daily = await bot({ name: "Daily", limits: { tokensPerDay: 10 } });
		const broken = await bot({ name: "Broken", model: "stub/broken-model" });
		const paused = await bot({ name: "Paused", enabled: false });
		for (const agent of [hourly, daily, broken, paused])
			await addAgent(channel.id, agent.id);
		for (const agent of [hourly, daily, broken]) {
			const asked = await post(channel.id, `<@agent:${agent.id}> hello?`);
			await next(channel.id, asked.seq);
		}

		const seen = await overview();
		expect(seen.runs).toMatchObject({ succeeded: 2, failed: 1 });
		expect(seen.failedRuns).toEqual([
			expect.objectContaining({
				botId: broken.id,
				name: "Broken",
				channelId: channel.id,
				detail: expect.stringContaining("provider exploded"),
			}),
		]);
		expect(seen.waiting.botsAtLimit).toEqual([
			{ id: daily.id, name: "Daily", limit: "tokens" },
			{ id: hourly.id, name: "Hourly", limit: "replies" },
		]);
		expect(seen.agents.map((agent) => [agent.name, agent.status])).toEqual([
			["Broken", "active"],
			["Daily", "active"],
			["Hourly", "active"],
			["Paused", "paused"],
		]);
		expect(seen.agents.find((agent) => agent.id === hourly.id)).toMatchObject({
			kind: "instructions",
			model: "stub/chat-model",
			replying: false,
			replies: { used: 1, limit: 1 },
			tokens: { used: 15, limit: 500_000 },
			expiresAt: null,
		});
		// A window before any of it counts no replies, but still lists failures.
		const earlier = await overview(
			undefined,
			`?from=2026-01-01T00:00:00.000Z&to=2026-01-02T00:00:00.000Z`,
		);
		expect(earlier.runs.succeeded).toBe(0);
		expect(earlier.failedRuns).toHaveLength(1);
	});

	it("shows proposals, notes, expiring agents, and the person's mentions", async () => {
		const {
			agent,
			tool,
			createChannel,
			post,
			join,
			owner,
			ok,
			overview,
			apiToken,
		} = await start();
		// Agent tokens made by the helper last 7 days, so they are expiring.
		const alice = await agent("Alice");
		await tool(alice.secret, "synapse_propose", {
			action: "create",
			title: "Tone checklist",
			body: "Short sentences.",
			reason: "Agents keep asking.",
		});
		const second = await tool<{ id: string }>(alice.secret, "synapse_propose", {
			action: "create",
			title: "Brand voice",
			body: "Warm and plain.",
			reason: "We need a canon.",
		});
		await ok("POST", `/v1/synapse/proposals/${second.data.id}/decide`, {
			body: { decision: "approve" },
		});
		await apiToken(["models:read"]);
		const channel = await createChannel("general");
		const member = await join("member@example.com");
		await post(channel.id, `<@user:${owner.user.id}> look at this`, {
			token: member.token,
		});

		const seen = await overview();
		expect(seen.waiting.proposals).toBe(1);
		expect(seen.recentDecisions).toEqual([
			expect.objectContaining({
				id: second.data.id,
				title: "Brand voice",
				status: "approved",
				author: "Alice",
				decidedBy: "Founder",
			}),
		]);
		expect(seen.recentNotes).toEqual([
			expect.objectContaining({ title: "Brand voice", global: false }),
		]);
		expect(seen.waiting.expiringAgents).toEqual([
			expect.objectContaining({ id: alice.id, name: "Alice" }),
		]);
		expect(seen.waiting.expiringApiTokens).toHaveLength(1);
		expect(seen.waiting.mentions).toEqual([
			{ channelId: channel.id, name: "general", count: 1 },
		]);
		expect(seen.agents).toEqual([
			expect.objectContaining({
				id: alice.id,
				kind: "token",
				status: "active",
				replies: null,
				tokens: null,
				expiresAt: expect.any(String),
			}),
		]);

		// A member sees what is waiting, but not the org's tokens or invites.
		const theirs = await overview(member.token);
		expect(theirs.can).toEqual({
			decideProposals: false,
			manageAgents: false,
			editProxies: false,
			manageTokens: false,
			manageTeam: false,
		});
		expect(theirs.waiting).toMatchObject({
			proposals: 1,
			mentions: [],
			invites: null,
			expiringApiTokens: null,
		});
	});

	it("is for signed-in members and checks its window", async () => {
		const { apiToken, refused } = await start();
		const token = await apiToken(["telemetry:read", "models:read"]);
		expect((await refused("GET", "/v1/overview", { token })).status).toBe(403);
		expect(
			await refused(
				"GET",
				"/v1/overview?from=2026-01-02T00:00:00.000Z&to=2026-01-01T00:00:00.000Z",
			),
		).toEqual({
			status: 400,
			message: "Choose a valid time range of up to 90 days.",
		});
		expect(
			(
				await refused(
					"GET",
					"/v1/overview?from=2026-01-01T00:00:00.000Z&to=2026-06-01T00:00:00.000Z",
				)
			).status,
		).toBe(400);
	});
});
