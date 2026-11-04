import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";

/** Real MongoDB used by integration tests. Suites skip when it is absent. */
export const MONGODB_TEST_URL =
	process.env.MONGODB_URI ??
	"mongodb://autonomous:autonomous@localhost:27017/autonomous?authSource=admin";

export function uniqueMongoUrl(prefix: string): string {
	const url = new URL(MONGODB_TEST_URL);
	url.pathname = `/autonomous_telemetry_${prefix}_${randomUUID().replaceAll("-", "")}`;
	return url.toString();
}

export async function mongoAvailable(): Promise<boolean> {
	const client = new MongoClient(MONGODB_TEST_URL, {
		serverSelectionTimeoutMS: 1500,
		connectTimeoutMS: 1500,
	});
	try {
		await client.db().command({ ping: 1 });
		return true;
	} catch {
		return false;
	} finally {
		await client.close().catch(() => {});
	}
}
