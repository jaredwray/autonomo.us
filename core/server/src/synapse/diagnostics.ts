/** Fixed diagnostic vocabulary: never serialize driver messages, stacks or topology hosts. */
const ERROR_TYPES = new Set([
	"Error",
	"TypeError",
	"RangeError",
	"MongoError",
	"MongoServerError",
	"MongoServerSelectionError",
	"MongoNetworkError",
	"MongoNetworkTimeoutError",
	"MongoOperationTimeoutError",
	"MongoWaitQueueTimeoutError",
	"MongoPoolClearedError",
	"MongoParseError",
	"MongoInvalidArgumentError",
	"MongoTopologyClosedError",
	"MongoNotConnectedError",
	"MongoExpiredSessionError",
	"MongoServerClosedError",
	"MongoBulkWriteError",
	"BSONError",
	"BSONVersionError",
	"BSONRuntimeError",
	"AggregateError",
]);
const SYSTEM_CODES = new Set([
	"ENOTFOUND",
	"EAI_AGAIN",
	"ECONNREFUSED",
	"ECONNRESET",
	"ETIMEDOUT",
	"ENETUNREACH",
	"EHOSTUNREACH",
	"EPIPE",
	"ERR_TLS_CERT_ALTNAME_INVALID",
	"CERT_HAS_EXPIRED",
	"DEPTH_ZERO_SELF_SIGNED_CERT",
	"SELF_SIGNED_CERT_IN_CHAIN",
	"UNABLE_TO_VERIFY_LEAF_SIGNATURE",
	"UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
]);
type ErrorSummary = { errorType: string; code?: string | number };
export type SynapseDiagnostic = {
	event: "synapse.storage_ready" | "synapse.storage_failed";
	operation: string;
	stage:
		| "connect"
		| "indexes.notes"
		| "indexes.proposals"
		| "indexes.flags"
		| "indexes.revisions"
		| "read.notes"
		| "read.spaces"
		| "read.proposals"
		| "operation";
	durationMs: number;
	errors?: ErrorSummary[];
};

/** Driver server-selection errors keep the useful error inside reason.servers. */
export function mongoFailureDetails(error: unknown): {
	errors: ErrorSummary[];
} {
	const errors: ErrorSummary[] = [];
	const seen = new Set<object>();
	const visit = (value: unknown, depth: number) => {
		if (
			!value ||
			typeof value !== "object" ||
			depth > 4 ||
			seen.size >= 12 ||
			seen.has(value)
		)
			return;
		seen.add(value);
		const record = value as {
			name?: unknown;
			code?: unknown;
			cause?: unknown;
			reason?: { servers?: unknown };
			errors?: unknown;
		};
		const errorType =
			typeof record.name === "string" && ERROR_TYPES.has(record.name)
				? record.name
				: "Error";
		const code =
			typeof record.code === "number" && Number.isSafeInteger(record.code)
				? record.code
				: typeof record.code === "string" && SYSTEM_CODES.has(record.code)
					? record.code
					: undefined;
		if (
			errors.length < 8 &&
			!errors.some((item) => item.errorType === errorType && item.code === code)
		)
			errors.push({ errorType, ...(code === undefined ? {} : { code }) });
		visit(record.cause, depth + 1);
		if (Array.isArray(record.errors))
			for (const item of record.errors.slice(0, 4)) visit(item, depth + 1);
		const servers = record.reason?.servers;
		if (servers instanceof Map) {
			let count = 0;
			for (const server of servers.values()) {
				if (++count > 4) break;
				visit(server?.error, depth + 1);
			}
		}
	};
	visit(error, 0);
	return { errors: errors.length ? errors : [{ errorType: "UnknownError" }] };
}
