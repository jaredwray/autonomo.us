import type { AgentWakeActor, RoutingConfig } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { requestActor, requestWorkspace } from "../auth/access.js";
import { MAX_FAILOVER_TIMEOUT_MS } from "../failover.js";
import type { ProviderSettingsStore } from "../providers/settings.js";
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

/** JSON with object keys in order, so equal settings compare equal however they were written. */
const stable = (value: unknown): string =>
	JSON.stringify(value, (_key, item: unknown) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([a], [b]) => (a < b ? -1 : 1)),
				)
			: item,
	);

/** Registered under `/v1/:workspace`. Targets resolve only within the workspace. */
export async function routingRoutes(
	server: FastifyInstance,
	options: {
		routing: RoutingSettingsStore;
		providers: ProviderSettingsStore;
		/**
		 * Called once a save changes routing, the failover policy it carries,
		 * or both, once for each. The change stands whatever this does.
		 */
		onChanged?: (
			workspaceId: string,
			change: "routing" | "failover",
			by: AgentWakeActor,
		) => Promise<unknown>;
	},
) {
	server.get("/routing", (request, reply) => {
		reply.header("cache-control", "no-store");
		return options.routing.settings(requestWorkspace(request));
	});
	server.put<{ Body: RoutingConfig }>(
		"/routing",
		{ schema: { body: schema } },
		async (request) => {
			const workspace = requestWorkspace(request);
			const before = options.onChanged
				? await options.routing.config(workspace)
				: null;
			const updated = await options.routing.update(
				workspace,
				request.body,
				await options.providers.registry(workspace),
			);
			if (before) {
				// The dashboard saves failover inside the routing settings: say
				// which of the two a save changed.
				const { failover: wasFailover, ...wasRouting } = before;
				const { failover, ...routing } = updated.config;
				for (const [change, was, is] of [
					["routing", wasRouting, routing],
					["failover", wasFailover, failover],
				] as const)
					if (stable(was) !== stable(is))
						await options
							.onChanged?.(workspace.id, change, requestActor(request))
							.catch(() => {});
			}
			return updated;
		},
	);
}
