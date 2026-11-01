import type { AnalyticsQuery } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { DAY_MS } from "../telemetry/analytics.js";
import type { TelemetryService } from "../telemetry/telemetry.js";

export type TelemetryRouteOptions = {
	telemetry: TelemetryService;
};

export async function telemetryRoutes(
	server: FastifyInstance,
	options: TelemetryRouteOptions,
) {
	const { telemetry } = options;

	server.get<{ Querystring: AnalyticsQuery }>(
		"/v1/telemetry/analytics",
		{
			schema: {
				querystring: {
					type: "object",
					additionalProperties: false,
					required: ["from", "to"],
					properties: {
						from: { type: "string", format: "date-time" },
						to: { type: "string", format: "date-time" },
						model: { type: "string", minLength: 1, maxLength: 512 },
						provider: { type: "string", minLength: 1, maxLength: 256 },
						caller: { type: "string", minLength: 1, maxLength: 512 },
					},
				},
			},
		},
		async (request, reply) => {
			const from = Date.parse(request.query.from);
			const to = Date.parse(request.query.to);
			if (
				!Number.isFinite(from) ||
				!Number.isFinite(to) ||
				from >= to ||
				to - from > 90 * DAY_MS
			)
				return reply.code(400).send({
					error: { message: "Choose a valid time range of up to 90 days." },
				});
			reply.header("cache-control", "no-store");
			return telemetry.analytics({
				...request.query,
				from: new Date(from).toISOString(),
				to: new Date(to).toISOString(),
			});
		},
	);

	server.get(
		"/v1/telemetry/summary",
		{
			schema: {
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { enum: ["auto", "memory", "clickhouse"] },
					},
				},
			},
		},
		async (request, reply) => {
			const { source = "auto" } = request.query as {
				source?: "auto" | "memory" | "clickhouse";
			};

			if (source === "clickhouse") {
				const summary = await telemetry.summaryFromSink();
				if (!summary) {
					return reply.status(503).send({
						error: {
							type: "clickhouse_unavailable",
							message:
								"ClickHouse is not configured or not reachable. Set CLICKHOUSE_URL and start docker-compose.",
						},
					});
				}
				return summary;
			}

			if (source === "auto") {
				const summary = await telemetry.summaryFromSink();
				if (summary) return summary;
			}

			return telemetry.summary();
		},
	);

	server.get(
		"/v1/telemetry/events",
		{
			schema: {
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: {
						limit: { type: "integer", minimum: 1, maximum: 500 },
					},
				},
			},
		},
		async (request) => {
			const { limit = 50 } = request.query as { limit?: number };
			return {
				events: telemetry.recentEvents(limit),
				sink: {
					configured: telemetry.sinkConfigured,
					healthy: telemetry.sinkHealthy,
				},
			};
		},
	);
}
