export class BrainError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}

export const brainUnavailable = (cause: unknown) =>
	new BrainError("The Brain is unavailable. Check MongoDB and retry.", 503, {
		cause,
	});
