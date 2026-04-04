export type AgentConfig = {
	id: string;
	name: string;
	description?: string;
	model: string;
	systemPrompt?: string;
	temperature?: number;
	maxTokens?: number;
	tools?: string[];
	createdAt: Date;
	updatedAt: Date;
};

export type GatewayRequest = {
	agentId: string;
	messages: GatewayMessage[];
	stream?: boolean;
};

export type GatewayMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};

export type GatewayResponse = {
	id: string;
	agentId: string;
	message: GatewayMessage;
	usage: TokenUsage;
	createdAt: Date;
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
	timestamp: Date;
};
