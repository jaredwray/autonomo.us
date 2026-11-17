import { randomUUID } from "node:crypto";
import type {
	AgentWakeEvent,
	AgentWakePayload,
	AgentWebhookEventGroup,
	Channel,
	ChannelActor,
	ChannelAgentAccess,
	ChannelMessage,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { AppEvents } from "../src/agent-webhooks/app-events.js";
import type { WebhookRequest } from "../src/agent-webhooks/delivery.js";
import { MemoryAgentWebhookRepository } from "../src/agent-webhooks/repository.js";
import {
	AgentWebhooks,
	type WebhookAgent,
} from "../src/agent-webhooks/webhooks.js";

const WORKSPACE = randomUUID();
const OTHER_WORKSPACE = randomUUID();
const AT = "2026-11-15T10:00:00.000Z";
const jared: ChannelActor = { kind: "user", id: "u1", name: "Jared" };

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
	for (const close of closers.splice(0)) await close();
});

/** Webhooks in memory, the events of the app, and what each agent was sent. */
function setUp() {
	const sent: WebhookRequest[] = [];
	const agents = new Map<string, WebhookAgent>();
	const repository = new MemoryAgentWebhookRepository();
	const find = async (id: string) => agents.get(id) ?? null;
	const webhooks = new AgentWebhooks({
		repository,
		agents: { find },
		workspaces: {
			get: async () => ({ archivedAt: null }),
			defaultWorkspaceId: async () => WORKSPACE,
		},
		threadAuthor: async () => null,
		transport: Object.assign(
			async (request: WebhookRequest) => {
				sent.push(request);
				return { status: 200, retryAfter: null };
			},
			{ pinsAddress: false as const },
		),
		timing: { gapMs: 5 },
		timeoutMs: 200,
	});
	closers.push(() => webhooks.close());
	const events = new AppEvents({
		webhooks,
		agents: { find },
		workspaces: { defaultWorkspaceId: async () => WORKSPACE },
		now: () => Date.parse(AT),
	});
	/** An agent with a webhook that chose `groups`. */
	const agent = async (
		groups: AgentWebhookEventGroup[],
		{
			workspaceId = WORKSPACE,
			permissions = ["mcp:read", "mcp:call"],
		}: { workspaceId?: string; permissions?: string[] } = {},
	) => {
		const id = randomUUID();
		agents.set(id, {
			name: `Agent ${agents.size + 1}`,
			workspaceId,
			status: "active",
			permissions,
		});
		await webhooks.create(
			workspaceId,
			id,
			{ url: `https://hooks.example.com/${id}`, events: groups },
			"Founder",
		);
		return id;
	};
	/** Every event sent to an agent so far, once nothing is waiting. */
	const heard = async (agentId: string): Promise<AgentWakeEvent[]> => {
		await webhooks.idle();
		return sent
			.filter((request) => request.url.pathname === `/${agentId}`)
			.flatMap(
				(request) => (JSON.parse(request.body) as AgentWakePayload).data.events,
			);
	};
	const types = async (agentId: string) =>
		(await heard(agentId)).map((event) => event.type);
	return { events, agent, heard, types, webhooks, repository };
}

function channel(
	members: Array<[string, ChannelAgentAccess]>,
	workspaceId = WORKSPACE,
): Channel {
	return {
		id: "c1",
		workspaceId,
		name: "film-qc",
		topic: "",
		description: "",
		agents: members.map(([agentTokenId, access]) => ({
			agentTokenId,
			name: "Agent",
			access,
			addedAt: AT,
			addedBy: "Jared",
		})),
		createdAt: AT,
		createdBy: jared,
		updatedAt: AT,
		archivedAt: null,
		revision: 4,
	};
}
const agentActor = (id: string): ChannelActor => ({
	kind: "agent",
	id,
	name: "Agent",
});
const message = (extra: Partial<ChannelMessage> = {}): ChannelMessage => ({
	id: "m7",
	channelId: "c1",
	seq: 7,
	type: "message",
	createdAt: AT,
	author: jared,
	body: "",
	mentions: [],
	threadId: null,
	replyCount: 0,
	editedAt: null,
	deletedAt: null,
	...extra,
});

describe("channel events", () => {
	it("tells an agent it was added, changed, or removed, unless it did so itself", async () => {
		const { events, agent, heard, types } = setUp();
		const scout = await agent(["membership"]);
		const deaf = await agent(["mentions"]);
		const change = (
			id: string,
			access: ChannelAgentAccess | null,
			previousAccess: ChannelAgentAccess | null,
			revision: number,
			actor: ChannelActor = jared,
		) =>
			events.onChannelChanged(channel(access ? [[id, access]] : []), {
				action: "agent-changed",
				actor,
				at: AT,
				revision,
				agent: { id, access, previousAccess },
			});
		await change(scout, "read", null, 2);
		await change(scout, "post", "read", 3);
		// A name that changed with the same access is no news to the agent.
		await change(scout, "post", "post", 4);
		await change(scout, null, "post", 5);
		await change(deaf, "post", null, 6);
		expect(await heard(scout)).toEqual([
			{
				type: "channel.joined",
				at: AT,
				channelId: "c1",
				channel: "film-qc",
				access: "read",
				by: jared,
			},
			expect.objectContaining({
				type: "channel.access_changed",
				access: "post",
				previousAccess: "read",
			}),
			expect.objectContaining({ type: "channel.left" }),
		]);
		expect(await heard(deaf)).toEqual([]);

		// An agent with channels:manage that adds itself already knows.
		const manager = await agent(["membership"]);
		await change(manager, "post", null, 7, agentActor(manager));
		expect(await types(manager)).toEqual([]);
	});

	it("tells a channel's agents when it is renamed or archived", async () => {
		const { events, agent, heard, types } = setUp();
		const scout = await agent(["channels"]);
		const quill = await agent(["channels"]);
		const outsider = await agent(["channels"]);
		const room = channel([
			[scout, "read"],
			[quill, "post"],
		]);
		// One change that both unarchives and renames reports each.
		await events.onChannelChanged(room, {
			action: "updated",
			actor: agentActor(quill),
			at: AT,
			revision: 5,
			lifecycle: "unarchived",
			fields: ["name", "topic"],
			previousName: "qc",
		});
		expect(await heard(scout)).toEqual([
			expect.objectContaining({
				type: "channel.unarchived",
				channel: "film-qc",
			}),
			expect.objectContaining({
				type: "channel.updated",
				changes: ["name", "topic"],
				previousName: "qc",
				by: agentActor(quill),
			}),
		]);
		// Not the agent that made the change, nor one outside the channel.
		expect(await types(quill)).toEqual([]);
		expect(await types(outsider)).toEqual([]);

		// The same change reported twice is sent once.
		const archived = {
			action: "archived" as const,
			actor: jared,
			at: AT,
			revision: 6,
			lifecycle: "archived" as const,
			fields: [],
		};
		await events.onChannelChanged(room, archived);
		await events.onChannelChanged(room, archived);
		expect(await types(quill)).toEqual(["channel.archived"]);
	});

	it("reports an edit or deletion to those who can post, are mentioned, or wrote it", async () => {
		const { events, agent, heard, types } = setUp();
		const poster = await agent(["message-changes"]);
		const reader = await agent(["message-changes"]);
		const mentioned = await agent(["message-changes"]);
		const room = channel([
			[poster, "post"],
			[reader, "read"],
			[mentioned, "read"],
		]);
		const edit = { kind: "edited" as const, seq: 9, at: AT, by: jared };
		await events.onMessageChanged(
			room,
			message({ mentions: [{ kind: "agent", id: mentioned }] }),
			edit,
		);
		expect(await heard(poster)).toEqual([
			{
				type: "channel.message_edited",
				at: AT,
				channelId: "c1",
				channel: "film-qc",
				messageId: "m7",
				seq: 7,
				threadId: null,
				by: jared,
				mentioned: false,
			},
		]);
		expect(await heard(mentioned)).toEqual([
			expect.objectContaining({ mentioned: true }),
		]);
		expect(await types(reader)).toEqual([]);

		// A workspace admin deletes what the reader wrote: the reader hears.
		await events.onMessageChanged(
			room,
			message({ author: agentActor(reader), deletedAt: AT }),
			{ kind: "deleted", seq: 10, at: AT, by: jared },
		);
		expect(await heard(reader)).toEqual([
			expect.objectContaining({ type: "channel.message_deleted", own: true }),
		]);
		expect((await heard(poster)).at(-1)).toMatchObject({
			type: "channel.message_deleted",
			own: false,
		});

		// An agent's own edit wakes nobody but an agent it mentions.
		await events.onMessageChanged(
			room,
			message({
				author: agentActor(poster),
				mentions: [{ kind: "agent", id: reader }],
			}),
			{ kind: "edited", seq: 11, at: AT, by: agentActor(poster) },
		);
		expect(await types(poster)).toHaveLength(2);
		expect(await types(mentioned)).toHaveLength(1);
		expect((await heard(reader)).at(-1)).toMatchObject({
			type: "channel.message_edited",
			mentioned: true,
		});
	});
});

describe("Synapse events", () => {
	const note = { id: "n1", title: "Ada Lovelace", revision: 2 };

	it("tells a workspace's agents about its shared space, and everyone about global", async () => {
		const { events, agent, heard, types } = setUp();
		const scout = await agent(["shared-notes"]);
		const own = await agent(["own-notes"]);
		const abroad = await agent(["shared-notes"], {
			workspaceId: OTHER_WORKSPACE,
		});
		const actor = { kind: "user" as const, id: "u1", name: "Jared" };
		// The default workspace's shared space is stored as `shared`.
		await events.onSynapseChanged({
			space: "shared",
			actor,
			at: AT,
			kind: "updated",
			note,
			previousTitle: "Ada",
		});
		await events.onSynapseChanged({
			space: `shared-${OTHER_WORKSPACE}`,
			actor,
			at: AT,
			kind: "deleted",
			note,
			previousTitle: null,
		});
		await events.onSynapseChanged({
			space: "global",
			actor,
			at: AT,
			kind: "imported",
			created: 12,
			updated: 3,
		});
		expect(await heard(scout)).toEqual([
			{
				type: "synapse.note_updated",
				at: AT,
				space: "shared",
				title: "Ada Lovelace",
				previousTitle: "Ada",
				by: actor,
			},
			{
				type: "synapse.imported",
				at: AT,
				space: "global",
				created: 12,
				updated: 3,
				by: actor,
			},
		]);
		expect(await types(abroad)).toEqual([
			"synapse.note_deleted",
			"synapse.imported",
		]);
		expect(await types(own)).toEqual([]);
	});

	it("tells an agent when someone else writes in its own space", async () => {
		const { events, agent, heard, types } = setUp();
		const scout = await agent(["own-notes"]);
		const shared = await agent(["shared-notes"]);
		const write = (agentId: string, actor: ChannelActor, revision: number) =>
			events.onSynapseChanged({
				space: `agent-${agentId}`,
				actor,
				at: AT,
				kind: "created",
				note: { ...note, revision },
				previousTitle: null,
			});
		// What the agent writes itself is no news to it.
		await write(scout, { kind: "agent", id: scout, name: "Scout" }, 1);
		await write(scout, jared, 2);
		await write(shared, jared, 3);
		// A space with no agent behind it, such as a bot's, wakes nobody.
		await write(randomUUID(), jared, 4);
		expect(await heard(scout)).toEqual([
			expect.objectContaining({
				type: "synapse.note_created",
				space: "agent",
				by: jared,
			}),
		]);
		expect(await types(shared)).toEqual([]);
	});
});

describe("agent and workspace events", () => {
	const by = { kind: "user" as const, id: "u1", name: "Jared" };

	it("tells an agent what changed in its settings", async () => {
		const { events, agent, heard } = setUp();
		const scout = await agent(["agent", "connections"]);
		const before = {
			name: "Scout",
			description: "",
			permissions: ["mcp:read", "web:fetch"],
		};
		await events.onAgentUpdated(WORKSPACE, scout, before, before, by);
		await events.onAgentUpdated(
			WORKSPACE,
			scout,
			before,
			{
				name: "Scout 2",
				description: "",
				permissions: ["mcp:read", "models:chat"],
			},
			by,
		);
		await events.onAgentTokenRolled(WORKSPACE, scout, AT, by);
		await events.onAgentApp(WORKSPACE, scout, {
			kind: "connected",
			app: "Claude",
			approvedBy: "Jared",
		});
		await events.onAgentApp(WORKSPACE, scout, {
			kind: "disconnected",
			app: "Claude",
			reason: "The app signed out.",
			by: null,
		});
		expect(await heard(scout)).toEqual([
			{
				type: "agent.updated",
				at: AT,
				changes: ["name"],
				previousName: "Scout",
				by,
			},
			{
				type: "agent.permissions_changed",
				at: AT,
				added: ["models:chat"],
				removed: ["web:fetch"],
				by,
			},
			{ type: "agent.token_rolled", at: AT, previousValidUntil: AT, by },
			{
				type: "agent.app_connected",
				at: AT,
				app: "Claude",
				approvedBy: "Jared",
			},
			{
				type: "agent.app_disconnected",
				at: AT,
				app: "Claude",
				reason: "The app signed out.",
				by: null,
			},
		]);
	});

	it("tells a workspace's agents about its name and its people", async () => {
		const { events, agent, heard, types } = setUp();
		const scout = await agent(["workspace"]);
		const abroad = await agent(["workspace"], {
			workspaceId: OTHER_WORKSPACE,
		});
		const same = { name: "Default", description: "" };
		await events.onWorkspaceUpdated(WORKSPACE, same, same, by);
		await events.onWorkspaceUpdated(
			WORKSPACE,
			same,
			{ name: "Studio", description: "Film." },
			by,
		);
		await events.onWorkspaceMembersChanged(
			WORKSPACE,
			[
				{ id: "u1", name: "Jared", role: "admin" },
				{ id: "u2", name: "Ada", role: "member" },
				{ id: "u3", name: "Grace", role: "member" },
			],
			[
				{ id: "u1", name: "Jared", role: "admin" },
				{ id: "u2", name: "Ada", role: "admin" },
				{ id: "u4", name: "Linus", role: "member" },
			],
			by,
		);
		expect(await heard(scout)).toEqual([
			{
				type: "workspace.updated",
				at: AT,
				changes: ["name", "description"],
				name: "Studio",
				previousName: "Default",
				by,
			},
			{
				type: "workspace.member_changed",
				at: AT,
				member: { id: "u2", name: "Ada" },
				role: "admin",
				previousRole: "member",
				by,
			},
			{
				type: "workspace.member_added",
				at: AT,
				member: { id: "u4", name: "Linus" },
				role: "member",
				by,
			},
			{
				type: "workspace.member_removed",
				at: AT,
				member: { id: "u3", name: "Grace" },
				role: "member",
				by,
			},
		]);
		expect(await types(abroad)).toEqual([]);
	});

	it("tells only agents that hold the grant about models and web access", async () => {
		const { events, agent, types } = setUp();
		const chats = await agent(["models", "web"], {
			permissions: ["mcp:read", "mcp:call", "models:chat"],
		});
		const fetches = await agent(["models", "web"], {
			permissions: ["mcp:read", "mcp:call", "web:fetch"],
		});
		await events.onModelsChanged(WORKSPACE, "routing", by);
		await events.onWebChanged(WORKSPACE, "proxies", by);
		expect(await types(chats)).toEqual(["models.changed"]);
		expect(await types(fetches)).toEqual(["web.changed"]);
	});

	it("tells an agent that cannot read over MCP only about itself", async () => {
		const { events, agent, types } = setUp();
		const everything: AgentWebhookEventGroup[] = [
			"message-changes",
			"membership",
			"channels",
			"shared-notes",
			"own-notes",
			"agent",
			"workspace",
			"web",
		];
		// A new agent holds no grants; one with only a feature grant, or only
		// one of the MCP grants, can read nothing over MCP either.
		const blind = await agent(everything, { permissions: [] });
		const partial = await agent(everything, {
			permissions: ["mcp:read", "web:fetch"],
		});
		const room = channel([
			[blind, "post"],
			[partial, "post"],
		]);
		await events.onMessageChanged(room, message(), {
			kind: "edited",
			seq: 9,
			at: AT,
			by: jared,
		});
		await events.onChannelChanged(room, {
			action: "agent-added",
			actor: jared,
			at: AT,
			revision: 5,
			agent: { id: blind, access: "post", previousAccess: null },
		});
		await events.onChannelChanged(room, {
			action: "archived",
			actor: jared,
			at: AT,
			revision: 6,
			lifecycle: "archived",
		});
		for (const space of ["shared", "global", `agent-${blind}`] as const)
			await events.onSynapseChanged({
				space,
				actor: by,
				at: AT,
				kind: "created",
				note: { id: `n-${space}`, title: "Ada Lovelace", revision: 1 },
				previousTitle: null,
			});
		await events.onWorkspaceUpdated(
			WORKSPACE,
			{ name: "Default", description: "" },
			{ name: "Studio", description: "" },
			by,
		);
		await events.onWebChanged(WORKSPACE, "policy", by);
		// What happens to the agent itself is not the app's content.
		await events.onAgentUpdated(
			WORKSPACE,
			blind,
			{ name: "Scout", description: "", permissions: [] },
			{ name: "Scout", description: "", permissions: ["mcp:read"] },
			by,
		);
		expect(await types(blind)).toEqual(["agent.permissions_changed"]);
		expect(await types(partial)).toEqual([]);
	});

	it("never fails the change it reports", async () => {
		const failing = {
			notify: async () => {
				throw new Error("storage is down");
			},
			broadcast: async () => {
				throw new Error("storage is down");
			},
		};
		const events = new AppEvents({
			webhooks: failing,
			agents: { find: async () => null },
			workspaces: { defaultWorkspaceId: async () => WORKSPACE },
		});
		await expect(
			events.onModelsChanged(WORKSPACE, "models", by),
		).resolves.toBeUndefined();
		await expect(
			events.onAgentTokenRolled(WORKSPACE, randomUUID(), AT, by),
		).resolves.toBeUndefined();
		await expect(
			events.onChannelChanged(channel([[randomUUID(), "post"]]), {
				action: "archived",
				actor: jared,
				at: AT,
				revision: 2,
				lifecycle: "archived",
			}),
		).resolves.toBeUndefined();
	});

	it("keeps one agent's failure from the others", async () => {
		const logged: string[] = [];
		const repository = new MemoryAgentWebhookRepository();
		const webhooks = new AgentWebhooks({
			repository,
			agents: { find: async () => null },
			workspaces: {
				get: async () => ({ archivedAt: null }),
				defaultWorkspaceId: async () => WORKSPACE,
			},
			threadAuthor: async () => null,
			transport: Object.assign(
				async () => ({ status: 200, retryAfter: null }),
				{ pinsAddress: false as const },
			),
			// Long enough that nothing is sent before the test reads the queue.
			timing: { gapMs: 60_000 },
			maxTimerMs: 0,
			log: (text) => logged.push(text),
		});
		closers.push(() => webhooks.close());
		const [first, second] = [randomUUID(), randomUUID()];
		for (const id of [first, second])
			await webhooks.create(
				WORKSPACE,
				id,
				{ url: "https://hooks.example.com/x", events: ["workspace"] },
				"Founder",
			);
		const event: AgentWakeEvent = {
			type: "workspace.updated",
			at: AT,
			changes: ["name"],
			name: "Studio",
			previousName: "Default",
			by,
		};
		await webhooks.broadcast(WORKSPACE, "workspace", (agentId) => {
			if (agentId === first) throw new Error("no such agent");
			return { event, key: "k1" };
		});
		expect((await repository.get(WORKSPACE, first))?.queue).toEqual([]);
		expect((await repository.get(WORKSPACE, second))?.queue).toEqual([event]);
		expect(logged).toEqual(["An agent webhook event could not be queued."]);
		// An agent named twice is told once.
		await webhooks.notify(WORKSPACE, [second, second], () => ({
			event,
			key: "k2",
		}));
		expect((await repository.get(WORKSPACE, second))?.queue).toHaveLength(2);
	});
});
