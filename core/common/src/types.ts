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
	 * Model to route to, in `provider/model` form (e.g. `anthropic/claude-opus-4-8`,
	 * `local/llama3.3`). Required until agent lookup by `agentId` is implemented.
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
