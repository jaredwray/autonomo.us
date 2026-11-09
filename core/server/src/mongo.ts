import { AsyncLocalStorage } from "node:async_hooks";
import {
	type Collection,
	type Document,
	MongoClient,
	type MongoClientOptions,
} from "mongodb";

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

/**
 * One MongoDB client shared by the control-plane stores (accounts, tokens,
 * workspaces, providers, routing). On Workers every request opens its own
 * sockets, so stores that each keyed their own client would multiply the
 * connections a request opens; sharing one keeps a request well inside the
 * per-request connection limit.
 */
export class MongoConnection {
	private client?: MongoClient;
	constructor(
		readonly url: string,
		private readonly create: (url: string) => MongoClient,
	) {}
	private current(): MongoClient {
		const create = () => this.create(this.url);
		let client = requestMongoClient(this, create);
		if (!client) {
			this.client ??= create();
			client = this.client;
		}
		return client;
	}
	collection<T extends Document = Document>(name: string): Collection<T> {
		return this.current().db().collection<T>(name);
	}
	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		await client?.close();
	}
}

/** True for a MongoDB duplicate-key error, which a lost insert race produces. */
export function isDuplicateKey(error: unknown): boolean {
	return (error as { code?: unknown } | null)?.code === 11000;
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

/** The shared control-plane connection, with the deadlines the stores have always used. */
export function controlPlaneConnection(url: string): MongoConnection {
	return new MongoConnection(
		url,
		(target) =>
			new MongoClient(target, {
				serverSelectionTimeoutMS: 1500,
				...mongoOperationDeadlines(3000),
				readPreference: "primary",
			}),
	);
}
