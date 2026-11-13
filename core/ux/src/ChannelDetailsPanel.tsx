import {
	CHANNEL_LIMITS,
	type ChannelAgentAccess,
	type ChannelAgentOption,
	type ChannelDetails,
} from "@autonomo.us/common";
import { useEffect, useRef, useState } from "react";
import {
	ApiError,
	setChannelAgent,
	setChannelArchived,
	updateChannel,
} from "./api.js";
import { CHANNEL_NAME_INPUT_PATTERN } from "./channels-route.js";
import { Icon } from "./Icons.js";

const date = (value: string) => new Date(value).toLocaleString();
/** A gateway bot is told from an agent token, and is paused, never revoked. */
const optionLabel = (option: ChannelAgentOption) =>
	option.hosted
		? `${option.name} (Gateway bot${option.status === "active" ? "" : ", paused"})`
		: `${option.name}${option.status === "active" ? "" : ` (${option.status})`}`;
const ACCESS: Record<ChannelAgentAccess, string> = {
	read: "Read",
	post: "Post",
};

/** Name, topic, and description. Remounted when the channel's revision changes. */
function SettingsForm({
	channel,
	busy,
	onSave,
}: {
	channel: ChannelDetails;
	busy: boolean;
	onSave(changes: {
		name?: string;
		topic?: string;
		description?: string;
	}): void;
}) {
	const [name, setName] = useState(channel.name);
	const [topic, setTopic] = useState(channel.topic);
	const [description, setDescription] = useState(channel.description);
	const archived = channel.archivedAt !== null;
	const changes = {
		...(name.trim() !== channel.name ? { name: name.trim() } : {}),
		...(topic.trim() !== channel.topic ? { topic: topic.trim() } : {}),
		...(description.trim() !== channel.description
			? { description: description.trim() }
			: {}),
	};
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (Object.keys(changes).length) onSave(changes);
			}}
		>
			<fieldset className="routing-fields" disabled={busy || archived}>
				<div className="form-field">
					<label htmlFor="channel-details-name">Name</label>
					<input
						id="channel-details-name"
						required
						pattern={CHANNEL_NAME_INPUT_PATTERN}
						maxLength={80}
						value={name}
						onChange={(event) => setName(event.target.value.toLowerCase())}
					/>
					<span className="field-hint">
						Lowercase letters, digits, hyphens, and underscores. Renaming
						changes the channel's link.
					</span>
				</div>
				<div className="form-field">
					<label htmlFor="channel-details-topic">Topic</label>
					<input
						id="channel-details-topic"
						maxLength={CHANNEL_LIMITS.topicLength}
						value={topic}
						placeholder="What this channel is for"
						onChange={(event) => setTopic(event.target.value)}
					/>
				</div>
				<div className="form-field">
					<label htmlFor="channel-details-description">Description</label>
					<textarea
						id="channel-details-description"
						maxLength={CHANNEL_LIMITS.descriptionLength}
						rows={3}
						value={description}
						onChange={(event) => setDescription(event.target.value)}
					/>
				</div>
				<div className="form-actions">
					<button
						className="button primary"
						type="submit"
						disabled={!name.trim() || !Object.keys(changes).length}
					>
						Save changes
					</button>
				</div>
			</fieldset>
		</form>
	);
}

/**
 * The side panel for a channel: its name, topic, and description, archiving,
 * the agents in it with their access, and the history of changes.
 */
export function ChannelDetailsPanel({
	channel,
	options,
	onClose,
	onChanged,
	onReload,
}: {
	/** `null` while the details load. */
	channel: ChannelDetails | null;
	/** The workspace's agent tokens and gateway bots; `null` while they load. */
	options: ChannelAgentOption[] | null;
	onClose(): void;
	onChanged(channel: ChannelDetails): void;
	/** Reads the channel and the agents again. */
	onReload(): void;
}) {
	const [agentId, setAgentId] = useState("");
	const [access, setAccess] = useState<ChannelAgentAccess>("post");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, []);
	// An agent or bot made since the channel was opened should be on offer.
	const reload = useRef(onReload);
	useEffect(() => {
		reload.current = onReload;
	});
	useEffect(() => reload.current(), []);
	const byId = new Map(options?.map((option) => [option.agentTokenId, option]));
	const run = async (action: () => Promise<ChannelDetails>, done: string) => {
		if (busy) return false;
		setBusy(true);
		setError("");
		setNotice("");
		try {
			onChanged(await action());
			setNotice(done);
			return true;
		} catch (cause) {
			const stale = cause instanceof ApiError && cause.status === 409;
			setError(
				`${cause instanceof Error ? cause.message : "Could not save the change."}${
					stale ? " The channel was read again; check it and retry." : ""
				}`,
			);
			if (stale) onReload();
			return false;
		} finally {
			setBusy(false);
		}
	};
	const archived = channel ? channel.archivedAt !== null : false;
	const inChannel = new Set(channel?.agents.map((agent) => agent.agentTokenId));
	const available = (options ?? []).filter(
		(option) => !inChannel.has(option.agentTokenId),
	);
	return (
		<aside
			className="card channel-panel channel-details"
			aria-label="Channel details"
		>
			<div className="section-heading">
				<h2 tabIndex={-1} ref={heading}>
					{channel ? `#${channel.name}` : "Channel details"}
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close channel details"
					onClick={onClose}
				>
					<Icon name="close" />
				</button>
			</div>
			{!channel ? (
				<p className="card-note" role="status">
					Loading details…
				</p>
			) : (
				<div className="channel-scroll">
					<p className="card-note">
						Created {date(channel.createdAt)} by {channel.createdBy.name}.
						Everyone in this workspace can read and post here.
					</p>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					{notice && (
						<p className="success-notice" role="status">
							{notice}
						</p>
					)}
					<SettingsForm
						key={channel.revision}
						channel={channel}
						busy={busy}
						onSave={(changes) =>
							void run(
								() =>
									updateChannel(channel.id, {
										...changes,
										revision: channel.revision,
									}),
								"Channel updated.",
							)
						}
					/>

					<h3>Agents</h3>
					{channel.agents.length ? (
						<ul className="channel-agents">
							{channel.agents.map((agent) => (
								<li key={agent.agentTokenId}>
									<span className="channel-agent-name">
										<strong>
											{agent.name}
											{byId.get(agent.agentTokenId)?.hosted && (
												<span className="channel-chip">Gateway bot</span>
											)}
											{byId.get(agent.agentTokenId)?.hosted &&
												byId.get(agent.agentTokenId)?.status === "revoked" && (
													<span className="channel-chip paused">Paused</span>
												)}
										</strong>
										<small>Added by {agent.addedBy}</small>
									</span>
									<select
										className="workspace-role-select"
										aria-label={`Access for ${agent.name}`}
										value={agent.access}
										disabled={busy || archived}
										onChange={(event) => {
											const next = event.target.value as ChannelAgentAccess;
											void run(
												() =>
													setChannelAgent(channel.id, agent.agentTokenId, next),
												`${agent.name} now has ${next} access.`,
											);
										}}
									>
										<option value="read">{ACCESS.read}</option>
										<option value="post">{ACCESS.post}</option>
									</select>
									<button
										className="button danger"
										type="button"
										aria-label={`Remove ${agent.name}`}
										disabled={busy || archived}
										onClick={() =>
											void run(
												() =>
													setChannelAgent(channel.id, agent.agentTokenId, null),
												`${agent.name} was removed.`,
											)
										}
									>
										Remove
									</button>
								</li>
							))}
						</ul>
					) : (
						<p className="card-note">
							No agents are in this channel yet. Add one below. An agent also
							needs the <code>mcp:call</code> grant on its agent token to read
							and post here.
						</p>
					)}
					{!archived && (
						<form
							className="channel-add-agent"
							onSubmit={async (event) => {
								event.preventDefault();
								const option = available.find(
									(item) => item.agentTokenId === agentId,
								);
								if (!option) return;
								const added = await run(
									() => setChannelAgent(channel.id, agentId, access),
									`${option.name} was added with ${access} access.`,
								);
								if (added) setAgentId("");
							}}
						>
							<div className="form-field">
								<label htmlFor="channel-add-agent">Add agent</label>
								<select
									id="channel-add-agent"
									value={agentId}
									disabled={busy || !available.length}
									onChange={(event) => setAgentId(event.target.value)}
								>
									<option value="">
										{options === null
											? "Loading agents…"
											: available.length
												? "Choose an agent…"
												: "No agents to add"}
									</option>
									{available.map((option) => (
										<option
											key={option.agentTokenId}
											value={option.agentTokenId}
										>
											{optionLabel(option)}
										</option>
									))}
								</select>
							</div>
							<div className="form-field">
								<label htmlFor="channel-add-access">Access</label>
								<select
									id="channel-add-access"
									value={access}
									disabled={busy || !available.length}
									onChange={(event) =>
										setAccess(event.target.value as ChannelAgentAccess)
									}
								>
									<option value="post">{ACCESS.post}</option>
									<option value="read">{ACCESS.read}</option>
								</select>
							</div>
							<button
								className="button"
								type="submit"
								disabled={busy || !agentId}
							>
								Add agent
							</button>
						</form>
					)}
					<p className="card-note">
						{options !== null && !options.length
							? "This workspace has no agents yet. A workspace admin creates one under Agents. "
							: options !== null && !available.length
								? "Every agent in this workspace is already in this channel. "
								: ""}
						Read lets an agent follow the channel; Post also lets it write, and
						is what a gateway bot needs to answer. An expired or revoked agent
						cannot connect, and a paused bot answers nothing.
					</p>

					<h3>{archived ? "Archived" : "Archive"}</h3>
					<p className="card-note">
						{archived
							? `Archived ${date(channel.archivedAt ?? channel.updatedAt)}. The history stays readable; nothing can be posted or changed until it is unarchived.`
							: "Archiving keeps the history readable and stops new posts. It can be undone."}
					</p>
					<button
						className={`button${archived ? "" : " danger"}`}
						type="button"
						disabled={busy}
						onClick={() =>
							void run(
								() => setChannelArchived(channel.id, !archived),
								archived ? "Channel unarchived." : "Channel archived.",
							)
						}
					>
						{archived ? "Unarchive channel" : "Archive channel"}
					</button>

					<h3>History</h3>
					<ul className="channel-history">
						{channel.actions.map((action) => (
							<li key={action.id}>
								<time dateTime={action.timestamp}>
									{date(action.timestamp)}
								</time>{" "}
								{action.detail}{" "}
								<span className="channel-history-actor">
									by {action.actor.name}
									{action.actor.kind === "agent" && (
										<span className="channel-chip">Bot</span>
									)}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}
		</aside>
	);
}
