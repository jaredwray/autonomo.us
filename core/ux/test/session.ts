import { setSessionToken } from "../src/api.js";

export const PASSWORD = "correct horse battery";

/**
 * Completes first-run setup against a real API and, unless `signIn` is false,
 * signs the dashboard in as that owner. Returns the owner's session token.
 */
export async function setUpOwner(
	url: string,
	{
		setupToken,
		signIn = true,
		email = "founder@example.com",
		name = "Founder",
	}: {
		setupToken?: string;
		signIn?: boolean;
		email?: string;
		name?: string;
	} = {},
): Promise<string> {
	const response = await fetch(`${url}/v1/setup`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			...(setupToken ? { authorization: `Bearer ${setupToken}` } : {}),
		},
		body: JSON.stringify({ email, name, password: PASSWORD }),
	});
	if (response.status !== 201)
		throw new Error(`Setup failed: ${await response.text()}`);
	const { token } = (await response.json()) as { token: string };
	if (signIn) setSessionToken(token);
	return token;
}

/** Resources that live under `/v1/:workspace/` (the catalog stays instance-level). */
const WORKSPACE_RESOURCES =
	/^\/v1\/(models(?!\/catalog)|providers|routing|failover|chat|decisions|telemetry|api-tokens|agent-tokens|agents|members|synapse)(?=[/?]|$)/;

/** Rewrites a pre-workspace path (`/v1/models`) to the same resource in a workspace. */
export function inWorkspace(path: string, workspaceId: string): string {
	return path.replace(WORKSPACE_RESOURCES, `/v1/${workspaceId}/$1`);
}

/** The default workspace's id, read through the API the way the dashboard reads it. */
export async function defaultWorkspaceId(
	url: string,
	token: string,
): Promise<string> {
	const response = await fetch(`${url}/v1/workspaces`, {
		headers: { authorization: `Bearer ${token}` },
	});
	if (response.status !== 200)
		throw new Error(`Listing workspaces failed: ${await response.text()}`);
	const { workspaces } = (await response.json()) as {
		workspaces: Array<{ id: string; isDefault: boolean }>;
	};
	const workspace = workspaces.find((item) => item.isDefault);
	if (!workspace) throw new Error("No default workspace.");
	return workspace.id;
}

/** Makes `server.inject` send pre-workspace paths to `workspaceId`. */
export function routeToWorkspace<
	T extends { inject: (...args: never[]) => unknown },
>(server: T, workspaceId: string): T {
	const inject = (server.inject as (options: object) => unknown).bind(server);
	Object.assign(server, {
		inject: (options: string | { url?: string }) => {
			const request = typeof options === "string" ? { url: options } : options;
			return inject(
				request.url
					? { ...request, url: inWorkspace(request.url, workspaceId) }
					: request,
			);
		},
	});
	return server;
}
