import { ServiceError } from "../service-error.js";

export class BotError extends ServiceError {}

export const botsUnavailable = (cause: unknown) =>
	new BotError("Bots are unavailable. Check MongoDB and retry.", 503, {
		cause,
	});
