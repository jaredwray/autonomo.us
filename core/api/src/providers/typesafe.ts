import type { DecisionRequest, DecisionResponse } from "@autonomo.us/common";
import type { CloudProviderConfig } from "../config.js";

export class DecisionProviderError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
	) {
		super(message);
	}
}

function validAnswer(
	answer: Record<string, unknown> | undefined,
	question: DecisionRequest["questions"][string],
): boolean {
	if (!answer || answer.type !== question.type) return false;
	if (
		answer.confidence !== undefined &&
		(typeof answer.confidence !== "number" ||
			answer.confidence < 0 ||
			answer.confidence > 1)
	)
		return false;
	switch (question.type) {
		case "noul":
			return (
				typeof answer.noul === "number" && answer.noul >= 0 && answer.noul <= 1
			);
		case "choice":
			return (
				typeof answer.choice === "string" &&
				Object.hasOwn(question.criteria ?? {}, answer.choice)
			);
		case "score":
			return typeof answer.score === "number" && Number.isFinite(answer.score);
	}
}

/** TypeSafe's System One protocol is separate from chat completions. */
export function createTypeSafeDecision(config: CloudProviderConfig) {
	return async (
		request: DecisionRequest,
		signal?: AbortSignal,
	): Promise<DecisionResponse> => {
		try {
			const response = await fetch(
				`${(config.baseURL ?? "https://api.typesafe.ai/v1").replace(/\/$/, "")}/systemone`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${config.apiKey}`,
						"content-type": "application/json",
					},
					body: JSON.stringify(request),
					signal: signal
						? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
						: AbortSignal.timeout(30_000),
					redirect: "error",
				},
			);
			if (!response.ok) {
				throw new DecisionProviderError(
					`Jev request failed (HTTP ${response.status}).`,
					response.status === 429 ? 429 : 502,
				);
			}
			const body = (await response.json()) as DecisionResponse;
			if (
				!body ||
				typeof body.model !== "string" ||
				!body.answers ||
				typeof body.answers !== "object" ||
				Array.isArray(body.answers) ||
				!Number.isInteger(body.usage?.input_tokens) ||
				body.usage.input_tokens < 0 ||
				!Number.isInteger(body.usage?.output_tokens) ||
				body.usage.output_tokens < 0 ||
				Object.entries(request.questions).some(
					([id, question]) => !validAnswer(body.answers[id], question),
				)
			) {
				throw new DecisionProviderError(
					"Jev returned an invalid decision response.",
					502,
				);
			}
			return { model: body.model, answers: body.answers, usage: body.usage };
		} catch (error) {
			if (error instanceof DecisionProviderError) throw error;
			if (error instanceof Error && error.name === "TimeoutError") {
				throw new DecisionProviderError("Jev request timed out.", 504);
			}
			throw new DecisionProviderError(
				"Could not complete the Jev request.",
				502,
			);
		}
	};
}
