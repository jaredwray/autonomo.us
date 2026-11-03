import type { MongoClientOptions } from "mongodb";

/**
 * Per-stage deadlines for a MongoDB client.
 *
 * Driver 7.8.0 ignores `timeoutMS`, so a command that reaches a server and
 * then stalls is bounded by the socket timeout. A checkout waiting on those
 * sockets is bounded by `waitQueueTimeoutMS`.
 */
export function mongoOperationDeadlines(
	timeoutMs: number,
): Pick<
	MongoClientOptions,
	"connectTimeoutMS" | "socketTimeoutMS" | "waitQueueTimeoutMS"
> {
	return {
		connectTimeoutMS: timeoutMs,
		socketTimeoutMS: timeoutMs,
		waitQueueTimeoutMS: timeoutMs,
	};
}
