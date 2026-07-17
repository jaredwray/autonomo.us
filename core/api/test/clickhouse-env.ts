import type { ClickHouseConfig } from "../src/config.js";

/**
 * Connection settings for the real ClickHouse used by integration tests —
 * the docker-compose / CI service container (user `autonomous`) or any local
 * server (e.g. `clickhouse server`, default user). No mocks: suites probe the
 * server and skip with a warning when it is not running.
 */
export const CLICKHOUSE_TEST_URL =
	process.env.CLICKHOUSE_URL ?? "http://localhost:8123";

export function clickhouseTestConfig(table: string): ClickHouseConfig {
	return {
		url: CLICKHOUSE_TEST_URL,
		database: process.env.CLICKHOUSE_DATABASE ?? "autonomous_test",
		table,
		username: process.env.CLICKHOUSE_USERNAME ?? "default",
		password: process.env.CLICKHOUSE_PASSWORD ?? "",
		requestTimeoutMs: 5000,
	};
}

export function uniqueTable(prefix: string): string {
	return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
}

export async function clickhouseAvailable(): Promise<boolean> {
	try {
		const response = await fetch(`${CLICKHOUSE_TEST_URL}/ping`, {
			signal: AbortSignal.timeout(1500),
		});
		return response.ok;
	} catch {
		return false;
	}
}

/** Runs a raw query (e.g. DROP TABLE cleanup) against the test server. */
export async function clickhouseQuery(
	config: ClickHouseConfig,
	query: string,
): Promise<string> {
	const url = new URL(config.url);
	url.searchParams.set("query", query);
	const response = await fetch(url, {
		method: "POST",
		headers: {
			"X-ClickHouse-User": config.username,
			"X-ClickHouse-Key": config.password,
		},
		signal: AbortSignal.timeout(5000),
	});
	const text = await response.text();
	if (!response.ok) {
		throw new Error(`query failed (${response.status}): ${text}`);
	}
	return text;
}
