import { currentWorkspaceId } from "./api.js";

/**
 * Agents keeps the open agent in the URL fragment, after the workspace:
 *   #/w/<workspace id>/agents               the list
 *   #/w/<workspace id>/agents/<agent id>    one agent
 * A link from before the views were merged (`.../bots/<id>`) names the same
 * agent.
 */
export type AgentsRoute = { id: string | null };

const ID = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;

export function parseAgentsRoute(hash: string): AgentsRoute {
	const parts = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	return {
		id:
			(parts[0] === "agents" || parts[0] === "bots") && ID.test(parts[1] ?? "")
				? parts[1].toLowerCase()
				: null,
	};
}

export function agentsHash(id: string | null): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/agents`
		: "#/agents";
	return id ? `${base}/${encodeURIComponent(id)}` : base;
}

/** The fragment of an app's sign-in that waits for a decision, or null. */
export function signInRequestId(hash: string): string | null {
	return /^#\/authorize\/([A-Za-z0-9_-]{43})$/.exec(hash)?.[1] ?? null;
}
