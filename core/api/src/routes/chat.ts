import { randomUUID } from "node:crypto";
import type {
	GatewayRequest,
	GatewayResponse,
	TokenUsage,
} from "@autonomo.us/common";
import { generateText, type LanguageModelUsage, streamText } from "ai";
import type { FastifyInstance, FastifyReply } from "fastify";
import type { ProviderRegistry, ResolvedModel } from "../providers/registry.js";
import { UnknownProviderError } from "../providers/registry.js";
import type { TelemetryService } from "../telemetry/telemetry.js";

export type ChatRouteOptions = {
	registry: ProviderRegistry;
	telemetry: TelemetryService;
	/** Origins allowed on the SSE path; `["*"]` allows any. */
	corsOrigins?: string[];
};

/** Returns the CORS origin header value for a request, or undefined to omit. */
export function resolveCorsOrigin(
	requestOrigin: string | undefined,
	allowed: string[],
): string | undefined {
	if (allowed.includes("*")) return "*";
	if (requestOrigin && allowed.includes(requestOrigin)) return requestOrigin;
	return undefined;
}

const chatBodySchema = {
	type: "object",
	required: ["model", "messages"],
	additionalProperties: false,
	properties: {
		model: { type: "string", minLength: 1 },
		agentId: { type: "string" },
		stream: { type: "boolean" },
		temperature: { type: "number" },
		maxTokens: { type: "integer", minimum: 1 },
		messages: {
			type: "array",
			minItems: 1,
			items: {
				type: "object",
				required: ["role", "content"],
				additionalProperties: false,
				properties: {
					role: { enum: ["system", "user", "assistant"] },
					content: { type: "string" },
				},
			},
		},
	},
} as const;

export function toTokenUsage(
	usage: LanguageModelUsage | undefined,
): TokenUsage {
	return {
		promptTokens: usage?.inputTokens ?? 0,
		completionTokens: usage?.outputTokens ?? 0,
		totalTokens:
			usage?.totalTokens ??
			(usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const EMPTY_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
};

export async function chatRoutes(
	server: FastifyInstance,
	options: ChatRouteOptions,
) {
	const { registry, telemetry } = options;

	server.post(
		"/v1/chat",
		{ schema: { body: chatBodySchema } },
		async (request, reply) => {
			const body = request.body as GatewayRequest & { model: string };

			let resolved: ResolvedModel;
			try {
				resolved = registry.resolve(body.model);
			} catch (error) {
				if (error instanceof UnknownProviderError) {
					return reply.status(404).send({
						error: {
							type: "unknown_model",
							message: `${error.message}. See GET /v1/models for available models.`,
						},
					});
				}
				throw error;
			}

			if (body.stream) {
				return streamChat(server, reply, body, resolved, options);
			}

			const started = performance.now();
			try {
				const result = await generateText({
					model: resolved.model,
					messages: body.messages,
					temperature: body.temperature,
					maxOutputTokens: body.maxTokens,
					// Surface provider failures immediately — retry policy belongs
					// to gateway clients, not hidden inside the proxy hop.
					maxRetries: 0,
				});

				const usage = toTokenUsage(result.usage);
				telemetry.recordChat({
					model: resolved.id,
					provider: resolved.provider.name,
					agentId: body.agentId,
					usage,
					latencyMs: Math.round(performance.now() - started),
				});

				const response: GatewayResponse = {
					id: randomUUID(),
					model: resolved.id,
					agentId: body.agentId,
					message: { role: "assistant", content: result.text },
					usage,
					finishReason: result.finishReason,
					createdAt: new Date().toISOString(),
				};
				return response;
			} catch (error) {
				const message = errorMessage(error);
				telemetry.recordChat({
					model: resolved.id,
					provider: resolved.provider.name,
					agentId: body.agentId,
					usage: EMPTY_USAGE,
					latencyMs: Math.round(performance.now() - started),
					error: message,
				});
				request.log.error({ err: error }, "gateway chat failed");
				return reply.status(502).send({
					error: { type: "provider_error", message },
				});
			}
		},
	);
}

async function streamChat(
	server: FastifyInstance,
	reply: FastifyReply,
	body: GatewayRequest & { model: string },
	resolved: ResolvedModel,
	options: ChatRouteOptions,
) {
	const { telemetry } = options;
	const started = performance.now();
	const abort = new AbortController();
	const raw = reply.raw;

	// reply.hijack() bypasses @fastify/cors, so apply the same allowlist here.
	const corsOrigin = resolveCorsOrigin(
		reply.request.headers.origin,
		options.corsOrigins ?? [],
	);

	reply.hijack();
	raw.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
		...(corsOrigin
			? { "access-control-allow-origin": corsOrigin, vary: "origin" }
			: {}),
	});
	raw.on("close", () => {
		if (!raw.writableEnded) abort.abort();
	});

	const send = (payload: unknown) => {
		raw.write(`data: ${JSON.stringify(payload)}\n\n`);
	};

	const id = randomUUID();
	let usage: TokenUsage = EMPTY_USAGE;
	let finishReason: string | undefined;
	let error: string | undefined;

	try {
		const result = streamText({
			model: resolved.model,
			messages: body.messages,
			temperature: body.temperature,
			maxOutputTokens: body.maxTokens,
			abortSignal: abort.signal,
			maxRetries: 0,
		});

		for await (const part of result.fullStream) {
			if (part.type === "text-delta") {
				send({ type: "text-delta", text: part.text });
			} else if (part.type === "finish") {
				usage = toTokenUsage(part.totalUsage);
				finishReason = part.finishReason;
			} else if (part.type === "error") {
				error = errorMessage(part.error);
				send({ type: "error", error: { message: error } });
			} else if (part.type === "abort") {
				error = "client aborted";
			}
		}
	} catch (streamError) {
		error = errorMessage(streamError);
		if (!raw.writableEnded) {
			send({ type: "error", error: { message: error } });
		}
	}

	telemetry.recordChat({
		model: resolved.id,
		provider: resolved.provider.name,
		agentId: body.agentId,
		usage,
		latencyMs: Math.round(performance.now() - started),
		stream: true,
		error,
	});

	if (!raw.writableEnded) {
		if (!error) {
			send({
				type: "finish",
				id,
				model: resolved.id,
				usage,
				finishReason,
			});
		}
		raw.write("data: [DONE]\n\n");
		raw.end();
	}
	server.log.info(
		{ model: resolved.id, stream: true, error },
		"gateway chat stream finished",
	);
}
