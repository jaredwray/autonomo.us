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

/** How long a new client waits to find the primary: the stores' long-standing budget. */
export const MONGO_SELECTION_TIMEOUT_MS = 1500;

/**
 * The client a store uses: the request's own on Workers, otherwise one kept
 * for the life of the process.
 *
 * Driver 7.8.0 closes a client whose first connection attempt cannot find a
 * server in time, and never reopens it: every later operation rejects at once
 * with MongoTopologyClosedError, even after the database is reachable. A
 * Worker request discards its clients anyway. A process drops the closed
 * client here, so the next operation connects again instead of failing until
 * the process restarts.
 */
export class SharedMongoClient {
	private client?: MongoClient;
	constructor(private readonly create: () => MongoClient) {}
	current(): MongoClient {
		const scoped = requestMongoClient(this, this.create);
		if (scoped) return scoped;
		if (!this.client) {
			const client = this.create();
			// The driver has already released the closed client's resources.
			client.once("topologyClosed", () => {
				if (this.client === client) this.client = undefined;
			});
			this.client = client;
		}
		return this.client;
	}
	async close(): Promise<void> {
		const client = this.client;
		this.client = undefined;
		await client?.close();
	}
}

/**
 * One MongoDB client shared by the control-plane stores (accounts, tokens,
 * workspaces, providers, routing). On Workers every request opens its own
 * sockets, so stores that each keyed their own client would multiply the
 * connections a request opens; sharing one keeps a request well inside the
 * per-request connection limit.
 */
export class MongoConnection {
	private readonly shared: SharedMongoClient;
	constructor(
		readonly url: string,
		create: (url: string) => MongoClient,
	) {
		this.shared = new SharedMongoClient(() => create(url));
	}
	collection<T extends Document = Document>(name: string): Collection<T> {
		return this.shared.current().db().collection<T>(name);
	}
	async close(): Promise<void> {
		await this.shared.close();
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
export function controlPlaneConnection(
	url: string,
	selectionTimeoutMs = MONGO_SELECTION_TIMEOUT_MS,
): MongoConnection {
	return new MongoConnection(
		url,
		(target) =>
			new MongoClient(target, {
				serverSelectionTimeoutMS: selectionTimeoutMs,
				...mongoOperationDeadlines(3000),
				readPreference: "primary",
			}),
	);
}
