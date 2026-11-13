import {
	CHANNEL_LIMITS,
	type ChannelActor,
	type ChannelMember,
	type ChannelMessage,
	SYNAPSE_SHARED_SPACE,
	splitChannelMentions,
} from "@autonomo.us/common";
import {
	memo,
	type ReactNode,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import {
	dayKey,
	dayLabel,
	type PendingPost,
	type TimelineEntry,
	timeLabel,
} from "./channels-state.js";
import { type InlineOptions, renderMarkdown } from "./synapse-markdown.js";
import { noteHash } from "./synapse-route.js";

/** Members by `kind:id`, the form a mention names them in. */
export type MemberIndex = ReadonlyMap<string, ChannelMember>;
export const memberIndex = (members: ChannelMember[]): MemberIndex =>
	new Map(members.map((member) => [`${member.kind}:${member.id}`, member]));

/** What a message row needs to know about its reader and what they may do. */
export type MessageTools = {
	/** The signed-in person's id. */
	me: string;
	/** Their name, for a message that is still on its way. */
	myName: string;
	/** Workspace admins may delete anyone's message. */
	moderate: boolean;
	archived: boolean;
	members: MemberIndex;
	/** Opens the message's thread. Absent inside a thread. */
	onReply?(message: ChannelMessage): void;
	onEdit(message: ChannelMessage, body: string): Promise<void>;
	onDelete(message: ChannelMessage): Promise<void>;
	onRetry(post: PendingPost): void;
	onDiscard(post: PendingPost): void;
};

function AuthorChip({ kind }: { kind: ChannelActor["kind"] }) {
	if (kind === "user") return null;
	return (
		<span
			className="channel-chip"
			title={
				kind === "agent"
					? "An agent in this channel"
					: "Posted with an API token"
			}
		>
			{kind === "agent" ? "Bot" : "Token"}
		</span>
	);
}

/**
 * A message body: Markdown through the Synapse renderer, which builds React
 * elements only, with `[[wikilinks]]` opening the workspace's shared notes and
 * mentions shown as chips carrying the member's current name.
 */
export const MessageBody = memo(function MessageBody({
	body,
	members,
	me,
}: {
	body: string;
	members: MemberIndex;
	me: string;
}) {
	const options = useMemo<InlineOptions>(
		() => ({
			hrefFor: (title) => noteHash(SYNAPSE_SHARED_SPACE, title),
			onNavigate: (title) => {
				window.location.hash = noteHash(SYNAPSE_SHARED_SPACE, title);
			},
			text: (text) =>
				splitChannelMentions(text).map((part, index) =>
					typeof part === "string" ? (
						part
					) : (
						<span
							// biome-ignore lint/suspicious/noArrayIndexKey: parts of one text run never reorder
							key={index}
							className={`channel-mention${part.kind === "user" && part.id === me ? " me" : ""}`}
						>
							@{members.get(`${part.kind}:${part.id}`)?.name ?? "unknown"}
						</span>
					),
				),
		}),
		[members, me],
	);
	return (
		<div className="synapse-markdown channel-body">
			{renderMarkdown(body, options)}
		</div>
	);
});

function EditForm({
	message,
	onSave,
	onCancel,
}: {
	message: ChannelMessage;
	onSave(body: string): Promise<void>;
	onCancel(): void;
}) {
	const [body, setBody] = useState(message.body);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		const element = input.current;
		element?.focus();
		element?.setSelectionRange(element.value.length, element.value.length);
	}, []);
	const save = async () => {
		const next = body.trim();
		if (busy || !next) return;
		if (next === message.body) return onCancel();
		setBusy(true);
		setError("");
		try {
			await onSave(next);
		} catch (cause) {
			setError(
				cause instanceof Error ? cause.message : "Could not save the message.",
			);
			setBusy(false);
		}
	};
	return (
		<form
			className="channel-edit"
			onSubmit={(event) => {
				event.preventDefault();
				void save();
			}}
		>
			<textarea
				ref={input}
				aria-label="Edit message"
				value={body}
				maxLength={CHANNEL_LIMITS.bodyLength}
				rows={Math.min(8, body.split("\n").length)}
				disabled={busy}
				onChange={(event) => setBody(event.target.value)}
				onKeyDown={(event) => {
					if (event.key === "Escape") {
						event.preventDefault();
						onCancel();
					} else if (
						event.key === "Enter" &&
						!event.shiftKey &&
						!event.nativeEvent.isComposing
					) {
						event.preventDefault();
						void save();
					}
				}}
			/>
			{error && (
				<p className="save-error" role="alert">
					{error}
				</p>
			)}
			<div className="channel-edit-actions">
				<span className="field-hint">Enter to save, Escape to cancel</span>
				<button
					className="button"
					type="button"
					onClick={onCancel}
					disabled={busy}
				>
					Cancel
				</button>
				<button
					className="button primary"
					type="submit"
					disabled={busy || !body.trim()}
				>
					{busy ? "Saving…" : "Save"}
				</button>
			</div>
		</form>
	);
}

function MessageRow({
	message,
	head,
	tools,
}: {
	message: ChannelMessage;
	/** The first of a run by one author shows who and when. */
	head: boolean;
	tools: MessageTools;
}) {
	const [mode, setMode] = useState<"read" | "edit" | "delete">("read");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const deleted = message.deletedAt !== null;
	const mine = message.author.kind === "user" && message.author.id === tools.me;
	const canEdit = !deleted && !tools.archived && mine;
	// Deleting stays possible in an archived channel, as on the server: a
	// pasted secret has to be removable.
	const canDelete = !deleted && (mine || tools.moderate);
	const time = new Date(message.createdAt).toLocaleString();
	return (
		<li className={`channel-message${head ? " head" : ""}`}>
			{head ? (
				<>
					<span className="channel-avatar" aria-hidden="true">
						{message.author.name.slice(0, 1).toUpperCase()}
					</span>
					<div className="channel-message-head">
						<strong>{message.author.name}</strong>
						<AuthorChip kind={message.author.kind} />
						<time dateTime={message.createdAt} title={time}>
							{timeLabel(message.createdAt)}
						</time>
					</div>
				</>
			) : (
				<time
					className="channel-message-time"
					dateTime={message.createdAt}
					title={time}
				>
					{timeLabel(message.createdAt)}
				</time>
			)}
			<div className="channel-message-content">
				{deleted ? (
					<p className="channel-deleted">Message deleted</p>
				) : mode === "edit" ? (
					<EditForm
						message={message}
						onCancel={() => setMode("read")}
						onSave={async (body) => {
							await tools.onEdit(message, body);
							setMode("read");
						}}
					/>
				) : (
					<>
						<MessageBody
							body={message.body}
							members={tools.members}
							me={tools.me}
						/>
						{message.editedAt && (
							<span
								className="channel-edited"
								title={`Edited ${new Date(message.editedAt).toLocaleString()}`}
							>
								(edited)
							</span>
						)}
					</>
				)}
				{tools.onReply && message.replyCount > 0 && (
					<button
						type="button"
						className="channel-replies"
						onClick={() => tools.onReply?.(message)}
					>
						{message.replyCount}{" "}
						{message.replyCount === 1 ? "reply" : "replies"}
					</button>
				)}
				{mode === "delete" && (
					<div className="channel-confirm">
						<span>
							{mine
								? "Delete this message?"
								: `Delete ${message.author.name}'s message?`}{" "}
							Its text is removed for everyone.
						</span>
						<button
							className="button danger"
							type="button"
							disabled={busy}
							onClick={async () => {
								setBusy(true);
								setError("");
								try {
									await tools.onDelete(message);
									setMode("read");
								} catch (cause) {
									setError(
										cause instanceof Error
											? cause.message
											: "Could not delete the message.",
									);
								} finally {
									setBusy(false);
								}
							}}
						>
							{busy ? "Deleting…" : "Delete message"}
						</button>
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => setMode("read")}
						>
							Cancel
						</button>
						{error && (
							<p className="save-error" role="alert">
								{error}
							</p>
						)}
					</div>
				)}
			</div>
			{mode === "read" && (tools.onReply || canEdit || canDelete) && (
				<div className="channel-message-actions">
					{tools.onReply && (
						<button type="button" onClick={() => tools.onReply?.(message)}>
							Reply
						</button>
					)}
					{canEdit && (
						<button type="button" onClick={() => setMode("edit")}>
							Edit
						</button>
					)}
					{canDelete && (
						<button type="button" onClick={() => setMode("delete")}>
							Delete
						</button>
					)}
				</div>
			)}
		</li>
	);
}

function PendingRow({
	post,
	head,
	tools,
}: {
	post: PendingPost;
	head: boolean;
	tools: MessageTools;
}) {
	const failed = post.status === "failed";
	return (
		<li
			className={`channel-message pending${head ? " head" : ""}${failed ? " failed" : ""}`}
		>
			{head && (
				<>
					<span className="channel-avatar" aria-hidden="true">
						{tools.myName.slice(0, 1).toUpperCase()}
					</span>
					<div className="channel-message-head">
						<strong>{tools.myName}</strong>
					</div>
				</>
			)}
			<div className="channel-message-content">
				<MessageBody body={post.body} members={tools.members} me={tools.me} />
				{failed ? (
					<div className="channel-failed" role="alert">
						<span>Not sent{post.error ? `: ${post.error}` : "."}</span>
						<button
							className="button"
							type="button"
							onClick={() => tools.onRetry(post)}
						>
							Retry
						</button>
						<button
							className="button"
							type="button"
							onClick={() => tools.onDiscard(post)}
						>
							Discard
						</button>
					</div>
				) : (
					<span className="channel-sending" role="status">
						Sending…
					</span>
				)}
			</div>
		</li>
	);
}

/**
 * Entries grouped by day, with consecutive messages from one author collapsed
 * under a single name. Pending posts follow, in the order they were sent.
 */
export function MessageList({
	entries,
	pending,
	tools,
	label,
}: {
	entries: TimelineEntry[];
	pending: PendingPost[];
	tools: MessageTools;
	label: string;
}) {
	const rows: ReactNode[] = [];
	let day = "";
	let previous: TimelineEntry | null = null;
	for (const entry of entries) {
		const key = dayKey(entry.createdAt);
		if (key !== day) {
			day = key;
			previous = null;
			rows.push(
				<li className="channel-day" key={`day-${key}`}>
					<span>{dayLabel(entry.createdAt)}</span>
				</li>,
			);
		}
		if (entry.type === "system")
			rows.push(
				<li className="channel-system" key={entry.id}>
					<span>
						{entry.author.name} {entry.text}
					</span>{" "}
					<time
						dateTime={entry.createdAt}
						title={new Date(entry.createdAt).toLocaleString()}
					>
						{timeLabel(entry.createdAt)}
					</time>
				</li>,
			);
		else
			rows.push(
				<MessageRow
					key={entry.id}
					message={entry}
					tools={tools}
					head={
						previous?.type !== "message" ||
						previous.author.kind !== entry.author.kind ||
						previous.author.id !== entry.author.id
					}
				/>,
			);
		previous = entry;
	}
	return (
		<ol className="channel-log" aria-label={label}>
			{rows}
			{pending.map((post, index) => (
				<PendingRow
					key={post.nonce}
					post={post}
					tools={tools}
					head={
						index === 0 &&
						!(
							previous?.type === "message" &&
							previous.author.kind === "user" &&
							previous.author.id === tools.me
						)
					}
				/>
			))}
		</ol>
	);
}
