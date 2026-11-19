import { currentWorkspaceId } from "./api.js";

/**
 * Video keeps its tab in the URL fragment, after the workspace, so reloads
 * and shared links land on the same tab:
 *   #/w/<workspace id>/video            the Videos tab
 *   #/w/<workspace id>/video/settings   the Settings tab
 */
export type VideoTab = "videos" | "settings";

export function parseVideoTab(hash: string): VideoTab {
	const [view, tab] = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	return view === "video" && tab === "settings" ? "settings" : "videos";
}

export function videoHash(tab: VideoTab): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/video`
		: "#/video";
	return tab === "settings" ? `${base}/settings` : base;
}
