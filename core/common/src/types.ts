export type AgentConfig = {
	id: string;
	name: string;
	description?: string;
	model: string;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
	tools?: string[];
	createdAt: string;
	updatedAt: string;
};

export type GatewayRequest = {
	/**
	 * A `connection/model` id, `auto`, or `pool/<id>`.
	 * Required until agent lookup by `agentId` is implemented.
	 */
	model?: string;
	agentId?: string;
	messages: GatewayMessage[];
	stream?: boolean;
	temperature?: number;
	maxTokens?: number;
};

export type GatewayMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type GatewayResponse = {
	id: string;
	/** Model that answered — a fallback target when failover kicked in. */
	model: string;
	agentId?: string;
	message: GatewayMessage;
	usage: TokenUsage;
	finishReason?: string;
	createdAt: string;
	routing?: RoutingDecision;
	/** Present only when the request was served by a failover target. */
	failover?: {
		requestedModel: string;
		attempts: FailoverAttempt[];
	};
};

export type FailoverAttempt = {
	/** Routable id (`provider/model`) that was tried and failed. */
	model: string;
	error: string;
};

/**
 * Gateway failover policy: when a chat request errors or times out, retry it
 * against `targets` in order. Configurable at runtime via PUT /v1/failover.
 */
export type FailoverPolicy = {
	/** Master switch; when false requests fail fast with no retries. */
	enabled: boolean;
	/**
	 * Ordered fallback model ids (`provider/model`) tried after the requested
	 * model fails. The requested model is never retried against itself.
	 */
	targets: string[];
	/**
	 * Per-attempt budget in milliseconds: non-streaming attempts must finish —
	 * and streaming attempts must start producing output — within it. 0 turns
	 * the timeout off so only provider errors trigger failover.
	 */
	timeoutMs: number;
};

export type RoutingPool = {
	id: string;
	strategy: "weighted-round-robin" | "least-requests";
	members: Array<{ model: string; weight: number }>;
	/** Try remaining members if the selected member fails. */
	failover: boolean;
};

export type RoutingConfig = {
	auto: {
		enabled: boolean;
		/** Jev decision model or any configured chat model used as a selector. */
		decisionModel: string;
		targets: Array<{ target: string; description: string }>;
		/** Used when the selector errors, times out, or returns an invalid choice. */
		fallbackTarget: string;
		timeoutMs: number;
	};
	pools: RoutingPool[];
	/** Default failover policy, also exposed by /v1/failover. */
	failover: FailoverPolicy;
	/** A matching model or pool rule replaces the default policy. */
	rules: Array<FailoverPolicy & { model: string }>;
};

export type RoutingSettings = {
	config: RoutingConfig;
	persistence: "mongodb" | "memory";
};

export type RoutingDecision = {
	requestedModel: string;
	selectedModel: string;
	mode: "auto" | "pool";
	target: string;
	decisionModel?: string;
	/** Selector failed; the configured fallback target was used. */
	decisionFallback?: boolean;
};

export type TokenUsage = {
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
};

export type TelemetryEvent = {
	id: string;
	type: string;
	agentId?: string;
	data: Record<string, unknown>;
	timestamp: string;
};

export type ModelInfo = {
	/** Routable id in `provider/model` form. */
	id: string;
	provider: string;
	model: string;
	/** Omitted on legacy chat models. */
	capability?: "chat" | "decisions";
};

export type ModelUsage = {
	model: string;
	provider: string;
	requests: number;
	errors: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	avgLatencyMs: number;
};

export const PROVIDER_NAMES = {
	google: "Google Gemini",
	xai: "xAI Grok",
	anthropic: "Anthropic Claude",
	openai: "OpenAI",
	groq: "Groq",
	mistral: "Mistral",
	deepseek: "DeepSeek",
	openrouter: "OpenRouter",
	cloudflare: "Cloudflare Workers AI",
	typesafe: "Jev (TypeSafe)",
} as const;

export type ManagedProvider = keyof typeof PROVIDER_NAMES;

export type DecisionRequest = {
	model: string;
	state: string | Record<string, unknown> | unknown[];
	questions: Record<
		string,
		{
			type: "noul" | "choice" | "score";
			instructions?: string | Record<string, unknown> | unknown[];
			criteria?: Record<string, unknown> | unknown[];
		}
	>;
};

export type DecisionResponse = {
	model: string;
	answers: Record<string, Record<string, unknown>>;
	usage: { input_tokens: number; output_tokens: number };
};

export type AddModelRequest = {
	provider: ManagedProvider;
	/** Connection used as the routing prefix. Defaults to the provider ID. */
	connectionId?: string;
	/** Reject an existing connection instead of updating its credentials. */
	createConnection?: boolean;
	model: string;
	/** Omit to reuse the server's existing key. Never returned by the API. */
	apiKey?: string;
	/** Cloudflare account identifier. Omit to reuse the saved account. */
	accountId?: string;
};

export type ProviderSettings = {
	connections: Array<{
		id: string;
		provider: ManagedProvider;
		configured: boolean;
		accountId?: string;
	}>;
	providers: Array<{
		id: ManagedProvider;
		name: string;
		configured: boolean;
		accountId?: string;
	}>;
	persistence: "mongodb" | "memory";
};

export type UsageSummary = {
	totalRequests: number;
	totalErrors: number;
	promptTokens: number;
	completionTokens: number;
	totalTokens: number;
	avgLatencyMs: number;
	byModel: ModelUsage[];
	/** Which store answered the query. */
	source: "memory" | "clickhouse";
};
