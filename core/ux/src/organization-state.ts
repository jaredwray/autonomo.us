import { useEffect, useState } from "react";
import { organizationRequest } from "./api.js";

export function orgLink(
	workspace: string,
	view: "organization" | "decision-inbox",
	resource?: string,
	id?: string,
) {
	const base = `#/w/${encodeURIComponent(workspace)}/${view}`;
	if (!resource) return base;
	return id
		? `${base}/${resource}/${encodeURIComponent(id)}`
		: `${base}/${resource}`;
}

export function routeItem(route: string, kind: string) {
	const [, name, id] = route.split("/");
	if (name !== kind || !id) return null;
	try {
		return decodeURIComponent(id);
	} catch {
		return null;
	}
}

export function queryPath(
	path: string,
	fields: Record<string, string | null | undefined>,
) {
	const query = new URLSearchParams();
	for (const [key, value] of Object.entries(fields))
		if (value) query.set(key, value);
	return query.size ? `${path}?${query}` : path;
}

export function messageFrom(cause: unknown) {
	return cause instanceof Error
		? cause.message
		: "The request could not be completed.";
}

/** Hide old records immediately when the address changes; reject late responses. */
export function useOrgRead<T>(
	workspace: string,
	path: string | null,
	revision = 0,
) {
	const key = JSON.stringify([workspace, path, revision]);
	const [result, setResult] = useState<{
		key: string;
		data?: T;
		error?: string;
	}>();
	useEffect(() => {
		if (!path) return;
		const controller = new AbortController();
		organizationRequest<T>(workspace, path, { signal: controller.signal }).then(
			(data) => {
				if (!controller.signal.aborted) setResult({ key, data });
			},
			(cause) => {
				if (!controller.signal.aborted)
					setResult({ key, error: messageFrom(cause) });
			},
		);
		return () => controller.abort();
	}, [key, workspace, path]);
	return result?.key === key ? result : { key };
}

export function useDebouncedQuery(input: string) {
	const [term, setTerm] = useState(input);
	useEffect(() => {
		const timer = window.setTimeout(() => setTerm(input.trim()), 180);
		return () => window.clearTimeout(timer);
	}, [input]);
	return term;
}
