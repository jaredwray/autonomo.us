import { CHANNEL_NAME_PATTERN } from "@autonomo.us/common";
import { currentWorkspaceId } from "./api.js";

/**
 * Channels keeps the open channel in the URL fragment, after the workspace
 * (#/w/<workspace id>/channels...), so reloads and shared links land on it:
 *   .../channels            the first channel
 *   .../channels/<name>     a channel, by its name
 */
export type ChannelsRoute = { name: string | null };

const NAME = new RegExp(CHANNEL_NAME_PATTERN);
/**
 * The same rule for an input's `pattern`, which browsers compile with the `v`
 * flag: there a hyphen inside a class must be escaped, and no anchors are used.
 */
export const CHANNEL_NAME_INPUT_PATTERN = "[a-z0-9][a-z0-9_\\-]{0,79}";

export function parseChannelsRoute(hash: string): ChannelsRoute {
	const parts = hash
		.replace(/^#\/?/, "")
		.replace(/^w\/[^/]+\//, "")
		.split("/");
	if (parts[0] !== "channels" || !parts[1]) return { name: null };
	let name = parts[1];
	try {
		name = decodeURIComponent(name);
	} catch {}
	name = name.toLowerCase();
	return { name: NAME.test(name) ? name : null };
}

export function channelsHash(name: string | null): string {
	const workspace = currentWorkspaceId();
	const base = workspace
		? `#/w/${encodeURIComponent(workspace)}/channels`
		: "#/channels";
	return name ? `${base}/${encodeURIComponent(name)}` : base;
}
