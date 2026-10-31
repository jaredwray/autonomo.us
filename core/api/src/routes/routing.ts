import type { RoutingConfig } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { MAX_FAILOVER_TIMEOUT_MS } from "../failover.js";
import type { RoutingSettingsStore } from "../routing/settings.js";

const id = { type: "string", minLength: 1, maxLength: 512, pattern: "^\\S+$" };
const timeout = {
	type: "integer",
	minimum: 0,
	maximum: MAX_FAILOVER_TIMEOUT_MS,
};
const targets = { type: "array", maxItems: 20, uniqueItems: true, items: id };
const policy = {
	type: "object",
	additionalProperties: false,
	required: ["enabled", "targets", "timeoutMs"],
	properties: { enabled: { type: "boolean" }, targets, timeoutMs: timeout },
};
const schema = {
	type: "object",
	additionalProperties: false,
	required: ["auto", "pools", "failover", "rules"],
	properties: {
		auto: {
			type: "object",
			additionalProperties: false,
			required: [
				"enabled",
				"decisionModel",
				"targets",
				"fallbackTarget",
				"timeoutMs",
			],
			properties: {
				enabled: { type: "boolean" },
				decisionModel: { type: "string", maxLength: 512 },
				fallbackTarget: { type: "string", maxLength: 512 },
				timeoutMs: { ...timeout, minimum: 100 },
				targets: {
					type: "array",
					maxItems: 20,
					items: {
						type: "object",
						additionalProperties: false,
						required: ["target", "description"],
						properties: {
							target: id,
							description: {
								type: "string",
								minLength: 1,
								maxLength: 2000,
								pattern: "\\S",
							},
						},
					},
				},
			},
		},
		pools: {
			type: "array",
			maxItems: 50,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["id", "strategy", "members", "failover"],
				properties: {
					id: { type: "string", pattern: "^[a-z][a-z0-9_-]{0,63}$" },
					strategy: { enum: ["weighted-round-robin", "least-requests"] },
					failover: { type: "boolean" },
					members: {
						type: "array",
						minItems: 1,
						maxItems: 20,
						items: {
							type: "object",
							additionalProperties: false,
							required: ["model", "weight"],
							properties: {
								model: id,
								weight: { type: "integer", minimum: 1, maximum: 100 },
							},
						},
					},
				},
			},
		},
		failover: policy,
		rules: {
			type: "array",
			maxItems: 100,
			items: {
				...policy,
				required: [...policy.required, "model"],
				properties: { ...policy.properties, model: id },
			},
		},
	},
};

export async function routingRoutes(
	server: FastifyInstance,
	options: { routing: RoutingSettingsStore },
) {
	server.get("/v1/routing", (_request, reply) => {
		reply.header("cache-control", "no-store");
		return options.routing.settings();
	});
	server.put<{ Body: RoutingConfig }>(
		"/v1/routing",
		{ schema: { body: schema } },
		(request) => options.routing.update(request.body),
	);
}
