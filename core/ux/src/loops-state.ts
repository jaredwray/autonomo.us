import { loopsRequest } from "./api.js";
import { useOrgRead } from "./organization-state.js";

export function loopLink(workspace: string, ...segments: string[]) {
	return [
		`#/w/${encodeURIComponent(workspace)}/loops`,
		...segments.map(encodeURIComponent),
	].join("/");
}

export function useLoopRead<T>(
	workspace: string,
	path: string | null,
	revision: number,
	live = false,
) {
	return useOrgRead<T>(workspace, path, revision, loopsRequest, live);
}

export const percentNumber = new Intl.NumberFormat(undefined, {
	maximumFractionDigits: 2,
});
export const countNumber = new Intl.NumberFormat();

export function observedTime(timestamp: string) {
	return new Date(timestamp).toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	});
}
