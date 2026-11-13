import type { ChannelList, ChannelSummary } from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceId, fetchChannels } from "./api.js";
import { channelTimings } from "./channels-state.js";

/**
 * One workspace's open channels as the signed-in person sees them. The shell
 * holds it so the sidebar can show unread channels and mentions from any view;
 * the Channels view reads and changes the same list.
 */
export type ChannelListState = {
	/** `null` until the first response. */
	channels: ChannelSummary[] | null;
	persistence: ChannelList["persistence"] | null;
	error: string;
	refresh(): Promise<void>;
	/**
	 * Applies a local change at once; a response already on its way is dropped.
	 * Before the first response there is nothing to change, so the list is
	 * loaded again instead and the change shows up in that answer.
	 */
	change(update: (channels: ChannelSummary[]) => ChannelSummary[]): void;
};

type Loaded = {
	workspaceId: string | null;
	channels: ChannelSummary[] | null;
	persistence: ChannelList["persistence"] | null;
	error: string;
};
const nothing = (workspaceId: string | null): Loaded => ({
	workspaceId,
	channels: null,
	persistence: null,
	error: "",
});

export function useChannelList(workspaceId: string | null): ChannelListState {
	const [loaded, setLoaded] = useState<Loaded>(() => nothing(workspaceId));
	const sequence = useRef(0);
	/** The workspace whose list has arrived, if any. */
	const arrived = useRef<string | null>(null);
	const refresh = useCallback(async () => {
		// The shell sets the workspace while rendering; a timer can fire between
		// that and this effect's cleanup.
		if (!workspaceId || currentWorkspaceId() !== workspaceId) return;
		const request = ++sequence.current;
		try {
			const result = await fetchChannels();
			if (request === sequence.current) {
				arrived.current = workspaceId;
				setLoaded({
					workspaceId,
					channels: result.channels,
					persistence: result.persistence,
					error: "",
				});
			}
		} catch (cause) {
			if (request === sequence.current)
				setLoaded((current) => ({
					...(current.workspaceId === workspaceId
						? current
						: nothing(workspaceId)),
					error:
						cause instanceof Error
							? cause.message
							: "Could not load the channels.",
				}));
		}
	}, [workspaceId]);
	useEffect(() => {
		if (!workspaceId) return;
		const visible = () => {
			if (!document.hidden) void refresh();
		};
		visible();
		const timer = setInterval(visible, channelTimings.listIntervalMs);
		document.addEventListener("visibilitychange", visible);
		return () => {
			sequence.current++;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
		};
	}, [workspaceId, refresh]);
	const change = useCallback<ChannelListState["change"]>(
		(update) => {
			// The first load is still on its way and may have been answered
			// before this change happened: ask again rather than drop both.
			if (arrived.current !== workspaceId) {
				void refresh();
				return;
			}
			sequence.current++;
			setLoaded((current) =>
				current.workspaceId === workspaceId && current.channels
					? { ...current, channels: update(current.channels) }
					: current,
			);
		},
		[workspaceId, refresh],
	);
	const current = loaded.workspaceId === workspaceId ? loaded : null;
	return {
		channels: current?.channels ?? null,
		persistence: current?.persistence ?? null,
		error: current?.error ?? "",
		refresh,
		change,
	};
}

/** What the sidebar shows next to Channels. */
export function channelAttention(channels: ChannelSummary[] | null) {
	return {
		unread: channels?.some((channel) => channel.unread) ?? false,
		mentions:
			channels?.reduce((total, channel) => total + channel.mentions, 0) ?? 0,
	};
}
