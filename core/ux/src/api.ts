/// <reference types="vite/client" />
import type {
	AddModelRequest,
	AgentToken,
	AgentTokenSecret,
	AgentTokenSettings,
	AnalyticsQuery,
	ApiToken,
	ApiTokenSecret,
	ApiTokenSettings,
	CreateAgentTokenRequest,
	CreateApiTokenRequest,
	FailoverPolicy,
	GatewayResponse,
	ModelInfo,
	ProviderSettings,
	RollAgentTokenRequest,
	RollApiTokenRequest,
	RoutingConfig,
	RoutingSettings,
	UpdateAgentTokenRequest,
	UpdateApiTokenRequest,
	UsageAnalytics,
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

// Credentials live only in this tab's memory, never in browser storage or a build.
let ownerCredential = "";
export function clearOwnerCredential() {
	ownerCredential = "";
}
export function hasOwnerCredential() {
	return Boolean(ownerCredential);
}
export async function connectOwner(credential: string) {
	const response = await fetch(`${apiBase()}/v1/auth/owner`, {
		headers: {
			accept: "application/json",
			authorization: `Bearer ${credential}`,
		},
	});
	if (!response.ok)
		throw new Error(
			response.status === 401 || response.status === 403
				? "Enter a valid owner credential."
				: "Could not connect to the API. Please retry.",
		);
	ownerCredential = credential;
}
async function apiFetch(path: string, options: RequestInit = {}) {
	const headers = new Headers(options.headers);
	const credential = ownerCredential;
	if (credential) headers.set("authorization", `Bearer ${credential}`);
	const response = await fetch(path, { ...options, headers });
	if (response.status === 401 && credential === ownerCredential)
		window.dispatchEvent(new Event("autonomous:authentication-required"));
	return response;
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
	return getJson<ModelsData>("/v1/models");
}

export function fetchProviderSettings(): Promise<ProviderSettings> {
	return getJson<ProviderSettings>("/v1/providers");
}

export function fetchModelCatalog(): Promise<ModelCatalog> {
	return getJson<ModelCatalog>("/v1/models/catalog");
}

export async function addModel(input: AddModelRequest): Promise<ModelInfo> {
	const response = await apiFetch(`${apiBase()}/v1/models`, {
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
	return getJson<FailoverPolicy>("/v1/failover");
}

export function fetchRouting(): Promise<RoutingSettings> {
	return getJson<RoutingSettings>("/v1/routing");
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
	const result = await response.json();
	if (!response.ok)
		throw new Error(
			result.error?.message ??
				result.message ??
				`Request failed (${response.status})`,
		);
	return result as T;
}

export function updateRouting(config: RoutingConfig): Promise<RoutingSettings> {
	return postJson("/v1/routing", "PUT", config);
}

export function sendChat(
	model: string,
	content: string,
): Promise<GatewayResponse> {
	return postJson("/v1/chat", "POST", {
		model,
		messages: [{ role: "user", content }],
	});
}

export async function updateFailoverPolicy(
	policy: FailoverPolicy,
): Promise<FailoverPolicy> {
	const response = await apiFetch(`${apiBase()}/v1/failover`, {
		method: "PUT",
		headers: { "content-type": "application/json", accept: "application/json" },
		body: JSON.stringify(policy),
	});
	if (!response.ok) {
		// Surface the API's own message (e.g. which target is unknown).
		let message = `PUT /v1/failover failed with ${response.status}`;
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
		`${apiBase()}/v1/telemetry/analytics?${params}`,
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
	return getJson("/v1/api-tokens");
}
export function createApiToken(
	input: CreateApiTokenRequest,
): Promise<ApiTokenSecret> {
	return postJson("/v1/api-tokens", "POST", input);
}
export function updateApiToken(
	id: string,
	input: UpdateApiTokenRequest,
): Promise<ApiToken> {
	return postJson(`/v1/api-tokens/${encodeURIComponent(id)}`, "PATCH", input);
}
export function rollApiToken(
	id: string,
	input: RollApiTokenRequest,
): Promise<ApiTokenSecret> {
	return postJson(
		`/v1/api-tokens/${encodeURIComponent(id)}/roll`,
		"POST",
		input,
	);
}
export function revokeApiToken(id: string): Promise<ApiToken> {
	return postJson(`/v1/api-tokens/${encodeURIComponent(id)}`, "DELETE", {});
}

export function fetchAgentTokens(): Promise<AgentTokenSettings> {
	return getJson("/v1/agent-tokens");
}
export function createAgentToken(
	input: CreateAgentTokenRequest,
): Promise<AgentTokenSecret> {
	return postJson("/v1/agent-tokens", "POST", input);
}
export function updateAgentToken(
	id: string,
	input: UpdateAgentTokenRequest,
): Promise<AgentToken> {
	return postJson(`/v1/agent-tokens/${encodeURIComponent(id)}`, "PATCH", input);
}
export function rollAgentToken(
	id: string,
	input: RollAgentTokenRequest,
): Promise<AgentTokenSecret> {
	return postJson(
		`/v1/agent-tokens/${encodeURIComponent(id)}/roll`,
		"POST",
		input,
	);
}
export function revokeAgentToken(id: string): Promise<AgentToken> {
	return postJson(`/v1/agent-tokens/${encodeURIComponent(id)}`, "DELETE", {});
}
