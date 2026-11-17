import { randomUUID } from "node:crypto";
import type {
	AgentWakeActor,
	AgentWakeEvent,
	AgentWakeSpace,
	Channel,
	ChannelActor,
	ChannelMessage,
} from "@autonomo.us/common";
import type { ChannelChange } from "../channels/channels.js";
import type { SynapseChange } from "../synapse/synapse.js";
import type {
	AgentNoticeFor,
	AgentWebhooks,
	WebhookAgent,
} from "./webhooks.js";

export type AppEventsOptions = {
	webhooks: Pick<AgentWebhooks, "notify" | "broadcast">;
	/** An agent by id, or null when it is unknown or revoked. */
	agents: { find(agentId: string): Promise<WebhookAgent | null> };
	workspaces: { defaultWorkspaceId(): Promise<string> };
	now?: () => number;
};

/** What an agent's settings hold that an edit can change. */
export type AgentSettings = {
	name: string;
	description: string;
	permissions: readonly string[];
};
/** A person in a workspace, with their role there. */
export type WorkspacePerson = { id: string; name: string; role: string };

/** An event without its time, which `AppEvents` adds. */
type Timeless<T> = T extends unknown ? Omit<T, "at"> : never;
type Draft = Timeless<AgentWakeEvent>;

/** The default workspace's shared space; another's is `shared-<workspace id>`. */
const SHARED = "shared";
/** The grants an agent needs to read anything over MCP: list tools, and call one. */
const MCP_GRANTS = ["mcp:read", "mcp:call"];
const sameActor = (
	actor: { kind: string; id: string },
	agentId: string,
): boolean => actor.kind === "agent" && actor.id === agentId;

/**
 * Everything in the app that an agent's webhook can report, besides messages
 * and proposal decisions (see `AgentWebhooks`): each method takes what a
 * service says changed and tells the agents it concerns. An agent is never
 * told about its own doing. What happens in channels, Synapse, and the
 * workspace reaches only agents whose grants let them read it over MCP
 * (`readers`), so a webhook never tells an agent more than its credential
 * could; what happens to the agent itself reaches it whatever its grants.
 * Nothing here throws: the change it reports has already happened.
 */
export class AppEvents {
	private readonly now: () => number;
	constructor(private readonly options: AppEventsOptions) {
		this.now = options.now ?? Date.now;
	}
	private at() {
		return new Date(this.now()).toISOString();
	}
	/** An event that happens once: nothing reports it a second time. */
	private once(event: Draft, at = this.at()) {
		return {
			event: { ...event, at } as AgentWakeEvent,
			key: `${event.type}:${randomUUID()}`,
		};
	}
	/**
	 * `notice`, for the agents that can read what it reports: those holding
	 * the MCP grants and any `permission` the resource needs besides. An
	 * agent that cannot is not told, whatever its webhook chose.
	 */
	private readers(notice: AgentNoticeFor, permission?: string): AgentNoticeFor {
		return async (agentId) => {
			const grants =
				(await this.options.agents.find(agentId))?.permissions ?? [];
			return MCP_GRANTS.every((grant) => grants.includes(grant)) &&
				(permission === undefined || grants.includes(permission))
				? notice(agentId)
				: null;
		};
	}
	private async quietly(work: () => Promise<void>): Promise<void> {
		try {
			await work();
		} catch {
			// The change stands; a webhook that cannot hear of it must not undo it.
		}
	}

	// Channels.

	/**
	 * A message was edited or deleted. A person's or API token's change wakes
	 * the agents that can post in the channel, as a new message does. An edit
	 * that mentions an agent, and the deletion of an agent's own message, wake
	 * that agent whatever its access.
	 */
	onMessageChanged(
		channel: Channel,
		message: ChannelMessage,
		change: {
			kind: "edited" | "deleted";
			/** The number of the log entry that records the change. */
			seq: number;
			at: string;
			by: ChannelActor;
		},
	): Promise<void> {
		return this.quietly(async () => {
			const mentioned = new Set(
				message.mentions
					.filter((mention) => mention.kind === "agent")
					.map((mention) => mention.id),
			);
			const targets = channel.agents
				.filter((agent) => !sameActor(change.by, agent.agentTokenId))
				.filter(
					(agent) =>
						(change.by.kind !== "agent" && agent.access === "post") ||
						(change.kind === "edited" && mentioned.has(agent.agentTokenId)) ||
						(change.kind === "deleted" &&
							sameActor(message.author, agent.agentTokenId)),
				)
				.map((agent) => agent.agentTokenId);
			const about = {
				at: change.at,
				channelId: channel.id,
				channel: channel.name,
				messageId: message.id,
				seq: message.seq,
				threadId: message.threadId,
				by: change.by,
			};
			await this.options.webhooks.notify(
				channel.workspaceId,
				targets,
				this.readers((agentId) => ({
					event:
						change.kind === "edited"
							? {
									...about,
									type: "channel.message_edited",
									mentioned: mentioned.has(agentId),
								}
							: {
									...about,
									type: "channel.message_deleted",
									own: sameActor(message.author, agentId),
								},
					key: `channel-change:${channel.id}:${change.seq}`,
				})),
			);
		});
	}

	/**
	 * A channel or its agent list changed. The agent added, changed, or
	 * removed hears of that; the agents in the channel hear of a new name,
	 * topic, or description and of archiving.
	 */
	onChannelChanged(channel: Channel, change: ChannelChange): Promise<void> {
		return this.quietly(async () => {
			const place = {
				at: change.at,
				channelId: channel.id,
				channel: channel.name,
				by: change.actor,
			};
			// A channel's revision moves with every change, so it names this one.
			const key = (type: string) =>
				`channel:${channel.id}:${change.revision}:${type}`;
			const { webhooks } = this.options;
			const target = change.agent;
			if (target) {
				if (sameActor(change.actor, target.id)) return;
				const { access, previousAccess } = target;
				const event: AgentWakeEvent | null =
					access && !previousAccess
						? { ...place, type: "channel.joined", access }
						: !access && previousAccess
							? { ...place, type: "channel.left" }
							: access && previousAccess && access !== previousAccess
								? {
										...place,
										type: "channel.access_changed",
										access,
										previousAccess,
									}
								: null;
				if (event)
					await webhooks.notify(
						channel.workspaceId,
						[target.id],
						this.readers(() => ({ event, key: key(event.type) })),
					);
				return;
			}
			const members = channel.agents
				.map((agent) => agent.agentTokenId)
				.filter((id) => !sameActor(change.actor, id));
			if (change.lifecycle) {
				const type = `channel.${change.lifecycle}` as const;
				await webhooks.notify(
					channel.workspaceId,
					members,
					this.readers(() => ({ event: { ...place, type }, key: key(type) })),
				);
			}
			if (change.fields?.length)
				await webhooks.notify(
					channel.workspaceId,
					members,
					this.readers(() => ({
						event: {
							...place,
							type: "channel.updated",
							changes: change.fields ?? [],
							previousName: change.previousName ?? null,
						},
						key: key("channel.updated"),
					})),
				);
		});
	}

	// Synapse.

	/**
	 * A note was written or deleted, or notes were imported. A change in a
	 * workspace's shared space wakes that workspace's agents, one in the
	 * global space wakes every workspace's, and one in an agent's own space
	 * wakes that agent, unless it made the change itself.
	 */
	onSynapseChanged(change: SynapseChange): Promise<void> {
		return this.quietly(async () => {
			const { webhooks } = this.options;
			const draft = (space: AgentWakeSpace): Draft =>
				change.kind === "imported"
					? {
							type: "synapse.imported",
							space,
							created: change.created,
							updated: change.updated,
							by: change.actor,
						}
					: {
							type: `synapse.note_${change.kind}`,
							space,
							title: change.note.title,
							previousTitle: change.previousTitle,
							by: change.actor,
						};
			const notice = (space: AgentWakeSpace) =>
				this.readers((agentId) =>
					sameActor(change.actor, agentId)
						? null
						: {
								event: { ...draft(space), at: change.at } as AgentWakeEvent,
								key:
									change.kind === "imported"
										? `import:${change.space}:${randomUUID()}`
										: `note:${change.note.id}:${change.note.revision}:${change.kind}`,
							},
				);
			if (change.space === "global")
				return webhooks.broadcast(null, "shared-notes", notice("global"));
			if (change.space.startsWith("agent-")) {
				const agentId = change.space.slice("agent-".length);
				if (sameActor(change.actor, agentId)) return;
				// A bot the gateway runs has a space too, and no webhook.
				const agent = await this.options.agents.find(agentId);
				if (!agent) return;
				return webhooks.notify(
					agent.workspaceId ??
						(await this.options.workspaces.defaultWorkspaceId()),
					[agentId],
					notice("agent"),
				);
			}
			return webhooks.broadcast(
				change.space === SHARED
					? await this.options.workspaces.defaultWorkspaceId()
					: change.space.slice(`${SHARED}-`.length),
				"shared-notes",
				notice("shared"),
			);
		});
	}

	// The agent itself.

	/** A workspace admin saved the agent's name, description, or grants. */
	onAgentUpdated(
		workspaceId: string,
		agentId: string,
		before: AgentSettings,
		after: AgentSettings,
		by: AgentWakeActor,
	): Promise<void> {
		return this.quietly(async () => {
			const changes: Array<"name" | "description"> = [];
			if (before.name !== after.name) changes.push("name");
			if (before.description !== after.description) changes.push("description");
			const added = after.permissions.filter(
				(id) => !before.permissions.includes(id),
			);
			const removed = before.permissions.filter(
				(id) => !after.permissions.includes(id),
			);
			const notify = (event: Draft) =>
				this.options.webhooks.notify(workspaceId, [agentId], () =>
					this.once(event),
				);
			if (changes.length)
				await notify({
					type: "agent.updated",
					changes,
					previousName: changes.includes("name") ? before.name : null,
					by,
				});
			if (added.length || removed.length)
				await notify({ type: "agent.permissions_changed", added, removed, by });
		});
	}

	/** The agent's token was rolled: whatever holds the old one must change it. */
	onAgentTokenRolled(
		workspaceId: string,
		agentId: string,
		previousValidUntil: string,
		by: AgentWakeActor,
	): Promise<void> {
		return this.quietly(() =>
			this.options.webhooks.notify(workspaceId, [agentId], () =>
				this.once({ type: "agent.token_rolled", previousValidUntil, by }),
			),
		);
	}

	/** An app signed in to the agent with OAuth, or was disconnected. */
	onAgentApp(
		workspaceId: string,
		agentId: string,
		change:
			| { kind: "connected"; app: string; approvedBy: string | null }
			| {
					kind: "disconnected";
					app: string;
					reason: string;
					by: string | null;
			  },
	): Promise<void> {
		return this.quietly(() =>
			this.options.webhooks.notify(workspaceId, [agentId], () =>
				this.once(
					change.kind === "connected"
						? {
								type: "agent.app_connected",
								app: change.app,
								approvedBy: change.approvedBy,
							}
						: {
								type: "agent.app_disconnected",
								app: change.app,
								reason: change.reason,
								by: change.by,
							},
				),
			),
		);
	}

	// The workspace.

	/** Tells every agent of the workspace that chose `group`, once each. */
	private toWorkspace(
		workspaceId: string,
		group: "workspace" | "models" | "web",
		event: Draft,
		/** Only agents that hold this grant too can use what changed. */
		permission?: string,
	): Promise<void> {
		const at = this.at();
		return this.quietly(() =>
			this.options.webhooks.broadcast(
				workspaceId,
				group,
				this.readers(() => this.once(event, at), permission),
			),
		);
	}

	/** The workspace was renamed or described anew. */
	onWorkspaceUpdated(
		workspaceId: string,
		before: { name: string; description: string },
		after: { name: string; description: string },
		by: AgentWakeActor,
	): Promise<void> {
		const changes: Array<"name" | "description"> = [];
		if (before.name !== after.name) changes.push("name");
		if (before.description !== after.description) changes.push("description");
		if (!changes.length) return Promise.resolve();
		return this.toWorkspace(workspaceId, "workspace", {
			type: "workspace.updated",
			changes,
			name: after.name,
			previousName: changes.includes("name") ? before.name : null,
			by,
		});
	}

	/**
	 * The people of a workspace before and after a change to its members:
	 * whoever came, went, or changed role is reported.
	 */
	async onWorkspaceMembersChanged(
		workspaceId: string,
		before: readonly WorkspacePerson[],
		after: readonly WorkspacePerson[],
		by: AgentWakeActor,
	): Promise<void> {
		const was = new Map(before.map((person) => [person.id, person]));
		const is = new Map(after.map((person) => [person.id, person]));
		const events: Draft[] = [];
		for (const person of after) {
			const member = { id: person.id, name: person.name };
			const earlier = was.get(person.id);
			if (!earlier)
				events.push({
					type: "workspace.member_added",
					member,
					role: person.role,
					by,
				});
			else if (earlier.role !== person.role)
				events.push({
					type: "workspace.member_changed",
					member,
					role: person.role,
					previousRole: earlier.role,
					by,
				});
		}
		for (const person of before)
			if (!is.has(person.id))
				events.push({
					type: "workspace.member_removed",
					member: { id: person.id, name: person.name },
					role: person.role,
					by,
				});
		for (const event of events)
			await this.toWorkspace(workspaceId, "workspace", event);
	}

	/** The workspace's models, routing, or failover changed. */
	onModelsChanged(
		workspaceId: string,
		change: "models" | "routing" | "failover",
		by: AgentWakeActor,
	): Promise<void> {
		return this.toWorkspace(
			workspaceId,
			"models",
			{ type: "models.changed", change, by },
			"models:chat",
		);
	}

	/** The workspace's web policy or proxies changed. */
	onWebChanged(
		workspaceId: string,
		change: "policy" | "proxies",
		by: AgentWakeActor,
	): Promise<void> {
		return this.toWorkspace(
			workspaceId,
			"web",
			{ type: "web.changed", change, by },
			"web:fetch",
		);
	}
}
