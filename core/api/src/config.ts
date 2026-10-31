import type { FailoverPolicy, ManagedProvider } from "@autonomo.us/common";
import {
	DEFAULT_FAILOVER_POLICY,
	MAX_FAILOVER_TIMEOUT_MS,
} from "./failover.js";

export type AnthropicProviderConfig = {
	kind: "anthropic";
	/** Registry name used as the model id prefix, e.g. `anthropic/claude-opus-4-8`. */
	name: string;
	apiKey?: string;
	baseURL?: string;
	models: string[];
};

export type OpenAICompatibleProviderConfig = {
	kind: "openai-compatible";
	name: string;
	/** Base URL of any OpenAI-compatible server (Ollama, LM Studio, vLLM, llama.cpp). */
	baseURL: string;
	apiKey?: string;
	models: string[];
};

export type ProviderConfig =
	| AnthropicProviderConfig
	| CloudProviderConfig
	| OpenAICompatibleProviderConfig;

export type CloudProviderConfig = {
	kind: Exclude<ManagedProvider, "anthropic">;
	name: string;
	apiKey?: string;
	baseURL?: string;
	accountId?: string;
	models: string[];
};

export type ClickHouseConfig = {
	url: string;
	database: string;
	table: string;
	username: string;
	password: string;
	/** Per-request timeout so a hung ClickHouse never blocks API responses. */
	requestTimeoutMs: number;
};

export type ApiConfig = {
	providers: ProviderConfig[];
	/** Initial failover policy; runtime-mutable via PUT /v1/failover. */
	failover?: FailoverPolicy;
	clickhouse?: ClickHouseConfig;
	mongodbUrl?: string;
	/** Protect /v1 with this owner credential; managed API tokens only get gateway access. */
	ownerToken?: string;
	/**
	 * Browser origins allowed by CORS. `["*"]` allows any origin. The default
	 * covers the Vite dev dashboard; the gateway holds provider keys and has
	 * optional owner authentication, so arbitrary web pages must not be able to call it.
	 */
	corsOrigins: string[];
};

export const DEFAULT_CORS_ORIGINS = [
	"http://localhost:5173",
	"http://127.0.0.1:5173",
];

export const DEFAULT_ANTHROPIC_MODELS = [
	"claude-opus-4-8",
	"claude-sonnet-5",
	"claude-haiku-4-5",
];

function parseModels(value: string | undefined, fallback: string[]): string[] {
	if (!value) return fallback;
	return value
		.split(",")
		.map((model) => model.trim())
		.filter((model) => model.length > 0);
}

/**
 * Builds the gateway configuration from environment variables.
 *
 * - `ANTHROPIC_API_KEY` (or `ANTHROPIC_BASE_URL`) registers the `anthropic` provider.
 *   `ANTHROPIC_MODELS` overrides the advertised model list.
 * - `OPENAI_COMPAT_BASE_URL` registers an OpenAI-compatible provider (Ollama,
 *   LM Studio, vLLM, ...). `OPENAI_COMPAT_NAME` (default `local`),
 *   `OPENAI_COMPAT_API_KEY`, and `OPENAI_COMPAT_MODELS` refine it.
 * - `CLICKHOUSE_URL` enables the telemetry sink. `CLICKHOUSE_DATABASE`,
 *   `CLICKHOUSE_TABLE`, `CLICKHOUSE_USERNAME`, and `CLICKHOUSE_PASSWORD`
 *   default to the docker-compose settings.
 * - `FAILOVER_ENABLED`, `FAILOVER_TARGETS` (comma-separated `provider/model`
 *   ids), and `FAILOVER_TIMEOUT_MS` seed the failover policy, which stays
 *   runtime-configurable via PUT /v1/failover and the dashboard.
 */
export function configFromEnv(
	env: Record<string, string | undefined> = process.env,
): ApiConfig {
	const providers: ProviderConfig[] = [];

	if (env.ANTHROPIC_API_KEY || env.ANTHROPIC_BASE_URL) {
		providers.push({
			kind: "anthropic",
			name: "anthropic",
			apiKey: env.ANTHROPIC_API_KEY,
			baseURL: env.ANTHROPIC_BASE_URL,
			models: parseModels(env.ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODELS),
		});
	}

	if (env.OPENAI_COMPAT_BASE_URL) {
		providers.push({
			kind: "openai-compatible",
			name: env.OPENAI_COMPAT_NAME || "local",
			baseURL: env.OPENAI_COMPAT_BASE_URL,
			apiKey: env.OPENAI_COMPAT_API_KEY,
			models: parseModels(env.OPENAI_COMPAT_MODELS, []),
		});
	}

	const googleKey = env.GEMINI_API_KEY || env.GOOGLE_GENERATIVE_AI_API_KEY;
	if (googleKey || env.GOOGLE_BASE_URL) {
		providers.push({
			kind: "google",
			name: "google",
			apiKey: googleKey,
			baseURL: env.GOOGLE_BASE_URL,
			models: parseModels(env.GEMINI_MODELS, ["gemini-2.5-flash"]),
		});
	}
	if (env.XAI_API_KEY || env.XAI_BASE_URL) {
		providers.push({
			kind: "xai",
			name: "xai",
			apiKey: env.XAI_API_KEY,
			baseURL: env.XAI_BASE_URL,
			models: parseModels(env.XAI_MODELS, ["grok-4"]),
		});
	}

	const services = [
		["openai", "OPENAI", "gpt-5.2"],
		["groq", "GROQ", "llama-3.1-8b-instant"],
		["mistral", "MISTRAL", "mistral-large-latest"],
		["deepseek", "DEEPSEEK", "deepseek-flash"],
		["openrouter", "OPENROUTER", "openai/gpt-5.2"],
		["typesafe", "TYPESAFE", "jev-latest"],
	] as const;
	for (const [kind, prefix, model] of services) {
		if (env[`${prefix}_API_KEY`] || env[`${prefix}_BASE_URL`]) {
			providers.push({
				kind,
				name: kind,
				apiKey: env[`${prefix}_API_KEY`],
				baseURL: env[`${prefix}_BASE_URL`],
				models: parseModels(env[`${prefix}_MODELS`], [model]),
			});
		}
	}
	if (env.CLOUDFLARE_API_TOKEN || env.CLOUDFLARE_BASE_URL) {
		if (
			!env.CLOUDFLARE_BASE_URL &&
			!/^[a-fA-F0-9]{32}$/.test(env.CLOUDFLARE_ACCOUNT_ID ?? "")
		) {
			throw new Error(
				"CLOUDFLARE_ACCOUNT_ID must be a 32-character hexadecimal account ID.",
			);
		}
		providers.push({
			kind: "cloudflare",
			name: "cloudflare",
			apiKey: env.CLOUDFLARE_API_TOKEN,
			accountId: env.CLOUDFLARE_ACCOUNT_ID,
			baseURL: env.CLOUDFLARE_BASE_URL,
			models: parseModels(env.CLOUDFLARE_MODELS, [
				"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
			]),
		});
	}

	const clickhouse: ClickHouseConfig | undefined = env.CLICKHOUSE_URL
		? {
				url: env.CLICKHOUSE_URL,
				database: env.CLICKHOUSE_DATABASE || "autonomous",
				table: env.CLICKHOUSE_TABLE || "telemetry_events",
				// ?? not ||: an explicitly empty username/password is valid
				// (ClickHouse's default user has no password).
				username: env.CLICKHOUSE_USERNAME ?? "autonomous",
				password: env.CLICKHOUSE_PASSWORD ?? "autonomous",
				requestTimeoutMs: Number(env.CLICKHOUSE_TIMEOUT_MS) || 3000,
			}
		: undefined;

	const corsOrigins = env.CORS_ORIGIN
		? env.CORS_ORIGIN.split(",")
				.map((origin) => origin.trim())
				.filter((origin) => origin.length > 0)
		: DEFAULT_CORS_ORIGINS;

	// FAILOVER_TIMEOUT_MS=0 is valid ("no timeout"), so 0 must not fall
	// through to the default the way `Number(...) || fallback` would. Oversized
	// values are clamped to the same cap PUT /v1/failover enforces.
	const failoverTimeout = env.FAILOVER_TIMEOUT_MS
		? Number(env.FAILOVER_TIMEOUT_MS)
		: Number.NaN;
	const failover: FailoverPolicy = {
		enabled: env.FAILOVER_ENABLED === "true" || env.FAILOVER_ENABLED === "1",
		targets: parseModels(env.FAILOVER_TARGETS, []),
		timeoutMs:
			Number.isFinite(failoverTimeout) && failoverTimeout >= 0
				? Math.min(failoverTimeout, MAX_FAILOVER_TIMEOUT_MS)
				: DEFAULT_FAILOVER_POLICY.timeoutMs,
	};

	return {
		providers,
		failover,
		clickhouse,
		mongodbUrl: env.MONGODB_URL,
		ownerToken: env.OWNER_TOKEN || undefined,
		corsOrigins,
	};
}
