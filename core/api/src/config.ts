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
	| OpenAICompatibleProviderConfig;

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
	clickhouse?: ClickHouseConfig;
	/**
	 * Browser origins allowed by CORS. `["*"]` allows any origin. The default
	 * covers the Vite dev dashboard; the gateway holds provider keys and has
	 * no auth, so arbitrary web pages must not be able to call it.
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

	return { providers, clickhouse, corsOrigins };
}
