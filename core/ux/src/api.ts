/// <reference types="vite/client" />
import type {
	ModelInfo,
	TelemetryEvent,
	UsageSummary,
} from "@autonomo.us/common";

export type SinkStatus = {
	configured: boolean;
	healthy: boolean;
};

export type DashboardData = {
	summary: UsageSummary;
	events: TelemetryEvent[];
	models: ModelInfo[];
	sink: SinkStatus;
};

const API_BASE: string = import.meta.env?.VITE_API_URL ?? "";

async function getJson<T>(path: string): Promise<T> {
	const response = await fetch(`${API_BASE}${path}`, {
		headers: { accept: "application/json" },
	});
	if (!response.ok) {
		throw new Error(`GET ${path} failed with ${response.status}`);
	}
	return (await response.json()) as T;
}

export async function fetchDashboardData(): Promise<DashboardData> {
	const [summary, eventsPayload, modelsPayload] = await Promise.all([
		getJson<UsageSummary>("/v1/telemetry/summary"),
		getJson<{ events: TelemetryEvent[]; sink: SinkStatus }>(
			"/v1/telemetry/events?limit=25",
		),
		getJson<{ models: ModelInfo[] }>("/v1/models"),
	]);

	return {
		summary,
		events: eventsPayload.events,
		sink: eventsPayload.sink,
		models: modelsPayload.models,
	};
}
