import type { FailoverPolicy } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import { requestWorkspace } from "../auth/access.js";
import { MAX_FAILOVER_TIMEOUT_MS } from "../failover.js";
import type { ProviderSettingsStore } from "../providers/settings.js";
import type { RoutingSettingsStore } from "../routing/settings.js";

export type FailoverRouteOptions = {
	providers: ProviderSettingsStore;
	routing: RoutingSettingsStore;
};

const failoverBodySchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		enabled: { type: "boolean" },
		timeoutMs: {
			type: "integer",
			minimum: 0,
			maximum: MAX_FAILOVER_TIMEOUT_MS,
		},
		targets: {
			type: "array",
			maxItems: 20,
			items: { type: "string", minLength: 1 },
		},
	},
} as const;

/** The workspace's default failover policy. Registered under `/v1/:workspace`. */
export async function failoverRoutes(
	server: FastifyInstance,
	options: FailoverRouteOptions,
) {
	server.get("/failover", async (request) => {
		return (await options.routing.config(requestWorkspace(request))).failover;
	});

	server.put(
		"/failover",
		{ schema: { body: failoverBodySchema } },
		async (request, reply) => {
			const workspace = requestWorkspace(request);
			const patch = request.body as Partial<FailoverPolicy>;
			const registry = await options.providers.registry(workspace);
			const unknown = (patch.targets ?? []).filter((target) => {
				try {
					registry.resolve(target);
					return false;
				} catch {
					return true;
				}
			});
			if (unknown.length > 0) {
				return reply.status(400).send({
					error: {
						type: "unknown_target",
						message: `Unknown failover target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. See GET /v1/${workspace.id}/models for routable ids.`,
					},
				});
			}
			return options.routing.updateFailover(workspace, patch);
		},
	);
}
