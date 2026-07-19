import type { FailoverPolicy } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import type { FailoverPolicyStore } from "../failover.js";
import type { ProviderRegistry } from "../providers/registry.js";

export type FailoverRouteOptions = {
	failover: FailoverPolicyStore;
	registry: ProviderRegistry;
};

const failoverBodySchema = {
	type: "object",
	additionalProperties: false,
	properties: {
		enabled: { type: "boolean" },
		timeoutMs: { type: "integer", minimum: 0, maximum: 600_000 },
		targets: {
			type: "array",
			maxItems: 20,
			items: { type: "string", minLength: 1 },
		},
	},
} as const;

export async function failoverRoutes(
	server: FastifyInstance,
	options: FailoverRouteOptions,
) {
	const { failover, registry } = options;

	server.get("/v1/failover", async () => failover.get());

	server.put(
		"/v1/failover",
		{ schema: { body: failoverBodySchema } },
		async (request, reply) => {
			const patch = request.body as Partial<FailoverPolicy>;

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
						message: `Unknown failover target${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. See GET /v1/models for routable ids.`,
					},
				});
			}

			return failover.update(patch);
		},
	);
}
