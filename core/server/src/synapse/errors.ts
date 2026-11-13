import { ServiceError } from "../service-error.js";

export class SynapseError extends ServiceError {}

export const synapseUnavailable = (cause: unknown) =>
	new SynapseError("Synapse is unavailable. Check MongoDB and retry.", 503, {
		cause,
	});
