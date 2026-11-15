import { ServiceError } from "../service-error.js";

export class AgentWebhookError extends ServiceError {}

export const webhooksUnavailable = (cause: unknown) =>
	new AgentWebhookError(
		"Agent webhooks are unavailable. Check MongoDB and retry.",
		503,
		{ cause },
	);
