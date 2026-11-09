import type { AnalyticsQuery } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { requestWorkspace } from "../auth/access.js";
import { DAY_MS } from "../telemetry/analytics.js";
import type { TelemetryService } from "../telemetry/telemetry.js";

export type TelemetryRouteOptions = {
	telemetry: TelemetryService;
};

/** Registered under `/v1/:workspace`: every view is limited to that workspace. */
export async function telemetryRoutes(
	server: FastifyInstance,
	options: TelemetryRouteOptions,
) {
	const { telemetry } = options;

	server.get<{ Querystring: AnalyticsQuery }>(
		"/telemetry/analytics",
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
			return telemetry.analytics(
				{
					...request.query,
					from: new Date(from).toISOString(),
					to: new Date(to).toISOString(),
				},
				requestWorkspace(request),
			);
		},
	);

	server.get(
		"/telemetry/summary",
		{
			schema: {
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: {
						source: { enum: ["auto", "memory", "mongodb"] },
					},
				},
			},
		},
		async (request, reply) => {
			const workspace = requestWorkspace(request);
			const { source = "auto" } = request.query as {
				source?: "auto" | "memory" | "mongodb";
			};

			if (source === "mongodb") {
				const summary = await telemetry.summaryFromSink(workspace);
				if (!summary) {
					return reply.status(503).send({
						error: {
							type: "mongodb_unavailable",
							message:
								"MongoDB is not configured or not reachable. Set MONGODB_URI.",
						},
					});
				}
				return summary;
			}

			if (source === "auto") {
				const summary = await telemetry.summaryFromSink(workspace);
				if (summary) return summary;
			}

			return telemetry.summary(workspace);
		},
	);

	server.get(
		"/telemetry/events",
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
				events: telemetry.recentEvents(limit, requestWorkspace(request)),
				sink: {
					configured: telemetry.sinkConfigured,
					healthy: telemetry.sinkHealthy,
				},
			};
		},
	);
}
