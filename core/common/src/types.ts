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
	model: string;
	agentId?: string;
	message: GatewayMessage;
	usage: TokenUsage;
	finishReason?: string;
	createdAt: string;
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
