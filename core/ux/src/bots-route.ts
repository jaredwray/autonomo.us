import { currentWorkspaceId } from "./api.js";

/**
 * Bots keeps the open bot in the URL fragment, after the workspace:
 *   #/w/<workspace id>/bots             the list
 *   #/w/<workspace id>/bots/<bot id>    one bot
 */
export type BotsRoute = { id: string | null };

const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function parseBotsRoute(hash: string): BotsRoute {
	const parts = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	return {
		id: parts[0] === "bots" && ID.test(parts[1] ?? "") ? parts[1] : null,
	};
}

export function botsHash(id: string | null): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/bots`
		: "#/bots";
	return id ? `${base}/${encodeURIComponent(id)}` : base;
}
