import type { FastifyInstance } from "fastify";
import type { TelemetryService } from "../telemetry/telemetry.js";

export type TelemetryRouteOptions = {
	telemetry: TelemetryService;
};

export async function telemetryRoutes(
	server: FastifyInstance,
	options: TelemetryRouteOptions,
) {
	const { telemetry } = options;

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
