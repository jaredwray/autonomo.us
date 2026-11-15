import { currentWorkspaceId } from "./api.js";

/**
 * Models keeps its tab in the URL fragment, after the workspace, so reloads
 * and shared links land on the same tab:
 *   #/w/<workspace id>/models            the Models tab
 *   #/w/<workspace id>/models/routing    the Routing tab
 * Routing was a view of its own before it became a tab, so #/routing and
 * #/w/<workspace id>/routing open the Routing tab too.
 */
export type ModelsTab = "models" | "routing";

export function parseModelsTab(hash: string): ModelsTab {
	const [view, tab] = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	return view === "routing" || (view === "models" && tab === "routing")
		? "routing"
		: "models";
}

export function modelsHash(tab: ModelsTab): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/models`
		: "#/models";
	return tab === "routing" ? `${base}/routing` : base;
}
