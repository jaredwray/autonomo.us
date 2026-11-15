import { currentWorkspaceId } from "./api.js";

/**
 * The dashboard keeps its tab in the URL fragment, after the workspace, so
 * reloads and shared links land on the same tab:
 *   #/w/<workspace id>/dashboard          Overview: what needs you, agents, spend
 *   #/w/<workspace id>/dashboard/usage    Usage: model and web analytics
 */
export type DashboardTab = "overview" | "usage";

export function parseDashboardTab(hash: string): DashboardTab {
	const [view, tab] = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	return view === "dashboard" && tab === "usage" ? "usage" : "overview";
}

export function dashboardHash(tab: DashboardTab): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/dashboard`
		: "#/dashboard";
	return tab === "usage" ? `${base}/usage` : base;
}
