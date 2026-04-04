import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";

describe("health route", () => {
	const server = createServer();

	afterEach(async () => {
		await server.close();
	});

	it("should return ok status", async () => {
		const response = await server.inject({
			method: "GET",
			url: "/health",
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.status).toBe("ok");
		expect(body.timestamp).toBeDefined();
	});
});
