export class SynapseError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export const synapseUnavailable = (cause: unknown) =>
	new SynapseError("Synapse is unavailable. Check MongoDB and retry.", 503, {
		cause,
	});
