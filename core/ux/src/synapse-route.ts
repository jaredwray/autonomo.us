import {
	SYNAPSE_SHARED_SPACE,
	SYNAPSE_SPACE_ID_PATTERN,
} from "@autonomo.us/common";

/**
 * Synapse keeps its place in the URL fragment so reloads and shared links
 * land on the same space and note:
 *   #/synapse                      shared space, no note
 *   #/synapse/proposals            the Proposals tab
 *   #/synapse/<space>              a space
 *   #/synapse/<space>/<title>      a note (title URL-encoded)
 */
export type SynapseRoute = {
	tab: "notes" | "proposals";
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

export function parseSynapseRoute(hash: string): SynapseRoute {
	const parts = hash.replace(/^#\/?/, "").split("/");
	const fallback: SynapseRoute = {
		tab: "notes",
		space: SYNAPSE_SHARED_SPACE,
		title: null,
	};
	if (parts[0] !== "synapse" || !parts[1]) return fallback;
	if (parts[1] === "proposals") return { ...fallback, tab: "proposals" };
	const space = decode(parts[1]);
	if (!SPACE_ID.test(space)) return fallback;
	const rest = parts.slice(2).join("/");
	return { tab: "notes", space, title: rest ? decode(rest) : null };
}

export function synapseHash(route: SynapseRoute): string {
	if (route.tab === "proposals") return "#/synapse/proposals";
	const space = encodeURIComponent(route.space);
	return route.title
		? `#/synapse/${space}/${encodeURIComponent(route.title)}`
		: `#/synapse/${space}`;
}

export const noteHash = (space: string, title: string) =>
	synapseHash({ tab: "notes", space, title });
