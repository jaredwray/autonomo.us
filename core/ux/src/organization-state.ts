import { useEffect, useRef, useState } from "react";
import { ApiError, organizationRequest } from "./api.js";

export function orgLink(
	workspace: string,
	view: "organization" | "loops/decisions",
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
	request = organizationRequest,
	live = false,
) {
	const key = JSON.stringify([workspace, path, revision]);
	const lastRead = useRef<string | null>(null);
	const [result, setResult] = useState<{
		key: string;
		data?: T;
		error?: string;
	}>();
	useEffect(() => {
		if (path === null) {
			lastRead.current = null;
			return;
		}
		const controller = new AbortController();
		let pending = false;
		const read = async () => {
			if (pending || controller.signal.aborted || (live && document.hidden))
				return;
			pending = true;
			try {
				const data = await request<T>(workspace, path, {
					signal: controller.signal,
				});
				if (!controller.signal.aborted) {
					lastRead.current = key;
					setResult({ key, data });
				}
			} catch (cause) {
				if (controller.signal.aborted) return;
				lastRead.current = key;
				const inaccessible =
					cause instanceof ApiError && [401, 403, 404].includes(cause.status);
				setResult((previous) =>
					live &&
					!inaccessible &&
					previous?.key === key &&
					previous.data !== undefined
						? previous
						: { key, error: messageFrom(cause) },
				);
			} finally {
				pending = false;
			}
		};
		if (live || lastRead.current !== key) void read();
		if (!live) return () => controller.abort();
		const timer = window.setInterval(read, 30_000);
		window.addEventListener("focus", read);
		document.addEventListener("visibilitychange", read);
		return () => {
			controller.abort();
			window.clearInterval(timer);
			window.removeEventListener("focus", read);
			document.removeEventListener("visibilitychange", read);
		};
	}, [key, workspace, path, request, live]);
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
