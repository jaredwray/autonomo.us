import type { WorkspaceOverview } from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { currentWorkspaceId, fetchWorkspaceOverview } from "./api.js";

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
 * reads its own, for its period, and hands each answer back with `set`.
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
	const refresh = useCallback(async () => {
		// The shell sets the workspace while rendering; a timer can fire between
		// that and this effect's cleanup.
		if (!workspaceId || currentWorkspaceId() !== workspaceId) return;
		const request = ++sequence.current;
		try {
			const overview = await fetchWorkspaceOverview();
			if (request === sequence.current) setLoaded({ workspaceId, overview });
		} catch {
			// Badges are a convenience: a failed read keeps the last counts, and
			// the dashboard says what went wrong.
		}
	}, [workspaceId]);
	useEffect(() => {
		if (!workspaceId) return;
		const visible = () => {
			if (!document.hidden) void refresh();
		};
		visible();
		const timer = setInterval(visible, overviewTimings.intervalMs);
		document.addEventListener("visibilitychange", visible);
		window.addEventListener(CHANGED, visible);
		return () => {
			sequence.current++;
			clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
			window.removeEventListener(CHANGED, visible);
		};
	}, [workspaceId, refresh]);
	const set = useCallback(
		(overview: WorkspaceOverview) => {
			// A newer answer replaces any read still on its way.
			sequence.current++;
			setLoaded({ workspaceId, overview });
		},
		[workspaceId],
	);
	return {
		overview: loaded.workspaceId === workspaceId ? loaded.overview : null,
		set,
		refresh,
	};
}
