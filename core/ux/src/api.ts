/// <reference types="vite/client" />
import type {
	AcceptInviteRequest,
	AddModelRequest,
	AddTeamMemberRequest,
	AgentToken,
	AgentTokenSecret,
	AgentTokenSettings,
	AnalyticsQuery,
	ApiToken,
	ApiTokenSecret,
	ApiTokenSettings,
	AuthSession,
	AuthStatus,
	CreateAgentTokenRequest,
	CreateApiTokenRequest,
	CreateSynapseNoteRequest,
	CreateTeamInviteRequest,
	CreateWorkspaceRequest,
	CurrentSession,
	DecideSynapseProposalRequest,
	FailoverPolicy,
	GatewayResponse,
	InvitePreview,
	ModelInfo,
	ProviderSettings,
	RollAgentTokenRequest,
	RollApiTokenRequest,
	RoutingConfig,
	RoutingSettings,
	SetupRequest,
	SynapseCategory,
	SynapseDaily,
	SynapseExport,
	SynapseImportRequest,
	SynapseImportResult,
	SynapseNote,
	SynapseNoteList,
	SynapseNoteView,
	SynapseProposal,
	SynapseProposalList,
	SynapseProposalStatus,
	SynapseQuery,
	SynapseSpaceList,
	SynapseTemplate,
	SynapseUnresolvedLink,
	TeamInvite,
	TeamInviteSecret,
	TeamMember,
	TeamSettings,
	UpdateAgentTokenRequest,
	UpdateApiTokenRequest,
	UpdateSynapseNoteRequest,
	UpdateTeamMemberRequest,
	UpdateWorkspaceRequest,
	UsageAnalytics,
	WorkspaceDetails,
	WorkspaceList,
	WorkspaceMembers,
	WorkspaceRole,
} from "@autonomo.us/common";

export type SinkStatus = {
	configured: boolean;
	healthy: boolean;
};

export type ProviderInfo = {
	name: string;
	kind: string;
};

function apiBase(): string {
	return import.meta.env?.VITE_API_URL ?? "";
}

/**
 * The workspace the dashboard is showing. Every workspace-scoped call goes to
 * `/v1/<id>/…`; the shell sets it before rendering a workspace view.
 */
let currentWorkspace: string | null = null;
export function setCurrentWorkspace(id: string | null) {
	currentWorkspace = id;
}
export function currentWorkspaceId(): string | null {
	return currentWorkspace;
}
function ws(path: string): string {
	if (!currentWorkspace) throw new Error("Choose a workspace first.");
	return `/v1/${encodeURIComponent(currentWorkspace)}${path}`;
}

/**
 * A team member's session is revocable and expires, so it is kept in
 * localStorage to survive reloads; signing out deletes it on the server and
 * in the browser. A SETUP_TOKEN, used only during first-run setup, stays in
 * this tab's memory.
 */
const SESSION_KEY = "autonomous.session";
type Credential = { kind: "setup" | "session"; value: string };
let credential: Credential | null | undefined;
function current(): Credential | null {
	if (credential === undefined) {
		credential = null;
		try {
			const value = window.localStorage.getItem(SESSION_KEY);
			if (value) credential = { kind: "session", value };
		} catch {}
	}
	return credential;
}
export function clearCredential() {
	credential = null;
	try {
		window.localStorage.removeItem(SESSION_KEY);
	} catch {}
}
export function credentialKind(): Credential["kind"] | null {
	return current()?.kind ?? null;
}
export function setSessionToken(token: string) {
	credential = { kind: "session", value: token };
	try {
		window.localStorage.setItem(SESSION_KEY, token);
	} catch {}
}
export async function verifySetupToken(value: string) {
	const response = await fetch(`${apiBase()}/v1/setup/token`, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${value}`,
		},
	});
	if (!response.ok)
		throw new Error(
			response.status === 401
				? "Enter the SETUP_TOKEN configured on the API."
				: await errorMessage(
						response,
						"Could not reach the API. Please retry.",
					),
		);
	clearCredential();
	credential = { kind: "setup", value };
}
function authorize(headers: Headers) {
	const active = current();
	if (active) headers.set("authorization", `Bearer ${active.value}`);
	return active;
}
async function apiFetch(path: string, options: RequestInit = {}) {
	const headers = new Headers(options.headers);
	const active = authorize(headers);
	const response = await fetch(path, { ...options, headers });
	if (response.status === 401 && active === credential) {
		clearCredential();
		window.dispatchEvent(new Event("autonomous:authentication-required"));
	}
	return response;
}

async function errorMessage(response: Response, fallback: string) {
	try {
		const body = await response.json();
		return body.error?.message ?? body.message ?? fallback;
	} catch {
		return fallback;
	}
}

/** Sign-in calls report errors inline instead of resetting the dashboard. */
async function authRequest<T>(
	path: string,
	method: string,
	body?: unknown,
): Promise<T> {
	const headers = new Headers({ accept: "application/json" });
	if (body !== undefined) headers.set("content-type", "application/json");
	authorize(headers);
	const response = await fetch(`${apiBase()}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(
			await errorMessage(response, `Request failed (${response.status})`),
		);
	return (response.status === 204 ? undefined : await response.json()) as T;
}

export async function fetchAuthStatus(): Promise<AuthStatus> {
	const response = await fetch(`${apiBase()}/v1/auth/status`, {
		headers: { accept: "application/json" },
	});
	if (!response.ok)
		throw new Error(
			await errorMessage(
				response,
				`The gateway did not respond (${response.status}).`,
			),
		);
	return response.json();
}
export async function completeSetup(input: SetupRequest) {
	const session = await authRequest<AuthSession>("/v1/setup", "POST", input);
	setSessionToken(session.token);
	return session;
}
export async function signIn(email: string, password: string) {
	const session = await authRequest<AuthSession>("/v1/auth/session", "POST", {
		email,
		password,
	});
	setSessionToken(session.token);
	return session;
}
export function previewInvite(token: string) {
	return authRequest<InvitePreview>("/v1/invites/preview", "POST", { token });
}
export async function acceptInvite(input: AcceptInviteRequest) {
	const session = await authRequest<AuthSession>(
		"/v1/invites/accept",
		"POST",
		input,
	);
	setSessionToken(session.token);
	return session;
}
export function changePassword(currentPassword: string, newPassword: string) {
	return authRequest<void>("/v1/auth/password", "PUT", {
		currentPassword,
		newPassword,
	});
}
export function fetchCurrentSession(): Promise<CurrentSession> {
	return getJson("/v1/auth/session");
}
/** Ends the session on the server when possible; the browser forgets it either way. */
export async function signOut() {
	if (current()?.kind === "session")
		await authRequest("/v1/auth/session", "DELETE").catch(() => {});
	clearCredential();
}

async function getJson<T>(path: string): Promise<T> {
	const response = await apiFetch(`${apiBase()}${path}`, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`GET ${path} failed with ${response.status}`);
	}
	return (await response.json()) as T;
}

export type ModelsData = {
	models: ModelInfo[];
	providers: ProviderInfo[];
};

export type ModelCatalog = {
	providers: Record<
		string,
		{
			name: string;
			models: Array<{ id: string; name: string }>;
		}
	>;
};

export function fetchModels(): Promise<ModelsData> {
	return getJson<ModelsData>(ws("/models"));
}

export function fetchProviderSettings(): Promise<ProviderSettings> {
	return getJson<ProviderSettings>(ws("/providers"));
}

export function fetchModelCatalog(): Promise<ModelCatalog> {
	return getJson<ModelCatalog>("/v1/models/catalog");
}

export async function addModel(input: AddModelRequest): Promise<ModelInfo> {
	const response = await apiFetch(`${apiBase()}${ws("/models")}`, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(input),
	});
	if (!response.ok) {
		let message = "Could not add the model. Please try again.";
		try {
			const body = await response.json();
			message =
				typeof body.error?.message === "string" ? body.error.message : message;
		} catch {}
		throw new Error(message);
	}
	return response.json();
}

export async function fetchFailoverPolicy(): Promise<FailoverPolicy> {
	return getJson<FailoverPolicy>(ws("/failover"));
}

export function fetchRouting(): Promise<RoutingSettings> {
	return getJson<RoutingSettings>(ws("/routing"));
}

async function postJson<T>(
	path: string,
	method: string,
	body: unknown,
): Promise<T> {
	const response = await apiFetch(`${apiBase()}${path}`, {
		method,
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok)
		throw new Error(
			await errorMessage(response, `Request failed (${response.status})`),
		);
	return (await response.json()) as T;
}

export function updateRouting(config: RoutingConfig): Promise<RoutingSettings> {
	return postJson(ws("/routing"), "PUT", config);
}

export function sendChat(
	model: string,
	content: string,
): Promise<GatewayResponse> {
	return postJson(ws("/chat"), "POST", {
		model,
		messages: [{ role: "user", content }],
	});
}

export async function updateFailoverPolicy(
	policy: FailoverPolicy,
): Promise<FailoverPolicy> {
	const response = await apiFetch(`${apiBase()}${ws("/failover")}`, {
		method: "PUT",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(policy),
	});
	if (!response.ok) {
		// Surface the API's own message (e.g. which target is unknown).
		let message = `PUT failover failed with ${response.status}`;
		try {
			const body = (await response.json()) as {
				error?: { message?: string };
			};
			message = body.error?.message ?? message;
		} catch {}
		throw new Error(message);
	}
	return (await response.json()) as FailoverPolicy;
}

export async function fetchDashboardData(
	query: AnalyticsQuery,
	signal?: AbortSignal,
): Promise<UsageAnalytics> {
	const params = new URLSearchParams();
	for (const [key, value] of Object.entries(query))
		if (value) params.set(key, value);
	const response = await apiFetch(
		`${apiBase()}${ws("/telemetry/analytics")}?${params}`,
		{
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(15000)])
				: AbortSignal.timeout(15000),
			headers: { accept: "application/json" },
		},
	);
	if (!response.ok)
		throw new Error(`Analytics request failed (${response.status})`);
	return response.json();
}

export function fetchApiTokens(): Promise<ApiTokenSettings> {
	return getJson(ws("/api-tokens"));
}
export function createApiToken(
	input: CreateApiTokenRequest,
): Promise<ApiTokenSecret> {
	return postJson(ws("/api-tokens"), "POST", input);
}
export function updateApiToken(
	id: string,
	input: UpdateApiTokenRequest,
): Promise<ApiToken> {
	return postJson(ws(`/api-tokens/${encodeURIComponent(id)}`), "PATCH", input);
}
export function rollApiToken(
	id: string,
	input: RollApiTokenRequest,
): Promise<ApiTokenSecret> {
	return postJson(
		ws(`/api-tokens/${encodeURIComponent(id)}/roll`),
		"POST",
		input,
	);
}
export function revokeApiToken(id: string): Promise<ApiToken> {
	return postJson(ws(`/api-tokens/${encodeURIComponent(id)}`), "DELETE", {});
}

export function fetchAgentTokens(): Promise<AgentTokenSettings> {
	return getJson(ws("/agent-tokens"));
}
export function createAgentToken(
	input: CreateAgentTokenRequest,
): Promise<AgentTokenSecret> {
	return postJson(ws("/agent-tokens"), "POST", input);
}
export function updateAgentToken(
	id: string,
	input: UpdateAgentTokenRequest,
): Promise<AgentToken> {
	return postJson(
		ws(`/agent-tokens/${encodeURIComponent(id)}`),
		"PATCH",
		input,
	);
}
export function rollAgentToken(
	id: string,
	input: RollAgentTokenRequest,
): Promise<AgentTokenSecret> {
	return postJson(
		ws(`/agent-tokens/${encodeURIComponent(id)}/roll`),
		"POST",
		input,
	);
}
export function revokeAgentToken(id: string): Promise<AgentToken> {
	return postJson(ws(`/agent-tokens/${encodeURIComponent(id)}`), "DELETE", {});
}

export function fetchTeam(): Promise<TeamSettings> {
	return getJson("/v1/team");
}
export function addTeamMember(
	input: AddTeamMemberRequest,
): Promise<TeamMember> {
	return postJson("/v1/team", "POST", input);
}
export function updateTeamMember(
	id: string,
	input: UpdateTeamMemberRequest,
): Promise<TeamMember> {
	return postJson(`/v1/team/${encodeURIComponent(id)}`, "PATCH", input);
}
export async function resetTeamPassword(id: string, password: string) {
	return postJson<TeamMember>(
		`/v1/team/${encodeURIComponent(id)}/password`,
		"PUT",
		{ password },
	);
}
export function createTeamInvite(
	input: CreateTeamInviteRequest,
): Promise<TeamInviteSecret> {
	return postJson("/v1/team/invites", "POST", input);
}
export function revokeTeamInvite(id: string): Promise<TeamInvite> {
	return postJson(`/v1/team/invites/${encodeURIComponent(id)}`, "DELETE", {});
}
export function removeTeamMember(id: string): Promise<TeamMember> {
	return postJson(`/v1/team/${encodeURIComponent(id)}`, "DELETE", {});
}

export function fetchWorkspaces(): Promise<WorkspaceList> {
	return getJson("/v1/workspaces");
}
export function createWorkspace(
	input: CreateWorkspaceRequest,
): Promise<WorkspaceDetails> {
	return postJson("/v1/workspaces", "POST", input);
}
export function fetchWorkspace(id: string): Promise<WorkspaceDetails> {
	return getJson(`/v1/workspaces/${encodeURIComponent(id)}`);
}
export function updateWorkspace(
	id: string,
	input: UpdateWorkspaceRequest,
): Promise<WorkspaceDetails> {
	return postJson(`/v1/workspaces/${encodeURIComponent(id)}`, "PATCH", input);
}
export function setWorkspaceArchived(
	id: string,
	archived: boolean,
): Promise<WorkspaceDetails> {
	return postJson(
		`/v1/workspaces/${encodeURIComponent(id)}/${archived ? "archive" : "unarchive"}`,
		"POST",
		{},
	);
}
export function fetchWorkspaceMembers(id: string): Promise<WorkspaceMembers> {
	return getJson(`/v1/${encodeURIComponent(id)}/members`);
}
export function setWorkspaceMember(
	id: string,
	userId: string,
	role: WorkspaceRole,
): Promise<WorkspaceMembers> {
	return postJson(
		`/v1/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
		"PUT",
		{ role },
	);
}
export function removeWorkspaceMember(
	id: string,
	userId: string,
): Promise<WorkspaceMembers> {
	return postJson(
		`/v1/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
		"DELETE",
		{},
	);
}
/** A failed request whose HTTP status matters to the caller (404, 409). */
export class ApiError extends Error {
	readonly status: number;
	constructor(message: string, status: number) {
		super(message);
		this.name = "ApiError";
		this.status = status;
	}
}
async function synapseRequest<T>(
	path: string,
	{ method = "GET", body }: { method?: string; body?: unknown } = {},
): Promise<T> {
	const headers = new Headers({ accept: "application/json" });
	if (body !== undefined) headers.set("content-type", "application/json");
	const response = await apiFetch(`${apiBase()}${path}`, {
		method,
		headers,
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	if (!response.ok)
		throw new ApiError(
			await errorMessage(response, `Request failed (${response.status})`),
			response.status,
		);
	return (response.status === 204 ? undefined : await response.json()) as T;
}
const spacePath = (space: string) =>
	ws(`/synapse/spaces/${encodeURIComponent(space)}`);
const notePath = (space: string, title: string) =>
	`${spacePath(space)}/notes/${encodeURIComponent(title)}`;

export function fetchSynapseSpaces(): Promise<SynapseSpaceList> {
	return synapseRequest(ws("/synapse/spaces"));
}
export function fetchSynapseTemplates(): Promise<{
	templates: SynapseTemplate[];
}> {
	return synapseRequest(ws("/synapse/templates"));
}
export function fetchSynapseNotes(
	space: string,
	query: SynapseQuery = {},
): Promise<SynapseNoteList> {
	const params = new URLSearchParams();
	const { where, ...rest } = query;
	for (const [key, value] of Object.entries(rest))
		if (value !== undefined && value !== "") params.set(key, String(value));
	for (const [key, value] of Object.entries(where ?? {}))
		params.set(`where.${key}`, String(value));
	const search = params.toString();
	return synapseRequest(
		`${spacePath(space)}/notes${search ? `?${search}` : ""}`,
	);
}
export function createSynapseNote(
	space: string,
	input: CreateSynapseNoteRequest,
): Promise<SynapseNote> {
	return synapseRequest(`${spacePath(space)}/notes`, {
		method: "POST",
		body: input,
	});
}
export function fetchSynapseNote(
	space: string,
	title: string,
): Promise<SynapseNoteView> {
	return synapseRequest(notePath(space, title));
}
export function updateSynapseNote(
	space: string,
	title: string,
	input: UpdateSynapseNoteRequest,
): Promise<SynapseNote> {
	return synapseRequest(notePath(space, title), {
		method: "PATCH",
		body: input,
	});
}
export function appendSynapseNote(
	space: string,
	title: string,
	text: string,
	template?: string,
): Promise<SynapseNote> {
	return synapseRequest(`${notePath(space, title)}/append`, {
		method: "POST",
		body: { text, template },
	});
}
/** With `revision`, only that revision is deleted; a newer one answers 409. */
export function deleteSynapseNote(
	space: string,
	title: string,
	revision?: number,
): Promise<void> {
	const query = revision === undefined ? "" : `?revision=${revision}`;
	return synapseRequest(`${notePath(space, title)}${query}`, {
		method: "DELETE",
	});
}
export function fetchSynapseUnresolved(
	space: string,
): Promise<{ links: SynapseUnresolvedLink[] }> {
	return synapseRequest(`${spacePath(space)}/unresolved`);
}
export function fetchSynapseCategories(
	space: string,
): Promise<{ categories: SynapseCategory[] }> {
	return synapseRequest(`${spacePath(space)}/categories`);
}
export function fetchSynapseDaily(
	space: string,
	date: string,
): Promise<SynapseDaily> {
	return synapseRequest(
		`${spacePath(space)}/daily/${encodeURIComponent(date)}`,
	);
}
export function fetchSynapseExport(space: string): Promise<SynapseExport> {
	return synapseRequest(`${spacePath(space)}/export`);
}
/** The space as an Obsidian-compatible zip, fetched with the session credential. */
export async function fetchSynapseExportZip(space: string): Promise<Blob> {
	const response = await apiFetch(
		`${apiBase()}${spacePath(space)}/export?format=zip`,
		{
			headers: { accept: "application/zip" },
		},
	);
	if (!response.ok)
		throw new ApiError(
			await errorMessage(response, `Export failed (${response.status})`),
			response.status,
		);
	return response.blob();
}
export function importSynapseNotes(
	space: string,
	input: SynapseImportRequest,
): Promise<SynapseImportResult> {
	return synapseRequest(`${spacePath(space)}/import`, {
		method: "POST",
		body: input,
	});
}
export function fetchSynapseProposals(
	status?: SynapseProposalStatus,
): Promise<SynapseProposalList> {
	return synapseRequest(
		ws(
			`/synapse/proposals${status ? `?status=${encodeURIComponent(status)}` : ""}`,
		),
	);
}
export function decideSynapseProposal(
	id: string,
	input: DecideSynapseProposalRequest,
): Promise<SynapseProposal> {
	return synapseRequest(
		ws(`/synapse/proposals/${encodeURIComponent(id)}/decide`),
		{
			method: "POST",
			body: input,
		},
	);
}
