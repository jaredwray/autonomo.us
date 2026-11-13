/**
 * A failure a caller can act on, with the HTTP status it maps to. Routes send
 * its message as `{ error: { message } }`; MCP tools return it as a tool
 * result with `isError`. Anything else is an unexpected error.
 */
export class ServiceError extends Error {
	constructor(
		message: string,
		readonly statusCode = 400,
		options?: ErrorOptions,
	) {
		super(message, options);
	}
}
