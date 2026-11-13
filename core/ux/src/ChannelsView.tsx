import {
	CHANNEL_LIMITS,
	type ChannelDetails,
	type ChannelSummary,
	type TeamMember,
	type WorkspaceAccess,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { createChannel, fetchChannels } from "./api.js";
import { ChannelRoom } from "./ChannelRoom.js";
import type { ChannelListState } from "./channels-list.js";
import {
	CHANNEL_NAME_INPUT_PATTERN,
	channelsHash,
	parseChannelsRoute,
} from "./channels-route.js";
import { Icon } from "./Icons.js";

const byName = (a: ChannelSummary, b: ChannelSummary) =>
	a.name.localeCompare(b.name);
const without = (channels: ChannelSummary[], id: string) =>
	channels.filter((channel) => channel.id !== id);
const withChannel = (channels: ChannelSummary[], channel: ChannelSummary) =>
	[...without(channels, channel.id), channel].sort(byName);
/**
 * A channel read a moment ago can arrive after the read mark moved here; the
 * list then keeps what it knows about what has been read.
 */
const keepRead = (
	channels: ChannelSummary[],
	next: ChannelSummary,
): ChannelSummary => {
	const known = channels.find((channel) => channel.id === next.id);
	return known && known.readSeq > next.readSeq
		? {
				...next,
				readSeq: known.readSeq,
				unread: known.unread,
				mentions: known.mentions,
			}
		: next;
};
const summaryOf = ({
	actions: _actions,
	...summary
}: ChannelDetails): ChannelSummary => summary;

function NewChannelForm({
	onClose,
	onCreated,
}: {
	onClose(): void;
	onCreated(channel: ChannelDetails): void;
}) {
	const [name, setName] = useState("");
	const [topic, setTopic] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const input = useRef<HTMLInputElement>(null);
	useEffect(() => {
		input.current?.focus();
	}, []);
	return (
		<section className="channels-new" aria-labelledby="channels-new-heading">
			<div className="section-heading">
				<h2 id="channels-new-heading">New channel</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close new channel form"
					onClick={onClose}
					disabled={busy}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						onCreated(
							await createChannel({
								name: name.trim(),
								...(topic.trim() ? { topic: topic.trim() } : {}),
							}),
						);
					} catch (cause) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not create the channel.",
						);
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="form-field">
						<label htmlFor="channel-new-name">Name</label>
						<input
							ref={input}
							id="channel-new-name"
							required
							pattern={CHANNEL_NAME_INPUT_PATTERN}
							maxLength={80}
							placeholder="general"
							value={name}
							onChange={(event) =>
								setName(event.target.value.toLowerCase().replace(/\s+/g, "-"))
							}
						/>
						<span className="field-hint">
							Lowercase letters, digits, hyphens, and underscores. Unique in
							this workspace.
						</span>
					</div>
					<div className="form-field">
						<label htmlFor="channel-new-topic">Topic</label>
						<input
							id="channel-new-topic"
							maxLength={CHANNEL_LIMITS.topicLength}
							placeholder="What this channel is for"
							value={topic}
							onChange={(event) => setTopic(event.target.value)}
						/>
					</div>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					<div className="form-actions">
						<button className="button" type="button" onClick={onClose}>
							Cancel
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={!name.trim()}
						>
							{busy ? "Creating…" : "Create channel"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

function ChannelLinks({
	channels,
	selected,
	label,
	onOpen,
}: {
	channels: ChannelSummary[];
	selected: string | null;
	label: string;
	onOpen(name: string): void;
}) {
	return (
		<ul className="channels-nav" aria-label={label}>
			{channels.map((channel) => (
				<li key={channel.id}>
					<a
						href={channelsHash(channel.name)}
						className={channel.unread ? "unread" : undefined}
						aria-current={channel.id === selected ? "page" : undefined}
						onClick={(event) => {
							event.preventDefault();
							onOpen(channel.name);
						}}
					>
						<span className="channel-hash" aria-hidden="true">
							#
						</span>
						{channel.unread ? (
							<strong>{channel.name}</strong>
						) : (
							<span>{channel.name}</span>
						)}
						{channel.unread && (
							<span className="visually-hidden"> (unread)</span>
						)}
						{channel.mentions > 0 && (
							<span className="channel-count">
								{channel.mentions}
								<span className="visually-hidden">
									{channel.mentions === 1
										? " unread mention"
										: " unread mentions"}
								</span>
							</span>
						)}
					</a>
				</li>
			))}
		</ul>
	);
}

export function ChannelsView({
	user,
	workspace,
	list,
}: {
	user: TeamMember;
	workspace: WorkspaceAccess;
	/** The workspace's open channels, shared with the sidebar's unread marker. */
	list: ChannelListState;
}) {
	const [route, setRoute] = useState(() =>
		parseChannelsRoute(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setRoute(parseChannelsRoute(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const navigate = useCallback((name: string | null, replace = false) => {
		const hash = channelsHash(name);
		if (window.location.hash !== hash)
			window.history[replace ? "replaceState" : "pushState"](null, "", hash);
		setRoute({ name });
	}, []);
	const [creating, setCreating] = useState(false);
	const [showArchived, setShowArchived] = useState(false);
	/** Archived channels, read when they are asked for. */
	const [archived, setArchived] = useState<ChannelSummary[] | null>(null);
	const archivedRequest = useRef(0);
	const loadArchived = useCallback(async () => {
		const request = ++archivedRequest.current;
		try {
			const result = await fetchChannels(true);
			if (request === archivedRequest.current) setArchived(result.channels);
		} catch {
			if (request === archivedRequest.current)
				setArchived((current) => current ?? []);
		}
	}, []);
	useEffect(
		() => () => {
			archivedRequest.current++;
		},
		[],
	);

	const { change } = list;
	const open = list.channels;
	const named = route.name;
	// A link to a channel that is not open may be to an archived one.
	const unknown = Boolean(
		named && open && !open.some((channel) => channel.name === named),
	);
	useEffect(() => {
		if (unknown && archived === null) void loadArchived();
	}, [unknown, archived, loadArchived]);
	const selected = named
		? (open?.find((channel) => channel.name === named) ??
			archived?.find((channel) => channel.name === named) ??
			null)
		: (open?.[0] ?? null);
	const selectedId = useRef<string | null>(null);
	useEffect(() => {
		selectedId.current = selected?.id ?? null;
		// The URL names the open channel, so a reload or a shared link lands on it.
		if (!named && selected) navigate(selected.name, true);
	}, [named, selected, navigate]);

	const onChanged = useCallback(
		(channel: ChannelDetails) => {
			const summary = summaryOf(channel);
			if (channel.archivedAt) {
				change((channels) => without(channels, channel.id));
				setArchived((current) => withChannel(current ?? [], summary));
			} else {
				change((channels) =>
					withChannel(channels, keepRead(channels, summary)),
				);
				setArchived((current) => current && without(current, channel.id));
			}
			// A rename moves the open channel's link.
			if (selectedId.current === channel.id) navigate(channel.name, true);
		},
		[change, navigate],
	);
	const onRead = useCallback(
		(id: string, readSeq: number) => {
			const read = (channels: ChannelSummary[]) =>
				channels.map((channel) =>
					channel.id === id
						? {
								...channel,
								readSeq: Math.max(channel.readSeq, readSeq),
								unread: false,
								mentions: 0,
							}
						: channel,
				);
			change(read);
			setArchived((current) => current && read(current));
		},
		[change],
	);
	const archivedShown = showArchived || Boolean(selected?.archivedAt);
	return (
		<div className="dashboard channels-view">
			<header className="dashboard-header">
				<div>
					<h1>Channels</h1>
					<p className="page-description">
						Where {workspace.name}'s team and agents talk. Everyone in the
						workspace can read and post in every channel; an agent joins a
						channel when someone adds it.
					</p>
				</div>
			</header>
			{list.error && (
				<div className="banner-error" role="alert">
					{list.error}
				</div>
			)}
			{list.persistence === "memory" && (
				<p className="card-note">
					Channels are temporary until MongoDB is connected. They are lost when
					the API restarts.
				</p>
			)}
			<div className="channels-layout">
				<aside className="card channels-list" aria-label="Channel list">
					<button
						className="button primary"
						type="button"
						disabled={creating}
						onClick={() => setCreating(true)}
					>
						<Icon name="plus" />
						New channel
					</button>
					{creating && (
						<NewChannelForm
							onClose={() => setCreating(false)}
							onCreated={(channel) => {
								setCreating(false);
								change((channels) => withChannel(channels, summaryOf(channel)));
								navigate(channel.name);
							}}
						/>
					)}
					{open === null ? (
						!list.error && (
							<p className="card-note" role="status">
								Loading channels…
							</p>
						)
					) : open.length ? (
						<ChannelLinks
							channels={open}
							selected={selected?.id ?? null}
							label="Channels"
							onOpen={navigate}
						/>
					) : (
						<p className="card-note">No channels yet.</p>
					)}
					<label className="failover-enable channels-archived-toggle">
						<input
							type="checkbox"
							checked={showArchived}
							onChange={(event) => {
								setShowArchived(event.target.checked);
								if (event.target.checked) void loadArchived();
							}}
						/>
						Show archived
					</label>
					{archivedShown &&
						(archived === null ? (
							<p className="card-note" role="status">
								Loading archived channels…
							</p>
						) : archived.length ? (
							<ChannelLinks
								channels={archived}
								selected={selected?.id ?? null}
								label="Archived channels"
								onOpen={navigate}
							/>
						) : (
							<p className="card-note">No archived channels.</p>
						))}
				</aside>
				{selected ? (
					// Keyed by channel: a late response for one never lands in another.
					<ChannelRoom
						key={selected.id}
						summary={selected}
						me={user.id}
						myName={user.name || user.email}
						moderate={workspace.role === "admin"}
						onChanged={onChanged}
						onRead={(readSeq) => onRead(selected.id, readSeq)}
					/>
				) : (
					<section
						className="card channel-room channel-none"
						aria-label="Channel"
					>
						{open === null || (unknown && archived === null) ? (
							!list.error && (
								<p className="card-note" role="status">
									Loading…
								</p>
							)
						) : named ? (
							<>
								<h2>No channel named #{named}</h2>
								<p className="card-note">
									It may have been renamed. Pick a channel from the list.
								</p>
							</>
						) : (
							<>
								<h2>No channels yet</h2>
								<p>Create a channel to talk with your team and agents.</p>
							</>
						)}
					</section>
				)}
			</div>
		</div>
	);
}
