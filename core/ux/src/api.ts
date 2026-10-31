/// <reference types="vite/client" />
import type {
	AddModelRequest,
	FailoverPolicy,
	GatewayResponse,
	ModelInfo,
	ProviderSettings,
	RoutingConfig,
	RoutingSettings,
	TelemetryEvent,
	UsageSummary,
} from "@autonomo.us/common";

export type SinkStatus = {
	configured: boolean;
	healthy: boolean;
};

export type ProviderInfo = {
	name: string;
	kind: string;
};

export type DashboardData = {
	summary: UsageSummary;
	events: TelemetryEvent[];
	models: ModelInfo[];
	providers: ProviderInfo[];
	sink: SinkStatus;
};

function apiBase(): string {
	return import.meta.env?.VITE_API_URL ?? "";
}

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(`${apiBase()}${path}`, {
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
	const response = await fetch(`${apiBase()}/v1/models`, {
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
	const response = await fetch(`${apiBase()}${path}`, {
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
	const response = await fetch(`${apiBase()}/v1/failover`, {
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

export async function fetchDashboardData(): Promise<DashboardData> {
	const [summary, eventsPayload, modelsPayload] = await Promise.all([
		getJson<UsageSummary>("/v1/telemetry/summary"),
		getJson<{ events: TelemetryEvent[]; sink: SinkStatus }>(
			"/v1/telemetry/events?limit=25",
		),
		getJson<{ models: ModelInfo[]; providers: ProviderInfo[] }>("/v1/models"),
	]);

	return {
		summary,
		events: eventsPayload.events,
		sink: eventsPayload.sink,
		models: modelsPayload.models,
		providers: modelsPayload.providers,
	};
}
