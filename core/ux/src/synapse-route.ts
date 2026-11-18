import {
	SYNAPSE_SHARED_SPACE,
	SYNAPSE_SPACE_ID_PATTERN,
} from "@autonomo.us/common";
import { currentWorkspaceId } from "./api.js";

/**
 * Synapse keeps its place in the URL fragment, after the workspace
 * (#/w/<workspace id>/synapse...), so reloads and shared links land on the
 * same space and note:
 *   .../synapse                      shared space, no note
 *   .../synapse/<tab>                a tab other than Notes: capture, ask,
 *                                    commitments, maintenance, or proposals
 *   .../synapse/<space>              a space (shared, global, or agent-<id>)
 *   .../synapse/<space>/<title>      a note (title URL-encoded)
 *
 * Only the segment right after `synapse` names a tab, so a note titled
 * "capture" is still .../synapse/<space>/capture. A tab's address carries no
 * space: the view keeps the space it was showing while the tabs change, and a
 * reload lands on the shared space.
 */
export const SYNAPSE_TAB_IDS = [
	"notes",
	"capture",
	"ask",
	"commitments",
	"maintenance",
	"proposals",
] as const;
export type SynapseTab = (typeof SYNAPSE_TAB_IDS)[number];

export type SynapseRoute = {
	tab: SynapseTab;
	space: string;
	title: string | null;
};

const SPACE_ID = new RegExp(SYNAPSE_SPACE_ID_PATTERN);
const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
};
/** Notes is the tab of a space's own address, so it has no segment. */
const tabOf = (segment: string): SynapseTab | undefined =>
	SYNAPSE_TAB_IDS.find((tab) => tab !== "notes" && tab === segment);

export function parseSynapseRoute(hash: string): SynapseRoute {
	// Inside a workspace: #/w/<workspace id>/synapse/...
	const parts = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	const fallback: SynapseRoute = {
		tab: "notes",
		space: SYNAPSE_SHARED_SPACE,
		title: null,
	};
	if (parts[0] !== "synapse" || !parts[1]) return fallback;
	const tab = tabOf(parts[1]);
	if (tab) return { ...fallback, tab };
	const space = decode(parts[1]);
	if (!SPACE_ID.test(space)) return fallback;
	const rest = parts.slice(2).join("/");
	return { tab: "notes", space, title: rest ? decode(rest) : null };
}

export function synapseHash(route: SynapseRoute): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/synapse`
		: "#/synapse";
	if (route.tab !== "notes") return `${base}/${route.tab}`;
	const space = encodeURIComponent(route.space);
	return route.title
		? `${base}/${space}/${encodeURIComponent(route.title)}`
		: `${base}/${space}`;
}

export const noteHash = (space: string, title: string) =>
	synapseHash({ tab: "notes", space, title });
