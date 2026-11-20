import { currentWorkspaceId } from "./api.js";

/**
 * Models keeps its tab in the URL fragment, after the workspace, so reloads
 * and shared links land on the same tab:
 *   #/w/<workspace id>/models            the LLM tab
 *   #/w/<workspace id>/models/video      the Video tab
 *   #/w/<workspace id>/models/budget     the Budget tab
 *   #/w/<workspace id>/models/routing    the Routing tab
 * Routing and Video were views of their own before they became tabs, so
 * #/routing, #/video and their workspace forms open those tabs too.
 */
export const MODELS_TABS = ["llm", "video", "budget", "routing"] as const;
export type ModelsTab = (typeof MODELS_TABS)[number];

export function parseModelsTab(hash: string): ModelsTab {
	const [view, tab] = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	if (view === "routing") return "routing";
	if (view === "video") return "video";
	if (view !== "models") return "llm";
	return tab === "video" || tab === "budget" || tab === "routing" ? tab : "llm";
}

export function modelsHash(tab: ModelsTab): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/models`
		: "#/models";
	return tab === "llm" ? base : `${base}/${tab}`;
}
