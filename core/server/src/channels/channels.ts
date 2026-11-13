import { randomUUID } from "node:crypto";
import {
	AGENT_TOKEN_PERMISSIONS,
	CHANNEL_LIMITS,
	CHANNEL_NAME_PATTERN,
	type Channel,
	type ChannelAction,
	type ChannelActor,
	type ChannelAgentAccess,
	type ChannelAgentOption,
	type ChannelChangeEntry,
	type ChannelDetails,
	type ChannelEntry,
	type ChannelEntryList,
	type ChannelList,
	type ChannelMember,
	type ChannelMembers,
	type ChannelMessage,
	type ChannelSummary,
	type CreateChannelRequest,
	channelMention,
	channelMentions,
	type PostChannelMessageRequest,
	type UpdateChannelRequest,
} from "@autonomo.us/common";
import { ChannelError } from "./errors.js";
import type {
	ChannelRepository,
	StoredChange,
	StoredChannel,
	StoredEntry,
	StoredMessage,
	StoredSystemEntry,
} from "./repository.js";

const NAME = new RegExp(CHANNEL_NAME_PATTERN);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ACTIONS = 100;
const MAX_NONCE_LENGTH = 100;
/** A writer that loses the race for a number takes the next one; see `append`. */
const MAX_APPEND_TRIES = 64;
const MAX_CHANGE_TRIES = 5;
const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Who is acting. People and API tokens see every channel in their workspace.
 * An agent sees the channels whose agent list holds it; `manage` is its
 * `channels:manage` grant, which lets it name any channel.
 */
export type ChannelCaller = {
	actor: ChannelActor;
	agent?: { manage: boolean };
	/** May delete anyone's message (workspace admins). */
	moderate?: boolean;
};

/** Who exists in a workspace, for agent lists and mentions. */
export type ChannelDirectory = {
	/** The workspace's agents: agent tokens and bots the gateway runs. */
	agents(workspaceId: string): Promise<ChannelAgentOption[]>;
	/** People with access to the workspace. */
	people(workspaceId: string): Promise<Array<{ id: string; name: string }>>;
};

export type ChannelServiceOptions = {
	directory: ChannelDirectory;
	now?: () => number;
	/** How often a long poll looks for something new. */
	pollIntervalMs?: number;
	/**
	 * Called after a message is appended, before the post returns. A failure
	 * here never fails the post.
	 */
	onMessage?: (channel: Channel, message: ChannelMessage) => unknown;
};

export type ReadOptions = {
	after?: number;
	before?: number;
	thread?: string;
	limit?: number;
	/** Follow from the caller's read mark when `after` is not given. */
	unread?: boolean;
	mentionsOnly?: boolean;
	/** Seconds to wait for something above `after`. */
	wait?: number;
	signal?: AbortSignal;
};

const keyOf = (actor: Pick<ChannelActor, "kind" | "id">) =>
	`${actor.kind}:${actor.id}`;
const notFound = () => new ChannelError("Channel not found.", 404);
const sleep = (ms: number, signal?: AbortSignal) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal?.removeEventListener("abort", done);
			resolve();
		}
		signal?.addEventListener("abort", done, { once: true });
	});

function publicChannel(stored: StoredChannel): Channel {
	const {
		nameKey: _nameKey,
		createdByKey: _createdByKey,
		lastSeq: _lastSeq,
		lastMessageSeq: _lastMessageSeq,
		lastMessageAt: _lastMessageAt,
		actions: _actions,
		...channel
	} = stored;
	return channel;
}

function publicMessage(stored: StoredMessage): ChannelMessage {
	return {
		id: stored.id,
		channelId: stored.channelId,
		seq: stored.seq,
		type: "message",
		createdAt: stored.createdAt,
		author: stored.author,
		body: stored.body,
		mentions: stored.mentions,
		threadId: stored.threadId,
		replyCount: stored.replyCount,
		editedAt: stored.editedAt,
		deletedAt: stored.deletedAt,
	};
}

/**
 * Channels of a workspace: rooms, their append-only logs, agent lists, and
 * read marks. Routes authorize people and API tokens by workspace action
 * before calling in; the checks an agent needs (is it in this channel, may it
 * post, does it hold the manage grant) are made here.
 */
export class ChannelService {
	private readonly now: () => number;
	private readonly pollIntervalMs: number;
	constructor(
		private readonly repository: ChannelRepository,
		private readonly options: ChannelServiceOptions,
	) {
		this.now = options.now ?? Date.now;
		this.pollIntervalMs = options.pollIntervalMs ?? 1000;
	}
	get persistence() {
		return this.repository.persistence;
	}
	private at(offsetMs = 0) {
		return new Date(this.now() + offsetMs).toISOString();
	}

	// Access

	private agentIn(channel: StoredChannel, caller: ChannelCaller) {
		return channel.agents.find(
			(agent) => agent.agentTokenId === caller.actor.id,
		);
	}
	/** Whether the caller may see this channel at all. */
	private sees(channel: StoredChannel, caller: ChannelCaller) {
		return (
			!caller.agent ||
			caller.agent.manage ||
			Boolean(this.agentIn(channel, caller))
		);
	}
	/** A channel by id or name. One the caller cannot see is not found. */
	private async resolve(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
	): Promise<StoredChannel> {
		const channel = UUID.test(reference)
			? await this.repository.getChannel(workspaceId, reference)
			: await this.repository.getChannelByName(
					workspaceId,
					reference.replace(/^#/, "").toLowerCase(),
				);
		if (!channel || !this.sees(channel, caller)) throw notFound();
		return channel;
	}
	private requireManage(caller: ChannelCaller) {
		if (caller.actor.kind === "api-token")
			throw new ChannelError("Sign in to the dashboard for this action.", 403);
		if (caller.agent && !caller.agent.manage)
			throw new ChannelError(
				`This agent token lacks the ${AGENT_TOKEN_PERMISSIONS["channels:manage"]} grant (channels:manage).`,
				403,
			);
	}
	private requireOpen(channel: StoredChannel) {
		if (channel.archivedAt)
			throw new ChannelError("This channel is archived.", 409);
	}

	// Channels

	private async summaries(
		channels: StoredChannel[],
		caller: ChannelCaller,
	): Promise<ChannelSummary[]> {
		if (!channels.length) return [];
		const reader = keyOf(caller.actor);
		const marks = await this.repository.readMarks(
			channels[0].workspaceId,
			reader,
		);
		return Promise.all(
			channels.map(async (channel) => {
				const readSeq = marks.get(channel.id) ?? 0;
				const unread = channel.lastMessageSeq > readSeq;
				return {
					...publicChannel(channel),
					lastMessageAt: channel.lastMessageAt,
					readSeq,
					unread,
					// API tokens cannot be mentioned.
					mentions:
						unread && caller.actor.kind !== "api-token"
							? await this.repository.countMentions(channel.id, reader, readSeq)
							: 0,
				};
			}),
		);
	}

	async listChannels(
		workspaceId: string,
		caller: ChannelCaller,
		options: { archived?: boolean; all?: boolean } = {},
	): Promise<ChannelList> {
		if (options.all) this.requireManage(caller);
		const channels = await this.repository.listChannels(workspaceId, {
			archived: options.archived ?? false,
			...(caller.agent && !options.all
				? { agentTokenId: caller.actor.id }
				: {}),
		});
		return {
			channels: await this.summaries(channels, caller),
			persistence: this.repository.persistence,
		};
	}

	async getChannel(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
	): Promise<ChannelDetails> {
		const channel = await this.resolve(workspaceId, caller, reference);
		const [summary] = await this.summaries([channel], caller);
		return { ...summary, actions: [...channel.actions].reverse() };
	}

	private validateText(input: { topic?: string; description?: string }): void {
		if (
			input.topic !== undefined &&
			input.topic.length > CHANNEL_LIMITS.topicLength
		)
			throw new ChannelError(
				`A topic is at most ${CHANNEL_LIMITS.topicLength} characters.`,
			);
		if (
			input.description !== undefined &&
			input.description.length > CHANNEL_LIMITS.descriptionLength
		)
			throw new ChannelError(
				`A description is at most ${CHANNEL_LIMITS.descriptionLength} characters.`,
			);
	}
	private validName(name: unknown): string {
		const value = typeof name === "string" ? name.replace(/^#/, "") : "";
		if (!NAME.test(value))
			throw new ChannelError(
				"A channel name is 1–80 lowercase letters, digits, hyphens, or underscores, starting with a letter or digit.",
			);
		return value;
	}
	private action(
		action: ChannelAction["action"],
		actor: ChannelActor,
		detail: string,
	): ChannelAction {
		return { id: randomUUID(), action, timestamp: this.at(), actor, detail };
	}

	async createChannel(
		workspaceId: string,
		caller: ChannelCaller,
		input: CreateChannelRequest,
	): Promise<ChannelDetails> {
		this.requireManage(caller);
		const name = this.validName(input.name);
		this.validateText(input);
		const createdByKey = keyOf(caller.actor);
		const [open, recent] = await Promise.all([
			this.repository.countOpenChannels(workspaceId),
			this.repository.countChannelsCreatedBy(
				workspaceId,
				createdByKey,
				this.at(-HOUR_MS),
			),
		]);
		if (open >= CHANNEL_LIMITS.openChannels)
			throw new ChannelError(
				`A workspace holds at most ${CHANNEL_LIMITS.openChannels} open channels. Archive one first.`,
			);
		if (recent >= CHANNEL_LIMITS.channelsPerHour)
			throw new ChannelError(
				`You can create ${CHANNEL_LIMITS.channelsPerHour} channels an hour. Try again later.`,
				429,
			);
		const at = this.at();
		const channel: StoredChannel = {
			id: randomUUID(),
			workspaceId,
			name,
			nameKey: name,
			topic: input.topic ?? "",
			description: input.description ?? "",
			// An agent that creates a channel is in it.
			agents: caller.agent
				? [
						{
							agentTokenId: caller.actor.id,
							name: caller.actor.name,
							access: "post",
							addedAt: at,
							addedBy: caller.actor.name,
						},
					]
				: [],
			createdAt: at,
			createdBy: caller.actor,
			createdByKey,
			updatedAt: at,
			archivedAt: null,
			revision: 1,
			lastSeq: 0,
			lastMessageSeq: 0,
			lastMessageAt: null,
			actions: [this.action("created", caller.actor, `Created #${name}.`)],
		};
		if (!(await this.repository.insertChannel(channel)))
			throw new ChannelError(`A channel named #${name} already exists.`, 409);
		await this.note(channel, caller.actor, "created this channel");
		return this.getChannel(workspaceId, caller, channel.id);
	}

	/**
	 * Applies `change` to a channel with compare-and-swap on its revision, so
	 * the change and its `actions` entry commit in one write. `change` returns
	 * the action and the system note to leave, or null when nothing changes.
	 */
	private async change(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		expectedRevision: number | undefined,
		change: (channel: StoredChannel) => Promise<{
			action: ChannelAction["action"];
			detail: string;
			note: string;
		} | null>,
	): Promise<ChannelDetails> {
		this.requireManage(caller);
		for (let attempt = 0; attempt < MAX_CHANGE_TRIES; attempt++) {
			const channel = await this.resolve(workspaceId, caller, reference);
			const stale = () =>
				new ChannelError(
					"This channel changed during your request. Refresh and try again.",
					409,
				);
			if (
				expectedRevision !== undefined &&
				channel.revision !== expectedRevision
			)
				throw stale();
			const revision = channel.revision;
			const applied = await change(channel);
			if (!applied) return this.getChannel(workspaceId, caller, channel.id);
			channel.revision = revision + 1;
			channel.updatedAt = this.at();
			channel.nameKey = channel.name;
			channel.actions = [
				...channel.actions,
				this.action(applied.action, caller.actor, applied.detail),
			].slice(-MAX_ACTIONS);
			const result = await this.repository.replaceChannel(channel, revision);
			if (result === "name-taken")
				throw new ChannelError(
					`A channel named #${channel.name} already exists.`,
					409,
				);
			if (result === "ok") {
				await this.note(channel, caller.actor, applied.note);
				return this.getChannel(workspaceId, caller, channel.id);
			}
			// Lost a race with another change. A caller that named a revision
			// is told; one that did not is retried on the new state.
			if (expectedRevision !== undefined) throw stale();
		}
		throw new ChannelError(
			"This channel is changing too quickly. Try again.",
			409,
		);
	}

	updateChannel(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		input: UpdateChannelRequest,
	): Promise<ChannelDetails> {
		const name =
			input.name === undefined ? undefined : this.validName(input.name);
		this.validateText(input);
		return this.change(
			workspaceId,
			caller,
			reference,
			input.revision,
			async (channel) => {
				this.requireOpen(channel);
				const notes: string[] = [];
				if (name !== undefined && name !== channel.name) {
					notes.push(`renamed the channel from #${channel.name} to #${name}`);
					channel.name = name;
				}
				if (input.topic !== undefined && input.topic !== channel.topic) {
					notes.push(
						input.topic ? `set the topic: ${input.topic}` : "cleared the topic",
					);
					channel.topic = input.topic;
				}
				if (
					input.description !== undefined &&
					input.description !== channel.description
				) {
					notes.push("changed the description");
					channel.description = input.description;
				}
				if (!notes.length) return null;
				const note = notes.join(" and ");
				return { action: "updated", detail: `${note}.`, note };
			},
		);
	}

	setArchived(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		archived: boolean,
	): Promise<ChannelDetails> {
		return this.change(
			workspaceId,
			caller,
			reference,
			undefined,
			async (channel) => {
				if (Boolean(channel.archivedAt) === archived) return null;
				if (
					!archived &&
					(await this.repository.countOpenChannels(workspaceId)) >=
						CHANNEL_LIMITS.openChannels
				)
					throw new ChannelError(
						`A workspace holds at most ${CHANNEL_LIMITS.openChannels} open channels. Archive one first.`,
					);
				channel.archivedAt = archived ? this.at() : null;
				const note = archived
					? "archived this channel"
					: "unarchived this channel";
				return {
					action: archived ? "archived" : "unarchived",
					detail: `${archived ? "Archived" : "Unarchived"} #${channel.name}.`,
					note,
				};
			},
		);
	}

	/** Adds an agent, changes its access, or removes it (`access` null). */
	async setAgent(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		agentReference: string,
		access: ChannelAgentAccess | null,
	): Promise<ChannelDetails> {
		this.requireManage(caller);
		// Only this workspace's agents can be in its channels.
		const option = (await this.options.directory.agents(workspaceId)).find(
			(agent) =>
				agent.agentTokenId === agentReference ||
				agent.name.toLowerCase() === agentReference.toLowerCase(),
		);
		return this.change(
			workspaceId,
			caller,
			reference,
			undefined,
			async (channel) => {
				this.requireOpen(channel);
				const index = channel.agents.findIndex(
					(agent) =>
						agent.agentTokenId === (option?.agentTokenId ?? agentReference),
				);
				const current = channel.agents[index];
				if (access === null) {
					// An agent whose token is gone can still be removed.
					if (!current) return null;
					channel.agents.splice(index, 1);
					return {
						action: "agent-removed",
						detail: `Removed ${current.name}.`,
						note: `removed ${current.name}`,
					};
				}
				if (!option)
					throw new ChannelError("No such agent in this workspace.", 404);
				if (current) {
					if (current.access === access && current.name === option.name)
						return null;
					const before = current.access;
					current.access = access;
					current.name = option.name;
					return {
						action: "agent-changed",
						detail: `Changed ${option.name} from ${before} to ${access}.`,
						note: `changed ${option.name}'s access to ${access}`,
					};
				}
				if (channel.agents.length >= CHANNEL_LIMITS.agentsPerChannel)
					throw new ChannelError(
						`A channel holds at most ${CHANNEL_LIMITS.agentsPerChannel} agents.`,
					);
				channel.agents.push({
					agentTokenId: option.agentTokenId,
					name: option.name,
					access,
					addedAt: this.at(),
					addedBy: caller.actor.name,
				});
				return {
					action: "agent-added",
					detail: `Added ${option.name} with ${access} access.`,
					note: `added ${option.name}`,
				};
			},
		);
	}

	/** The workspace's agents, for choosing one to add. */
	async agentOptions(
		workspaceId: string,
		caller: ChannelCaller,
	): Promise<{ agents: ChannelAgentOption[] }> {
		this.requireManage(caller);
		return { agents: await this.options.directory.agents(workspaceId) };
	}

	async members(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
	): Promise<ChannelMembers> {
		const channel = await this.resolve(workspaceId, caller, reference);
		const people = await this.options.directory.people(workspaceId);
		return {
			members: [
				...people.map(
					(person): ChannelMember => ({
						kind: "user",
						id: person.id,
						name: person.name,
						mention: channelMention("user", person.id),
					}),
				),
				...channel.agents.map(
					(agent): ChannelMember => ({
						kind: "agent",
						id: agent.agentTokenId,
						name: agent.name,
						mention: channelMention("agent", agent.agentTokenId),
						access: agent.access,
					}),
				),
			],
		};
	}

	// The log

	/**
	 * Appends an entry at the next number. The insert is the claim: a unique
	 * index on (channel, seq) lets one writer have each number. A writer that
	 * loses knows that number now exists, so it tries the one after. Entry
	 * n + 1 is therefore only ever written after entry n, and a reader
	 * following by cursor never has an entry appear behind it.
	 */
	private async append<T extends StoredEntry>(
		entry: Omit<T, "seq">,
	): Promise<{ entry: T; replay: boolean }> {
		let seq = (await this.repository.topSeq(entry.channelId)) + 1;
		for (let attempt = 0; attempt < MAX_APPEND_TRIES; attempt++) {
			const candidate = { ...entry, seq } as T;
			const result = await this.repository.insertEntry(candidate);
			if (result === "ok") return { entry: candidate, replay: false };
			if (result === "nonce-taken") {
				const first = await this.repository.findByNonce(
					entry.channelId,
					entry.authorKey,
					(entry as { nonce?: string }).nonce ?? "",
				);
				if (first) return { entry: first as T, replay: true };
			}
			seq += 1;
			// The memory log refuses any number but the next, so re-read there
			// and after a long run of losses.
			if (attempt % 8 === 7 || this.repository.persistence === "memory")
				seq = (await this.repository.topSeq(entry.channelId)) + 1;
		}
		throw new ChannelError("This channel is busy. Try again.", 503);
	}

	private base(channel: StoredChannel, author: ChannelActor) {
		return {
			id: randomUUID(),
			workspaceId: channel.workspaceId,
			channelId: channel.id,
			createdAt: this.at(),
			author,
			authorKey: keyOf(author),
		};
	}
	/** Leaves a system note in the log. Display only: the record is `actions`. */
	private async note(
		channel: StoredChannel,
		author: ChannelActor,
		text: string,
	) {
		const { entry } = await this.append<StoredSystemEntry>({
			...this.base(channel, author),
			type: "system",
			text,
		});
		await this.repository.touchChannel(channel.workspaceId, channel.id, {
			lastSeq: entry.seq,
		});
	}

	private async hydrate(
		channelId: string,
		stored: StoredEntry[],
	): Promise<ChannelEntry[]> {
		const targets = new Map<string, StoredEntry>();
		const changes = stored.filter(
			(entry): entry is StoredChange => entry.type === "change",
		);
		// A change entry stores a reference; the message is read now.
		for (const target of await this.repository.getEntries(channelId, [
			...new Set(changes.map((entry) => entry.targetId)),
		]))
			targets.set(target.id, target);
		return stored.flatMap((entry): ChannelEntry[] => {
			if (entry.type === "message") return [publicMessage(entry)];
			const shared = {
				id: entry.id,
				channelId: entry.channelId,
				seq: entry.seq,
				createdAt: entry.createdAt,
				author: entry.author,
			};
			if (entry.type === "system")
				return [{ ...shared, type: "system", text: entry.text }];
			const target = targets.get(entry.targetId);
			return target?.type === "message"
				? [
						{
							...shared,
							type: "change",
							change: entry.change,
							message: publicMessage(target),
						} satisfies ChannelChangeEntry,
					]
				: [];
		});
	}

	/** Mentions in `body`, refused when they name someone outside the channel. */
	private async mentionsIn(channel: StoredChannel, body: string) {
		const mentions = channelMentions(body);
		if (mentions.length > CHANNEL_LIMITS.mentionsPerMessage)
			throw new ChannelError(
				`A message mentions at most ${CHANNEL_LIMITS.mentionsPerMessage} people or agents.`,
			);
		if (mentions.some((mention) => mention.kind === "user")) {
			const people = new Set(
				(await this.options.directory.people(channel.workspaceId)).map(
					(person) => person.id,
				),
			);
			if (
				mentions.some(
					(mention) => mention.kind === "user" && !people.has(mention.id),
				)
			)
				throw new ChannelError(
					"This message mentions someone who is not in this workspace.",
				);
		}
		const agents = new Set(channel.agents.map((agent) => agent.agentTokenId));
		if (
			mentions.some(
				(mention) => mention.kind === "agent" && !agents.has(mention.id),
			)
		)
			throw new ChannelError(
				"This message mentions an agent that is not in this channel.",
			);
		return mentions;
	}
	private validBody(body: unknown): string {
		if (typeof body !== "string" || !body.trim())
			throw new ChannelError("A message needs some text.");
		if (body.length > CHANNEL_LIMITS.bodyLength)
			throw new ChannelError(
				`A message is at most ${CHANNEL_LIMITS.bodyLength} characters.`,
			);
		return body;
	}
	/** Refuses a caller that may read this channel but not write in it. */
	private requirePost(channel: StoredChannel, caller: ChannelCaller) {
		this.requireOpen(channel);
		if (caller.agent && this.agentIn(channel, caller)?.access !== "post")
			throw new ChannelError(
				"This agent can read this channel but not post in it.",
				403,
			);
	}

	async post(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		input: PostChannelMessageRequest,
	): Promise<{ message: ChannelMessage; created: boolean }> {
		const channel = await this.resolve(workspaceId, caller, reference);
		this.requirePost(channel, caller);
		const body = this.validBody(input.body);
		if (
			input.nonce !== undefined &&
			(typeof input.nonce !== "string" ||
				!input.nonce ||
				input.nonce.length > MAX_NONCE_LENGTH)
		)
			throw new ChannelError(`A nonce is 1–${MAX_NONCE_LENGTH} characters.`);
		const authorKey = keyOf(caller.actor);
		// A retry of a post that already landed returns it, even at the limit.
		if (input.nonce !== undefined) {
			const first = await this.repository.findByNonce(
				channel.id,
				authorKey,
				input.nonce,
			);
			if (first) return this.replayed(channel, first);
		}
		const mentions = await this.mentionsIn(channel, body);
		let threadId: string | null = null;
		if (input.threadId !== undefined) {
			const parent = await this.repository.getEntry(
				workspaceId,
				channel.id,
				input.threadId,
			);
			if (parent?.type !== "message")
				throw new ChannelError("The message to reply to was not found.", 404);
			// A reply to a reply joins the same thread.
			threadId = parent.threadId ?? parent.id;
		}
		const limit =
			caller.actor.kind === "user"
				? CHANNEL_LIMITS.personPostsPerMinute
				: CHANNEL_LIMITS.agentPostsPerMinute;
		if (
			(await this.repository.countAuthorMessages(
				channel.id,
				authorKey,
				this.at(-MINUTE_MS),
			)) >= limit
		)
			throw new ChannelError(
				`You can post ${limit} messages a minute in a channel. Slow down and try again.`,
				429,
			);
		const { entry, replay } = await this.append<StoredMessage>({
			...this.base(channel, caller.actor),
			type: "message",
			body,
			mentions,
			mentionKeys: mentions.map(keyOf),
			threadId,
			replyCount: 0,
			editedAt: null,
			deletedAt: null,
			revision: 1,
			...(input.nonce === undefined ? {} : { nonce: input.nonce }),
		});
		if (replay) return this.replayed(channel, entry);
		// The reply count follows the entry. A crash here leaves it one behind.
		if (threadId) await this.repository.addReply(channel.id, threadId);
		await this.settle(channel, entry);
		return { message: publicMessage(entry), created: true };
	}
	/**
	 * What follows a message once it is in the log: the channel's summary, the
	 * author's read mark, and whoever listens for messages. Each step can be
	 * repeated safely, so a retried post repairs any that a crash skipped.
	 */
	private async settle(channel: StoredChannel, entry: StoredMessage) {
		await Promise.all([
			this.repository.touchChannel(channel.workspaceId, channel.id, {
				lastSeq: entry.seq,
				lastMessageSeq: entry.seq,
				lastMessageAt: entry.createdAt,
			}),
			this.keepUp(channel.workspaceId, channel.id, entry.authorKey, entry.seq),
		]);
		try {
			await this.options.onMessage?.(
				publicChannel(channel),
				publicMessage(entry),
			);
		} catch {
			// The message is posted; whoever listens handles its own trouble.
		}
	}
	/** A retry of a post that already landed: the first message, settled again. */
	private async replayed(channel: StoredChannel, first: StoredMessage) {
		await this.settle(channel, first);
		return { message: publicMessage(first), created: false };
	}
	/**
	 * An author who had read every message before their own has read that too.
	 * An author with older unread messages keeps them unread, so posting never
	 * acknowledges something the author has not seen.
	 */
	private async keepUp(
		workspaceId: string,
		channelId: string,
		readerKey: string,
		seq: number,
	) {
		const mark = await this.repository.readMark(channelId, readerKey);
		const between = await this.repository.entriesAfter(channelId, mark, 20);
		const own = between.findIndex((entry) => entry.seq === seq);
		// System notes and change entries are not messages to read.
		if (
			own >= 0 &&
			between.slice(0, own).every((entry) => entry.type !== "message")
		)
			await this.repository.raiseReadMark(
				workspaceId,
				channelId,
				readerKey,
				seq,
				this.at(),
			);
	}

	private async message(
		channel: StoredChannel,
		messageId: string,
	): Promise<StoredMessage> {
		const entry = await this.repository.getEntry(
			channel.workspaceId,
			channel.id,
			messageId,
		);
		if (entry?.type !== "message")
			throw new ChannelError("Message not found.", 404);
		return entry;
	}
	/** Rewrites a message in place and tells followers it changed. */
	private async rewrite(
		channel: StoredChannel,
		caller: ChannelCaller,
		message: StoredMessage,
		change: StoredChange["change"],
	): Promise<ChannelMessage> {
		const revision = message.revision;
		message.revision = revision + 1;
		if (!(await this.repository.replaceMessage(message, revision)))
			throw new ChannelError(
				"This message changed during your request. Refresh and try again.",
				409,
			);
		const { entry } = await this.append<StoredChange>({
			...this.base(channel, caller.actor),
			type: "change",
			change,
			targetId: message.id,
		});
		await this.repository.touchChannel(channel.workspaceId, channel.id, {
			lastSeq: entry.seq,
		});
		return publicMessage(message);
	}

	async editMessage(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		messageId: string,
		input: { body: string },
	): Promise<ChannelMessage> {
		const channel = await this.resolve(workspaceId, caller, reference);
		this.requirePost(channel, caller);
		const body = this.validBody(input.body);
		const message = await this.message(channel, messageId);
		if (message.authorKey !== keyOf(caller.actor))
			throw new ChannelError("Only its author can edit a message.", 403);
		if (message.deletedAt)
			throw new ChannelError("This message was deleted.", 409);
		if (message.body === body) return publicMessage(message);
		const mentions = await this.mentionsIn(channel, body);
		// The earlier text is overwritten; nothing keeps a copy of it.
		message.body = body;
		message.mentions = mentions;
		message.mentionKeys = mentions.map(keyOf);
		message.editedAt = this.at();
		return this.rewrite(channel, caller, message, "edited");
	}

	async deleteMessage(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		messageId: string,
	): Promise<void> {
		// Allowed in an archived channel too: a pasted secret must be removable.
		const channel = await this.resolve(workspaceId, caller, reference);
		if (caller.agent && this.agentIn(channel, caller)?.access !== "post")
			throw new ChannelError(
				"This agent can read this channel but not post in it.",
				403,
			);
		const message = await this.message(channel, messageId);
		if (message.authorKey !== keyOf(caller.actor) && !caller.moderate)
			throw new ChannelError(
				"Only its author or a workspace admin can delete a message.",
				403,
			);
		if (message.deletedAt) return;
		message.body = "";
		message.mentions = [];
		message.mentionKeys = [];
		message.deletedAt = this.at();
		await this.rewrite(channel, caller, message, "deleted");
	}

	/**
	 * Reads a channel. `after` follows the log, oldest first, optionally
	 * waiting for something new. `thread` lists a thread. Otherwise a page of
	 * history below `before`, or the latest page, oldest first.
	 */
	async read(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		options: ReadOptions = {},
	): Promise<ChannelEntryList> {
		const channel = await this.resolve(workspaceId, caller, reference);
		const limit = Math.min(
			CHANNEL_LIMITS.maxPageSize,
			Math.max(1, options.limit ?? CHANNEL_LIMITS.pageSize),
		);
		if (options.thread !== undefined) {
			// Any message of a thread names it: a reply leads to its root.
			const named = await this.message(channel, options.thread);
			const root = named.threadId
				? await this.message(channel, named.threadId)
				: named;
			const top = await this.repository.topSeq(channel.id);
			const replies = await this.repository.threadReplies(
				channel.id,
				root.id,
				limit,
			);
			return {
				entries: await this.hydrate(channel.id, [root, ...replies]),
				cursor: top,
			};
		}
		if (options.after !== undefined || options.unread || options.mentionsOnly) {
			const after =
				options.after ??
				(await this.repository.readMark(channel.id, keyOf(caller.actor)));
			const filter = options.mentionsOnly
				? { mentionKey: keyOf(caller.actor) }
				: {};
			const deadline =
				this.now() +
				Math.min(CHANNEL_LIMITS.maxWaitSeconds, options.wait ?? 0) * 1000;
			for (;;) {
				const found = await this.repository.entriesAfter(
					channel.id,
					after,
					limit,
					filter,
				);
				if (found.length || this.now() >= deadline || options.signal?.aborted)
					return {
						entries: await this.hydrate(channel.id, found),
						cursor: found.at(-1)?.seq ?? after,
					};
				await sleep(
					Math.min(this.pollIntervalMs, deadline - this.now()),
					options.signal,
				);
			}
		}
		// The cursor is read first, so an entry appended while the page is read
		// comes again when the caller follows from it, never not at all.
		const top = await this.repository.topSeq(channel.id);
		const page = await this.repository.entriesBefore(
			channel.id,
			options.before,
			limit,
		);
		return {
			entries: await this.hydrate(channel.id, page.reverse()),
			cursor: top,
		};
	}

	/** Moves the caller's read mark forward, never past the end of the log. */
	async markRead(
		workspaceId: string,
		caller: ChannelCaller,
		reference: string,
		seq: number,
	): Promise<{ readSeq: number }> {
		const channel = await this.resolve(workspaceId, caller, reference);
		if (!Number.isInteger(seq) || seq < 0)
			throw new ChannelError("seq must be a whole number.");
		const top = await this.repository.topSeq(channel.id);
		return {
			readSeq: await this.repository.raiseReadMark(
				workspaceId,
				channel.id,
				keyOf(caller.actor),
				Math.min(seq, top),
				this.at(),
			),
		};
	}

	/**
	 * The caller's channels that have something new, waiting up to
	 * `timeoutSeconds` for one to appear.
	 */
	async waitForNews(
		workspaceId: string,
		caller: ChannelCaller,
		options: {
			timeoutSeconds?: number;
			mentionsOnly?: boolean;
			signal?: AbortSignal;
		} = {},
	): Promise<{ channels: ChannelSummary[] }> {
		const deadline =
			this.now() +
			Math.min(CHANNEL_LIMITS.maxWaitSeconds, options.timeoutSeconds ?? 0) *
				1000;
		for (;;) {
			const { channels } = await this.listChannels(workspaceId, caller);
			const news = channels.filter((channel) =>
				options.mentionsOnly ? channel.mentions > 0 : channel.unread,
			);
			if (news.length || this.now() >= deadline || options.signal?.aborted)
				return { channels: news };
			await sleep(
				Math.min(this.pollIntervalMs, deadline - this.now()),
				options.signal,
			);
		}
	}
}
