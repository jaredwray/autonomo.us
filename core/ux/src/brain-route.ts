import {
	BRAIN_SHARED_VAULT,
	BRAIN_VAULT_ID_PATTERN,
} from "@autonomo.us/common";

/**
 * The Brain keeps its place in the URL fragment so reloads and shared links
 * land on the same vault and note:
 *   #/brain                      shared vault, no note
 *   #/brain/proposals            the Proposals tab
 *   #/brain/<vault>              a vault
 *   #/brain/<vault>/<title>      a note (title URL-encoded)
 */
export type BrainRoute = {
	tab: "notes" | "proposals";
	vault: string;
	title: string | null;
};

const VAULT_ID = new RegExp(BRAIN_VAULT_ID_PATTERN);
const decode = (part: string) => {
	try {
		return decodeURIComponent(part);
	} catch {
		return part;
	}
};

export function parseBrainRoute(hash: string): BrainRoute {
	const parts = hash.replace(/^#\/?/, "").split("/");
	const fallback: BrainRoute = {
		tab: "notes",
		vault: BRAIN_SHARED_VAULT,
		title: null,
	};
	if (parts[0] !== "brain" || !parts[1]) return fallback;
	if (parts[1] === "proposals") return { ...fallback, tab: "proposals" };
	const vault = decode(parts[1]);
	if (!VAULT_ID.test(vault)) return fallback;
	const rest = parts.slice(2).join("/");
	return { tab: "notes", vault, title: rest ? decode(rest) : null };
}

export function brainHash(route: BrainRoute): string {
	if (route.tab === "proposals") return "#/brain/proposals";
	const vault = encodeURIComponent(route.vault);
	return route.title
		? `#/brain/${vault}/${encodeURIComponent(route.title)}`
		: `#/brain/${vault}`;
}

export const noteHash = (vault: string, title: string) =>
	brainHash({ tab: "notes", vault, title });
