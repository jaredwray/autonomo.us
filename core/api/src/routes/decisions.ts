import type { DecisionRequest } from "@autonomo.us/common";
import type { FastifyInstance } from "fastify";
import {
	type ProviderRegistry,
	UnknownProviderError,
} from "../providers/registry.js";
import { DecisionProviderError } from "../providers/typesafe.js";
import type { TelemetryService } from "../telemetry/telemetry.js";

const content = {
	type: ["string", "object", "array"],
	additionalProperties: true,
};
const question = (type: string, criteria: object, required: string[] = []) => ({
	type: "object",
	additionalProperties: false,
	required: ["type", ...required],
	properties: { type: { const: type }, instructions: content, criteria },
});

export async function decisionsRoutes(
	server: FastifyInstance,
	options: { registry: ProviderRegistry; telemetry: TelemetryService },
) {
	server.post<{ Body: DecisionRequest }>(
		"/v1/decisions",
		{
			// Preserve the meaning of decision state before AJV's scalar coercion.
			preValidation: async (request, reply) => {
				const state = request.body?.state;
				if (
					state === null ||
					(typeof state !== "string" && typeof state !== "object")
				) {
					return reply.code(400).send({
						error: { message: "State must be text, an object, or an array." },
					});
				}
			},
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["model", "state", "questions"],
					properties: {
						model: { type: "string", minLength: 1 },
						state: content,
						questions: {
							type: "object",
							minProperties: 1,
							maxProperties: 100,
							additionalProperties: {
								oneOf: [
									question("noul", {
										type: "object",
										additionalProperties: false,
										properties: { true: content, false: content },
									}),
									question(
										"choice",
										{
											type: "object",
											minProperties: 2,
											additionalProperties: content,
										},
										["criteria"],
									),
									question(
										"score",
										{ type: "array", minItems: 2, items: content },
										["criteria"],
									),
								],
							},
						},
					},
				},
			},
		},
		async (request, reply) => {
			reply.header("cache-control", "no-store");
			let resolved: ReturnType<ProviderRegistry["resolveProvider"]>;
			try {
				resolved = options.registry.resolveProvider(request.body.model);
			} catch (error) {
				if (error instanceof UnknownProviderError)
					return reply.code(404).send({ error: { message: error.message } });
				throw error;
			}
			if (!resolved.provider.decide)
				return reply.code(400).send({
					error: {
						message:
							"This model does not support decisions. Use POST /v1/chat.",
					},
				});
			const started = Date.now();
			try {
				const result = await resolved.provider.decide({
					...request.body,
					model: resolved.modelId,
				});
				options.telemetry.recordChat({
					operation: "decisions",
					caller: request.telemetryCaller,
					model: resolved.id,
					provider: resolved.provider.name,
					latencyMs: Date.now() - started,
					usage: {
						promptTokens: result.usage.input_tokens,
						completionTokens: result.usage.output_tokens,
						totalTokens: result.usage.input_tokens + result.usage.output_tokens,
					},
				});
				return result;
			} catch (error) {
				const message =
					error instanceof DecisionProviderError
						? error.message
						: "Decision request failed.";
				options.telemetry.recordChat({
					operation: "decisions",
					caller: request.telemetryCaller,
					model: resolved.id,
					provider: resolved.provider.name,
					latencyMs: Date.now() - started,
					error: message,
					usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
				});
				return reply
					.code(error instanceof DecisionProviderError ? error.statusCode : 502)
					.send({ error: { message } });
			}
		},
	);
}
