import { ServiceError } from "../service-error.js";

export class ChannelError extends ServiceError {}

export const channelsUnavailable = (cause: unknown) =>
	new ChannelError("Channels are unavailable. Check MongoDB and retry.", 503, {
		cause,
	});
