import type { WorkspaceOverview } from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceId, fetchWorkspaceOverview } from "./api.js";
import { newerOverview } from "./overview-items.js";

/** How often the shell reads the overview for the sidebar's badges. */
export const overviewTimings = { intervalMs: 60_000 };

const CHANGED = "autonomous:attention-changed";
/**
 * Says something that waits on a person was decided (a proposal, a site
 * request), so the sidebar's counts are read again now, not at the next poll.
 */
export function attentionChanged() {
	window.dispatchEvent(new Event(CHANGED));
}

/**
 * One workspace's overview, held by the shell so the sidebar can count what
 * waits on the person in Synapse and Agents from any view. The dashboard
 * reads its own, for its period, and hands each answer back with `set`;
 * while it does, the shell does not poll.
 */
export type OverviewState = {
	/** `null` until the first answer, or when it could not be read. */
	overview: WorkspaceOverview | null;
	set(overview: WorkspaceOverview): void;
	refresh(): Promise<void>;
};

export function useOverview(workspaceId: string | null): OverviewState {
	const [loaded, setLoaded] = useState<{
		workspaceId: string | null;
		overview: WorkspaceOverview | null;
	}>({ workspaceId, overview: null });
	const sequence = useRef(0);
	/** When the dashboard last handed over an overview. */
	const handed = useRef(0);
	/**
	 * Keeps whichever answer the server generated last, so an older read that
	 * arrives late (a poll that began before a decision) cannot undo a newer.
	 */
	const accept = useCallback(
		(overview: WorkspaceOverview) =>
			setLoaded((current) => ({
				workspaceId,
				overview:
					current.workspaceId === workspaceId
						? newerOverview(current.overview, overview)
						: overview,
			})),
		[workspaceId],
	);
	const refresh = useCallback(async () => {
		// The shell sets the workspace while rendering; a timer can fire between
		// that and this effect's cleanup.
		if (!workspaceId || currentWorkspaceId() !== workspaceId) return;
		const request = ++sequence.current;
		try {
			const overview = await fetchWorkspaceOverview();
			if (request === sequence.current) accept(overview);
		} catch {
			// Badges are a convenience: a failed read keeps the last counts, and
			// the dashboard says what went wrong.
		}
	}, [workspaceId, accept]);
	useEffect(() => {
		if (!workspaceId) return;
		const poll = () => {
			if (document.hidden) return;
			// The dashboard is reading it more often already.
			if (Date.now() - handed.current < overviewTimings.intervalMs) return;
			void refresh();
		};
		const now = () => {
			if (!document.hidden) void refresh();
		};
		now();
		const timer = setInterval(poll, overviewTimings.intervalMs);
		document.addEventListener("visibilitychange", poll);
		window.addEventListener(CHANGED, now);
		return () => {
			sequence.current++;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", poll);
			window.removeEventListener(CHANGED, now);
		};
	}, [workspaceId, refresh]);
	const set = useCallback(
		(overview: WorkspaceOverview) => {
			handed.current = Date.now();
			accept(overview);
		},
		[accept],
	);
	return {
		overview: loaded.workspaceId === workspaceId ? loaded.overview : null,
		set,
		refresh,
	};
}
