import { AsyncLocalStorage } from "node:async_hooks";
import type { MongoClient, MongoClientOptions } from "mongodb";

const requestClients = new AsyncLocalStorage<Map<object, MongoClient>>();

/** Workers sockets belong to one request, including when requests overlap. */
export function requestMongoClient(
	owner: object,
	create: () => MongoClient,
): MongoClient | undefined {
	const clients = requestClients.getStore();
	if (!clients) return undefined;
	let client = clients.get(owner);
	if (!client) {
		client = create();
		clients.set(owner, client);
	}
	return client;
}

export function withMongoRequestScope<T>(
	run: (close: () => Promise<void>) => T,
): T {
	const clients = new Map<object, MongoClient>();
	return requestClients.run(clients, () =>
		run(async () => {
			const results = await Promise.allSettled(
				[...clients.values()].map((client) => client.close()),
			);
			clients.clear();
			const failed = results.find((result) => result.status === "rejected");
			if (failed?.status === "rejected") throw failed.reason;
		}),
	);
}

/** Log diagnostic codes, never driver messages that may contain a URI or key. */
export function mongoErrorDetails(error: unknown) {
	let cause = error;
	for (let depth = 0; depth < 5; depth++) {
		if (!(cause instanceof Error) || !cause.cause) break;
		cause = cause.cause;
	}
	const errorType = cause instanceof Error ? cause.name : "UnknownError";
	const code =
		cause && typeof cause === "object" && "code" in cause
			? cause.code
			: undefined;
	return {
		errorType: /^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(errorType)
			? errorType
			: "Error",
		...(typeof code === "number" ||
		(typeof code === "string" && /^[A-Z0-9_]{1,80}$/.test(code))
			? { code }
			: {}),
	};
}

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
