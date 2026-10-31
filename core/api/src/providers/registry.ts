import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createGroq } from "@ai-sdk/groq";
import { createMistral } from "@ai-sdk/mistral";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createXai } from "@ai-sdk/xai";
import type {
	DecisionRequest,
	DecisionResponse,
	ModelInfo,
} from "@autonomo.us/common";
import type { LanguageModel } from "ai";
import type { ApiConfig, ProviderConfig } from "../config.js";
import { createTypeSafeDecision } from "./typesafe.js";

export type ModelProvider = {
	/** Registry name, used as the prefix in `provider/model` ids. */
	name: string;
	/** Provider implementation kind, e.g. `anthropic` or `openai-compatible`. */
	kind: string;
	/** Models advertised via GET /v1/models. Routing is not limited to this list. */
	models: string[];
	capability?: "chat" | "decisions";
	decide?(request: DecisionRequest): Promise<DecisionResponse>;
	languageModel(modelId: string): LanguageModel;
};

export class UnknownProviderError extends Error {
	constructor(readonly providerName: string) {
		super(`Unknown provider "${providerName}"`);
		this.name = "UnknownProviderError";
	}
}

export class ModelCapabilityError extends Error {
	readonly statusCode = 400;
}

export type ResolvedModel = {
	provider: ModelProvider;
	modelId: string;
	/** Canonical routable id (`provider/model`). */
	id: string;
	model: LanguageModel;
};

/**
 * Maps `provider/model` ids to AI SDK language models. The prefix before the
 * first `/` selects the provider; the rest is passed through as the provider's
 * model id (so ids like `local/meta-llama/Llama-3.3-70B` work).
 */
export class ProviderRegistry {
	private readonly providers = new Map<string, ModelProvider>();

	register(provider: ModelProvider): this {
		this.providers.set(provider.name, provider);
		return this;
	}

	listProviders(): Array<{ name: string; kind: string }> {
		return [...this.providers.values()].map(({ name, kind }) => ({
			name,
			kind,
		}));
	}

	listModels(): ModelInfo[] {
		return [...this.providers.values()].flatMap((provider) =>
			provider.models.map((model) => ({
				id: `${provider.name}/${model}`,
				provider: provider.name,
				model,
				...(provider.capability ? { capability: provider.capability } : {}),
			})),
		);
	}

	resolve(id: string): ResolvedModel {
		const resolved = this.resolveProvider(id);
		if (resolved.provider.capability === "decisions") {
			throw new ModelCapabilityError(
				"This model supports decisions. Use POST /v1/decisions with state and questions.",
			);
		}
		return {
			...resolved,
			model: resolved.provider.languageModel(resolved.modelId),
		};
	}

	resolveProvider(id: string): Omit<ResolvedModel, "model"> {
		const separator = id.indexOf("/");
		let providerName: string;
		let modelId: string;

		if (separator === -1) {
			// Bare model id: unambiguous only when a single provider is registered.
			const all = [...this.providers.values()];
			if (all.length !== 1) {
				throw new UnknownProviderError(id);
			}
			providerName = all[0].name;
			modelId = id;
		} else {
			providerName = id.slice(0, separator);
			modelId = id.slice(separator + 1);
		}

		const provider = this.providers.get(providerName);
		if (!provider || modelId.length === 0) {
			throw new UnknownProviderError(providerName);
		}

		return {
			provider,
			modelId,
			id: `${provider.name}/${modelId}`,
		};
	}
}

export function providerFromConfig(config: ProviderConfig): ModelProvider {
	switch (config.kind) {
		case "typesafe":
			return {
				name: config.name,
				kind: config.kind,
				models: config.models,
				capability: "decisions",
				decide: createTypeSafeDecision(config),
				languageModel: () => {
					throw new ModelCapabilityError(
						"Jev supports decisions; use /v1/decisions.",
					);
				},
			};
		case "openai":
		case "groq":
		case "mistral": {
			const provider =
				config.kind === "openai"
					? createOpenAI(config)
					: config.kind === "groq"
						? createGroq(config)
						: createMistral(config);
			return {
				name: config.name,
				kind: config.kind,
				models: config.models,
				languageModel: (modelId) => provider(modelId),
			};
		}
		case "google": {
			const google = createGoogleGenerativeAI({
				apiKey: config.apiKey,
				baseURL: config.baseURL,
			});
			return {
				name: config.name,
				kind: config.kind,
				models: config.models,
				languageModel: (modelId) => google.chat(modelId),
			};
		}
		case "xai": {
			const xai = createXai({
				apiKey: config.apiKey,
				baseURL: config.baseURL,
			});
			return {
				name: config.name,
				kind: config.kind,
				models: config.models,
				languageModel: (modelId) => xai.chat(modelId),
			};
		}
		case "anthropic": {
			const anthropic = createAnthropic({
				apiKey: config.apiKey,
				baseURL: config.baseURL,
			});
			return {
				name: config.name,
				kind: config.kind,
				models: config.models,
				languageModel: (modelId) => anthropic(modelId),
			};
		}
		case "deepseek":
		case "openrouter":
		case "cloudflare":
		case "openai-compatible": {
			const baseURL =
				config.baseURL ??
				(config.kind === "deepseek"
					? "https://api.deepseek.com/v1"
					: config.kind === "openrouter"
						? "https://openrouter.ai/api/v1"
						: config.kind === "cloudflare" && config.accountId
							? `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/ai/v1`
							: undefined);
			if (!baseURL)
				throw new Error(`Missing base URL or account ID for ${config.name}`);
			const provider = createOpenAICompatible({
				name: config.name,
				baseURL,
				apiKey: config.apiKey,
			});
			return {
				name: config.name,
				kind: config.kind,
				models: config.models,
				languageModel: (modelId) => provider(modelId),
			};
		}
	}
}

export function registryFromConfig(config: ApiConfig): ProviderRegistry {
	const registry = new ProviderRegistry();
	for (const provider of config.providers) {
		registry.register(providerFromConfig(provider));
	}
	return registry;
}
