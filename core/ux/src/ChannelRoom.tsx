import {
	CHANNEL_LIMITS,
	type ChannelDetails,
	type ChannelMember,
	type ChannelMessage,
	type ChannelSummary,
} from "@autonomo.us/common";
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
} from "react";
import {
	deleteChannelMessage,
	editChannelMessage,
	fetchChannel,
	fetchChannelEntries,
	fetchChannelMembers,
	markChannelRead,
	postChannelMessage,
} from "./api.js";
import { Composer } from "./ChannelComposer.js";
import { ChannelDetailsPanel } from "./ChannelDetailsPanel.js";
import {
	MessageList,
	type MessageTools,
	memberIndex,
} from "./ChannelMessages.js";
import {
	channelTimings,
	emptyRoom,
	newNonce,
	type PendingPost,
	roomReducer,
	type ThreadState,
} from "./channels-state.js";
import { Icon } from "./Icons.js";

/** Resolves after `ms`, or at once when the signal aborts. */
const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const done = () => {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		};
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done);
	});
/** Resolves once the tab is visible, or when the signal aborts. */
const whenVisible = (signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		const check = () => {
			if (document.hidden && !signal.aborted) return;
			document.removeEventListener("visibilitychange", check);
			signal.removeEventListener("abort", check);
			resolve();
		};
		document.addEventListener("visibilitychange", check);
		signal.addEventListener("abort", check);
		check();
	});
const attentive = () => !document.hidden && document.hasFocus();
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;
/** Close enough to the end that the newest entry counts as on screen. */
const NEAR_END = 48;

function ThreadPanel({
	thread,
	pending,
	tools,
	members,
	archivedNote,
	onClose,
	onSend,
}: {
	thread: ThreadState;
	pending: PendingPost[];
	tools: MessageTools;
	members: ChannelMember[];
	archivedNote?: string;
	onClose(): void;
	onSend(body: string): void;
}) {
	const heading = useRef<HTMLHeadingElement>(null);
	const scroller = useRef<HTMLDivElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: moves focus when another thread opens
	useEffect(() => {
		heading.current?.focus({ preventScroll: true });
	}, [thread.rootId]);
	const count = thread.messages.length + pending.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: keeps the newest reply in view as replies arrive
	useLayoutEffect(() => {
		const element = scroller.current;
		if (element) element.scrollTop = element.scrollHeight;
	}, [count]);
	const replies = thread.messages.filter((item) => item.threadId !== null);
	const root = thread.messages.find((item) => item.id === thread.rootId);
	return (
		<aside className="card channel-panel channel-thread" aria-label="Thread">
			<div className="section-heading">
				<h2 tabIndex={-1} ref={heading}>
					Thread
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close thread"
					onClick={onClose}
				>
					<Icon name="close" />
				</button>
			</div>
			{thread.error && (
				<div className="banner-error" role="alert">
					{thread.error}
				</div>
			)}
			<div className="channel-scroll" ref={scroller}>
				<MessageList
					entries={thread.messages}
					pending={pending}
					tools={tools}
					label="Thread messages"
				/>
				<p className="card-note channel-thread-status" role="status">
					{!thread.loaded && !thread.error
						? "Loading replies…"
						: root && root.replyCount > replies.length
							? `Showing ${replies.length} of ${root.replyCount} replies.`
							: replies.length === 0
								? "No replies yet."
								: ""}
				</p>
			</div>
			<Composer
				label="Reply in thread"
				placeholder="Reply…"
				members={members}
				disabledNote={archivedNote}
				onSend={onSend}
			/>
		</aside>
	);
}

/**
 * One open channel: its messages, followed by long poll, with the composer,
 * the thread panel, and the details panel. The view renders it with
 * `key={channel.id}`, so nothing from another channel can land here.
 */
export function ChannelRoom({
	summary,
	me,
	myName,
	moderate,
	onChanged,
	onRead,
}: {
	/** The channel as the list knows it, shown until its details arrive. */
	summary: ChannelSummary;
	/** The signed-in person's id and name. */
	me: string;
	myName: string;
	/** Workspace admins may delete anyone's message. */
	moderate: boolean;
	onChanged(channel: ChannelDetails): void;
	onRead(readSeq: number): void;
}) {
	const id = summary.id;
	const [state, dispatch] = useReducer(roomReducer, emptyRoom);
	const [details, setDetails] = useState<ChannelDetails | null>(null);
	const [members, setMembers] = useState<ChannelMember[]>([]);
	const [panel, setPanel] = useState<"thread" | "details" | null>(null);
	const [problem, setProblem] = useState("");
	const [loadingEarlier, setLoadingEarlier] = useState(false);
	const channel = details ?? summary;
	const archived = channel.archivedAt !== null;
	const callbacks = useRef({ onChanged, onRead });
	useEffect(() => {
		callbacks.current = { onChanged, onRead };
	});

	const reload = useRef(() => {});
	useEffect(() => {
		const controller = new AbortController();
		const { signal } = controller;
		const loadChannel = async () => {
			try {
				const [next, people] = await Promise.all([
					fetchChannel(id, signal),
					fetchChannelMembers(id, signal),
				]);
				if (signal.aborted) return;
				setDetails(next);
				setMembers(people.members);
				callbacks.current.onChanged(next);
			} catch {
				// The header keeps what the list knows; the next system note retries.
			}
		};
		reload.current = () => void loadChannel();
		const follow = async () => {
			let cursor: number | null = null;
			while (!signal.aborted) {
				try {
					if (cursor === null) {
						const page = await fetchChannelEntries(id, {}, signal);
						if (signal.aborted) return;
						cursor = page.cursor;
						dispatch({ type: "page", ...page });
					} else {
						await whenVisible(signal);
						if (signal.aborted) return;
						const page = await fetchChannelEntries(
							id,
							{ after: cursor, wait: channelTimings.waitSeconds },
							signal,
						);
						if (signal.aborted) return;
						cursor = page.cursor;
						if (page.entries.length) {
							dispatch({ type: "entries", ...page });
							// A system note says the channel or its agents changed.
							if (page.entries.some((entry) => entry.type === "system"))
								void loadChannel();
						}
					}
					setProblem("");
				} catch (cause) {
					if (signal.aborted) return;
					setProblem(
						cursor === null
							? `${errorText(cause, "Could not load the messages.")} Trying again…`
							: "Connection lost. Reconnecting…",
					);
					await sleep(channelTimings.retryMs, signal);
				}
			}
		};
		void loadChannel();
		void follow();
		return () => controller.abort();
	}, [id]);

	// Scrolling: stay at the newest entry unless the reader has scrolled up, and
	// keep their place when earlier entries are added above.
	const scroller = useRef<HTMLDivElement>(null);
	const stick = useRef(true);
	const anchor = useRef<number | null>(null);
	const [atEnd, setAtEnd] = useState(true);
	const mainPending = useMemo(
		() => state.pending.filter((post) => post.threadId === null),
		[state.pending],
	);
	// biome-ignore lint/correctness/useExhaustiveDependencies: runs when what is listed changes
	useLayoutEffect(() => {
		const element = scroller.current;
		if (!element) return;
		if (anchor.current !== null) {
			element.scrollTop = element.scrollHeight - anchor.current;
			anchor.current = null;
		} else if (stick.current) element.scrollTop = element.scrollHeight;
	}, [state.timeline, mainPending, state.loaded]);
	// The list changes size when a panel opens or the window does.
	useEffect(() => {
		const element = scroller.current;
		if (!element || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => {
			if (stick.current) element.scrollTop = element.scrollHeight;
		});
		observer.observe(element);
		return () => observer.disconnect();
	}, []);
	const toEnd = () => {
		const element = scroller.current;
		stick.current = true;
		setAtEnd(true);
		if (element) element.scrollTop = element.scrollHeight;
	};

	// The read mark moves once the newest entry has been on screen with the tab
	// visible and focused, and only when it is behind.
	const [focused, setFocused] = useState(attentive);
	useEffect(() => {
		const sync = () => setFocused(attentive());
		sync();
		window.addEventListener("focus", sync);
		window.addEventListener("blur", sync);
		// Focus moving into the page also means the tab has it.
		document.addEventListener("focusin", sync);
		document.addEventListener("visibilitychange", sync);
		return () => {
			window.removeEventListener("focus", sync);
			window.removeEventListener("blur", sync);
			document.removeEventListener("focusin", sync);
			document.removeEventListener("visibilitychange", sync);
		};
	}, []);
	const [marked, setMarked] = useState(0);
	const readSeq = Math.max(summary.readSeq, marked);
	useEffect(() => {
		if (!state.loaded || !focused || !atEnd || state.cursor <= readSeq) return;
		const seq = state.cursor;
		// Once sent, the answer is kept whatever happens here meanwhile: the mark
		// did move, and this room only ever shows this channel.
		const timer = setTimeout(() => {
			markChannelRead(id, seq)
				.then((result) => {
					setMarked((current) => Math.max(current, result.readSeq));
					callbacks.current.onRead(result.readSeq);
				})
				.catch(() => {
					// The next entry, or the tab regaining focus, tries again.
				});
		}, channelTimings.readDelayMs);
		return () => clearTimeout(timer);
	}, [id, state.loaded, state.cursor, focused, atEnd, readSeq]);

	const deliver = useCallback(
		async (post: Pick<PendingPost, "nonce" | "body" | "threadId">) => {
			try {
				const posted = await postChannelMessage(id, {
					body: post.body,
					nonce: post.nonce,
					...(post.threadId ? { threadId: post.threadId } : {}),
				});
				dispatch({ type: "posted", nonce: post.nonce, message: posted });
			} catch (cause) {
				dispatch({
					type: "pending-status",
					nonce: post.nonce,
					status: "failed",
					error: errorText(cause, "The gateway could not be reached."),
				});
			}
		},
		[id],
	);
	const send = useCallback(
		(body: string, threadId: string | null) => {
			const post: PendingPost = {
				nonce: newNonce(),
				body,
				threadId,
				createdAt: new Date().toISOString(),
				status: "sending",
				error: "",
			};
			if (!threadId) stick.current = true;
			dispatch({ type: "pending-add", post });
			void deliver(post);
		},
		[deliver],
	);
	const openThread = useCallback(
		(root: ChannelMessage) => {
			const rootId = root.threadId ?? root.id;
			dispatch({ type: "thread-open", rootId });
			setPanel("thread");
			fetchChannelEntries(id, {
				thread: rootId,
				limit: CHANNEL_LIMITS.maxPageSize,
			})
				.then((page) =>
					dispatch({ type: "thread-loaded", rootId, entries: page.entries }),
				)
				.catch((cause) =>
					dispatch({
						type: "thread-failed",
						rootId,
						error: errorText(cause, "Could not load the thread."),
					}),
				);
		},
		[id],
	);
	const index = useMemo(() => memberIndex(members), [members]);
	const tools = useMemo<MessageTools>(
		() => ({
			me,
			myName,
			moderate,
			archived,
			members: index,
			onReply: openThread,
			onEdit: async (target, body) => {
				dispatch({
					type: "changed",
					message: await editChannelMessage(id, target.id, body),
				});
			},
			onDelete: async (target) => {
				await deleteChannelMessage(id, target.id);
				dispatch({
					type: "changed",
					message: {
						...target,
						body: "",
						mentions: [],
						deletedAt: new Date().toISOString(),
					},
				});
			},
			// The same nonce again: if the first attempt did land, this returns it.
			onRetry: (post) => {
				dispatch({
					type: "pending-status",
					nonce: post.nonce,
					status: "sending",
					error: "",
				});
				void deliver(post);
			},
			onDiscard: (post) =>
				dispatch({ type: "pending-remove", nonce: post.nonce }),
		}),
		[id, me, myName, moderate, archived, index, openThread, deliver],
	);
	const threadTools = useMemo<MessageTools>(
		() => ({ ...tools, onReply: undefined }),
		[tools],
	);
	const threadId = state.thread?.rootId ?? null;
	const threadPending = useMemo(
		() => state.pending.filter((post) => post.threadId === threadId),
		[state.pending, threadId],
	);

	const loadEarlier = async () => {
		const first = state.timeline[0]?.seq;
		if (!first || loadingEarlier) return;
		setLoadingEarlier(true);
		try {
			const page = await fetchChannelEntries(id, { before: first });
			const element = scroller.current;
			if (element) anchor.current = element.scrollHeight - element.scrollTop;
			dispatch({ type: "earlier", entries: page.entries });
			setProblem("");
		} catch (cause) {
			setProblem(errorText(cause, "Could not load earlier messages."));
		} finally {
			setLoadingEarlier(false);
		}
	};
	const archivedNote = archived
		? "This channel is archived. Unarchive it from Details to post again."
		: undefined;
	const detailsOpen = panel === "details";
	return (
		<>
			<section className="card channel-room" aria-label={`#${channel.name}`}>
				<header className="channel-header">
					<div>
						<h2>
							#{channel.name}
							{archived && <span className="badge archived">Archived</span>}
						</h2>
						<p className="card-note">{channel.topic || "No topic yet."}</p>
					</div>
					<button
						className="button"
						type="button"
						aria-expanded={detailsOpen}
						onClick={() => setPanel(detailsOpen ? null : "details")}
					>
						Details
					</button>
				</header>
				{problem && (
					<p className="banner-warning channel-problem" role="status">
						{problem}
					</p>
				)}
				<div
					className="channel-scroll"
					ref={scroller}
					onScroll={(event) => {
						const element = event.currentTarget;
						const near =
							element.scrollHeight - element.scrollTop - element.clientHeight <
							NEAR_END;
						stick.current = near;
						setAtEnd(near);
					}}
				>
					{!state.loaded ? (
						<p className="card-note" role="status">
							Loading messages…
						</p>
					) : (
						<>
							{state.hasEarlier ? (
								<button
									className="button channel-earlier"
									type="button"
									disabled={loadingEarlier}
									onClick={() => void loadEarlier()}
								>
									{loadingEarlier ? "Loading…" : "Load earlier"}
								</button>
							) : (
								<div className="channel-start">
									<p>
										This is the start of <strong>#{channel.name}</strong>.
										{channel.description ? ` ${channel.description}` : ""}
									</p>
									{channel.agents.length === 0 && !archived && (
										<p>
											No agents are in this channel yet.{" "}
											<button type="button" onClick={() => setPanel("details")}>
												Add one from Details
											</button>
											. An agent also needs the <code>mcp:call</code> grant on
											its agent token to read and post here.
										</p>
									)}
								</div>
							)}
							<MessageList
								entries={state.timeline}
								pending={mainPending}
								tools={tools}
								label={`Messages in #${channel.name}`}
							/>
						</>
					)}
				</div>
				{!atEnd && (
					<button className="button channel-jump" type="button" onClick={toEnd}>
						Jump to latest
					</button>
				)}
				<Composer
					label={`Message #${channel.name}`}
					placeholder={`Message #${channel.name}`}
					members={members}
					disabledNote={archivedNote}
					onSend={(body) => send(body, null)}
				/>
			</section>
			{panel === "thread" && state.thread && (
				<ThreadPanel
					thread={state.thread}
					pending={threadPending}
					tools={threadTools}
					members={members}
					archivedNote={archivedNote}
					onClose={() => {
						setPanel(null);
						dispatch({ type: "thread-close" });
					}}
					onSend={(body) => send(body, threadId)}
				/>
			)}
			{detailsOpen && (
				<ChannelDetailsPanel
					channel={details}
					onClose={() => setPanel(null)}
					onReload={() => reload.current()}
					onChanged={(next) => {
						setDetails(next);
						onChanged(next);
					}}
				/>
			)}
		</>
	);
}
