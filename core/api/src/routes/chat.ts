import { randomUUID } from "node:crypto";
import type {
	FailoverAttempt,
	GatewayRequest,
	GatewayResponse,
	TokenUsage,
} from "@autonomo.us/common";
import { generateText, type LanguageModelUsage, streamText } from "ai";
import type { FastifyInstance, FastifyReply } from "fastify";
import {
	DEFAULT_FAILOVER_POLICY,
	type FailoverPolicyStore,
} from "../failover.js";
import type { ProviderRegistry, ResolvedModel } from "../providers/registry.js";
import { UnknownProviderError } from "../providers/registry.js";
import type { TelemetryService } from "../telemetry/telemetry.js";

export type ChatRouteOptions = {
	registry: ProviderRegistry;
	telemetry: TelemetryService;
	/** Failover policy; treated as disabled when omitted. */
	failover?: FailoverPolicyStore;
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

function timeoutMessage(timeoutMs: number): string {
	return `timed out after ${timeoutMs}ms`;
}

const EMPTY_USAGE: TokenUsage = {
	promptTokens: 0,
	completionTokens: 0,
	totalTokens: 0,
};

type AttemptTimeout = {
	signal?: AbortSignal;
	timedOut(): boolean;
	clear(): void;
};

/** Arms a per-attempt timeout; `timedOut()` tells it apart from other aborts. */
function startAttemptTimeout(timeoutMs: number): AttemptTimeout {
	if (timeoutMs <= 0) {
		return { timedOut: () => false, clear: () => {} };
	}
	const controller = new AbortController();
	let fired = false;
	const timer = setTimeout(() => {
		fired = true;
		controller.abort();
	}, timeoutMs);
	return {
		signal: controller.signal,
		timedOut: () => fired,
		clear: () => clearTimeout(timer),
	};
}

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

			let requested: ResolvedModel;
			try {
				requested = registry.resolve(body.model);
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

			// Attempt order: the requested model, then (when failover is on) each
			// policy target that resolves. Stale targets — providers removed since
			// the policy was saved — are skipped rather than failing the request.
			const policy = options.failover?.get() ?? DEFAULT_FAILOVER_POLICY;
			const candidates = [requested];
			if (policy.enabled) {
				for (const target of policy.targets) {
					try {
						const resolved = registry.resolve(target);
						if (!candidates.some((c) => c.id === resolved.id)) {
							candidates.push(resolved);
						}
					} catch {}
				}
			}
			// Arm the attempt timeout only when there is somewhere to fail over to;
			// with no usable fallback it would just abort slow-but-successful
			// requests without buying anything.
			const attemptTimeoutMs =
				policy.enabled && candidates.length > 1 ? policy.timeoutMs : 0;

			if (body.stream) {
				return streamChat(
					server,
					reply,
					body,
					candidates,
					attemptTimeoutMs,
					options,
				);
			}

			const attempts: FailoverAttempt[] = [];
			for (const candidate of candidates) {
				const started = performance.now();
				const timeout = startAttemptTimeout(attemptTimeoutMs);
				try {
					const result = await generateText({
						model: candidate.model,
						messages: body.messages,
						temperature: body.temperature,
						maxOutputTokens: body.maxTokens,
						abortSignal: timeout.signal,
						// Surface provider failures immediately — retry policy lives in
						// the gateway's failover loop, not hidden inside the SDK.
						maxRetries: 0,
					});

					const usage = toTokenUsage(result.usage);
					telemetry.recordChat({
						model: candidate.id,
						provider: candidate.provider.name,
						agentId: body.agentId,
						usage,
						latencyMs: Math.round(performance.now() - started),
						...(candidate.id !== requested.id
							? { requestedModel: requested.id }
							: {}),
					});

					const response: GatewayResponse = {
						id: randomUUID(),
						model: candidate.id,
						agentId: body.agentId,
						message: { role: "assistant", content: result.text },
						usage,
						finishReason: result.finishReason,
						createdAt: new Date().toISOString(),
						...(attempts.length > 0
							? { failover: { requestedModel: requested.id, attempts } }
							: {}),
					};
					return response;
				} catch (error) {
					const message = timeout.timedOut()
						? timeoutMessage(attemptTimeoutMs)
						: errorMessage(error);
					telemetry.recordChat({
						model: candidate.id,
						provider: candidate.provider.name,
						agentId: body.agentId,
						usage: EMPTY_USAGE,
						latencyMs: Math.round(performance.now() - started),
						error: message,
						...(candidate.id !== requested.id
							? { requestedModel: requested.id }
							: {}),
					});
					request.log.error(
						{ err: error, model: candidate.id },
						"gateway chat attempt failed",
					);
					attempts.push({ model: candidate.id, error: message });
				} finally {
					timeout.clear();
				}
			}

			const last = attempts[attempts.length - 1];
			return reply.status(502).send({
				error: {
					type: "provider_error",
					message: last.error,
					...(attempts.length > 1 ? { attempts } : {}),
				},
			});
		},
	);
}

async function streamChat(
	server: FastifyInstance,
	reply: FastifyReply,
	body: GatewayRequest & { model: string },
	candidates: ResolvedModel[],
	attemptTimeoutMs: number,
	options: ChatRouteOptions,
) {
	const { telemetry } = options;
	const requested = candidates[0];
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
	const attempts: FailoverAttempt[] = [];
	let servedBy: string | undefined;
	let finalError: string | undefined;

	for (let index = 0; index < candidates.length; index++) {
		const candidate = candidates[index];
		const started = performance.now();
		let usage: TokenUsage = EMPTY_USAGE;
		let finishReason: string | undefined;
		let error: string | undefined;
		let sentOutput = false;

		// One signal per attempt, tripped by either the client hanging up or the
		// per-attempt timeout. The timer is disarmed once output starts flowing —
		// a slow generation is not a timeout, only a slow start is.
		const attempt = new AbortController();
		const forwardAbort = () => attempt.abort();
		abort.signal.addEventListener("abort", forwardAbort);
		if (abort.signal.aborted) attempt.abort();
		let timedOut = false;
		const timer =
			attemptTimeoutMs > 0
				? setTimeout(() => {
						timedOut = true;
						attempt.abort();
					}, attemptTimeoutMs)
				: undefined;
		const disarmTimer = () => {
			if (timer) clearTimeout(timer);
		};

		try {
			const result = streamText({
				model: candidate.model,
				messages: body.messages,
				temperature: body.temperature,
				maxOutputTokens: body.maxTokens,
				abortSignal: attempt.signal,
				maxRetries: 0,
			});

			for await (const part of result.fullStream) {
				if (part.type === "text-delta") {
					disarmTimer();
					sentOutput = true;
					send({ type: "text-delta", text: part.text });
				} else if (part.type === "finish") {
					usage = toTokenUsage(part.totalUsage);
					finishReason = part.finishReason;
				} else if (part.type === "error") {
					error = timedOut
						? timeoutMessage(attemptTimeoutMs)
						: errorMessage(part.error);
				} else if (part.type === "abort") {
					error = timedOut
						? timeoutMessage(attemptTimeoutMs)
						: "client aborted";
				}
			}
		} catch (streamError) {
			error = timedOut
				? timeoutMessage(attemptTimeoutMs)
				: errorMessage(streamError);
		} finally {
			disarmTimer();
			abort.signal.removeEventListener("abort", forwardAbort);
		}

		telemetry.recordChat({
			model: candidate.id,
			provider: candidate.provider.name,
			agentId: body.agentId,
			usage,
			latencyMs: Math.round(performance.now() - started),
			stream: true,
			error,
			...(candidate.id !== requested.id
				? { requestedModel: requested.id }
				: {}),
		});

		if (!error) {
			servedBy = candidate.id;
			finalError = undefined;
			if (!raw.writableEnded) {
				send({
					type: "finish",
					id,
					model: candidate.id,
					usage,
					finishReason,
					...(attempts.length > 0
						? { failover: { requestedModel: requested.id, attempts } }
						: {}),
				});
				raw.write("data: [DONE]\n\n");
				raw.end();
			}
			break;
		}

		attempts.push({ model: candidate.id, error });
		finalError = error;
		const next = candidates[index + 1];
		const clientGone = abort.signal.aborted && !timedOut;

		// Fail over only while nothing has been streamed to the client yet; once
		// output started the response is committed to this model.
		if (next && !sentOutput && !clientGone) {
			send({ type: "failover", from: candidate.id, to: next.id, error });
			continue;
		}

		if (!raw.writableEnded) {
			if (!clientGone) {
				send({ type: "error", error: { message: error } });
			}
			raw.write("data: [DONE]\n\n");
			raw.end();
		}
		break;
	}

	server.log.info(
		{
			model: servedBy ?? requested.id,
			requestedModel: requested.id,
			failoverAttempts: attempts.length,
			stream: true,
			error: finalError,
		},
		"gateway chat stream finished",
	);
}
