import { timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

/** Separate port, never routed by the public Worker; additionally requires a secret. */
export function createContainerControl(options: {
	token: string;
	ready(): Promise<boolean>;
	sweep(): Promise<void>;
}) {
	if (options.token.length < 32)
		throw new Error("Missing container control token");
	const expected = Buffer.from(`Bearer ${options.token}`);
	let sweeping: Promise<void> | undefined;
	return createServer(async (request, response) => {
		response.setHeader("cache-control", "no-store");
		const actual = Buffer.from(request.headers.authorization ?? "");
		if (
			actual.length !== expected.length ||
			!timingSafeEqual(actual, expected)
		) {
			response.writeHead(404).end();
			return;
		}
		try {
			if (request.method === "GET" && request.url === "/ready") {
				response.writeHead((await options.ready()) ? 204 : 503).end();
			} else if (request.method === "POST" && request.url === "/sweep") {
				if (!(await options.ready())) {
					response.writeHead(503).end();
					return;
				}
				sweeping ??= options.sweep().finally(() => {
					sweeping = undefined;
				});
				await sweeping;
				response.writeHead(204).end();
			} else response.writeHead(404).end();
		} catch {
			response.writeHead(503).end();
		}
	});
}
