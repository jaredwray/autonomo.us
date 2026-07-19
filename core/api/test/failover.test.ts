import {
	afterAll,
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
} from "vitest";
import {
	DEFAULT_FAILOVER_POLICY,
	FailoverPolicyStore,
} from "../src/failover.js";
import { createServer } from "../src/server.js";
import { TelemetryService } from "../src/telemetry/telemetry.js";
import { type StubProvider, startStubProvider } from "./helpers.js";

describe("FailoverPolicyStore", () => {
	it("starts from the defaults and returns copies", () => {
		const store = new FailoverPolicyStore();
		const policy = store.get();
		expect(policy).toEqual(DEFAULT_FAILOVER_POLICY);
		policy.targets.push("mutated/model");
		expect(store.get().targets).toEqual([]);
	});

	it("seeds from config and normalizes targets", () => {
		const store = new FailoverPolicyStore({
			enabled: true,
			targets: [" a/one ", "a/one", "b/two", ""],
			timeoutMs: 250,
		});
		expect(store.get()).toEqual({
			enabled: true,
			targets: ["a/one", "b/two"],
			timeoutMs: 250,
		});
	});

	it("applies partial updates and keeps omitted fields", () => {
		const store = new FailoverPolicyStore({ enabled: true, timeoutMs: 100 });
		store.update({ targets: ["a/one"] });
		expect(store.get()).toEqual({
			enabled: true,
			targets: ["a/one"],
			timeoutMs: 100,
		});
		store.update({ enabled: false });
		expect(store.get().enabled).toBe(false);
		expect(store.get().targets).toEqual(["a/one"]);
	});

	it("clamps timeouts so they can never overflow Node timers", () => {
		// Above 2^31-1 ms, setTimeout degrades to a ~1ms timer — a mistyped env
		// value must not turn every attempt into an instant abort.
		expect(
			new FailoverPolicyStore({ timeoutMs: 3_000_000_000 }).get().timeoutMs,
		).toBe(600_000);
		expect(new FailoverPolicyStore({ timeoutMs: -50 }).get().timeoutMs).toBe(0);

		const store = new FailoverPolicyStore();
		expect(store.update({ timeoutMs: 1_000_000 }).timeoutMs).toBe(600_000);
		expect(store.update({ timeoutMs: 99.9 }).timeoutMs).toBe(99);
	});
});

describe("failover policy API", () => {
	let provider: StubProvider;
	let server: ReturnType<typeof createServer>;

	beforeAll(async () => {
		provider = await startStubProvider();
	});

	afterAll(async () => {
		await provider.close();
	});

	beforeEach(() => {
		server = createServer({
			registry: provider.registry,
			telemetry: new TelemetryService(),
			logger: false,
		});
	});

	afterEach(async () => {
		await server.close();
	});

	it("returns the default policy from GET /v1/failover", async () => {
		const response = await server.inject({
			method: "GET",
			url: "/v1/failover",
		});
		expect(response.statusCode).toBe(200);
		expect(JSON.parse(response.body)).toEqual(DEFAULT_FAILOVER_POLICY);
	});

	it("updates the policy via PUT and persists it for GET", async () => {
		const put = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: {
				enabled: true,
				targets: ["stub/chat-model"],
				timeoutMs: 5000,
			},
		});
		expect(put.statusCode).toBe(200);
		expect(JSON.parse(put.body)).toEqual({
			enabled: true,
			targets: ["stub/chat-model"],
			timeoutMs: 5000,
		});

		// Partial update keeps the other fields.
		const partial = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { timeoutMs: 250 },
		});
		expect(JSON.parse(partial.body)).toEqual({
			enabled: true,
			targets: ["stub/chat-model"],
			timeoutMs: 250,
		});

		const get = await server.inject({ method: "GET", url: "/v1/failover" });
		expect(JSON.parse(get.body)).toEqual({
			enabled: true,
			targets: ["stub/chat-model"],
			timeoutMs: 250,
		});
	});

	it("rejects targets that do not resolve to a registered provider", async () => {
		const response = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { targets: ["nope/some-model"] },
		});
		expect(response.statusCode).toBe(400);
		const body = JSON.parse(response.body);
		expect(body.error.type).toBe("unknown_target");
		expect(body.error.message).toContain("nope/some-model");
	});

	it("rejects invalid bodies", async () => {
		const negativeTimeout = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { timeoutMs: -5 },
		});
		expect(negativeTimeout.statusCode).toBe(400);

		const fractionalTimeout = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { timeoutMs: 1.5 },
		});
		expect(fractionalTimeout.statusCode).toBe(400);

		const emptyTarget = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { targets: [""] },
		});
		expect(emptyTarget.statusCode).toBe(400);

		const badEnabled = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { enabled: "maybe" },
		});
		expect(badEnabled.statusCode).toBe(400);

		const oversizedTimeout = await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { timeoutMs: 3_000_000_000 },
		});
		expect(oversizedTimeout.statusCode).toBe(400);
	});
});

describe("POST /v1/chat failover", () => {
	let provider: StubProvider;
	let telemetry: TelemetryService;
	let server: ReturnType<typeof createServer>;

	beforeAll(async () => {
		provider = await startStubProvider();
	});

	afterAll(async () => {
		await provider.close();
	});

	beforeEach(() => {
		telemetry = new TelemetryService();
	});

	afterEach(async () => {
		await server.close();
	});

	function startServer(failover?: FailoverPolicyStore) {
		server = createServer({
			registry: provider.registry,
			telemetry,
			failover,
			logger: false,
		});
		return server;
	}

	it("fails over to the next target when the provider errors", async () => {
		startServer();
		// Configure the policy through the public API, as the dashboard does.
		await server.inject({
			method: "PUT",
			url: "/v1/failover",
			payload: { enabled: true, targets: ["stub/chat-model"] },
		});

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.model).toBe("stub/chat-model");
		expect(body.message).toEqual({ role: "assistant", content: "Hello there" });
		expect(body.usage.totalTokens).toBe(15);
		expect(body.failover.requestedModel).toBe("stub/broken-model");
		expect(body.failover.attempts).toHaveLength(1);
		expect(body.failover.attempts[0].model).toBe("stub/broken-model");
		expect(body.failover.attempts[0].error).toContain("provider exploded");

		// Both attempts are visible in telemetry: the failure and the rescue.
		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(2);
		expect(summary.totalErrors).toBe(1);
		const [servedEvent, failedEvent] = telemetry.recentEvents();
		expect(servedEvent.type).toBe("gateway.chat");
		expect(servedEvent.data.model).toBe("stub/chat-model");
		expect(servedEvent.data.requestedModel).toBe("stub/broken-model");
		expect(failedEvent.type).toBe("gateway.error");
		expect(failedEvent.data.model).toBe("stub/broken-model");
	});

	it("fails over when an attempt exceeds the policy timeout", async () => {
		startServer(
			new FailoverPolicyStore({
				enabled: true,
				targets: ["stub/chat-model"],
				timeoutMs: 100,
			}),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/slow-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.model).toBe("stub/chat-model");
		expect(body.failover.attempts[0]).toEqual({
			model: "stub/slow-model",
			error: "timed out after 100ms",
		});
	});

	it("leaves the timeout unarmed when there is no fallback to try", async () => {
		// Enabled but with no usable target: aborting a slow-but-successful
		// request would buy nothing, so the attempt must be allowed to finish.
		startServer(
			new FailoverPolicyStore({ enabled: true, targets: [], timeoutMs: 100 }),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/slow-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.model).toBe("stub/slow-model");
		expect(body.message.content).toBe("Slow reply");
		expect(body.failover).toBeUndefined();
	});

	it("returns 502 with every attempt when all candidates fail", async () => {
		startServer(
			new FailoverPolicyStore({
				enabled: true,
				targets: ["stub/broken-too"],
			}),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(502);
		const body = JSON.parse(response.body);
		expect(body.error.type).toBe("provider_error");
		expect(body.error.attempts.map((a: { model: string }) => a.model)).toEqual([
			"stub/broken-model",
			"stub/broken-too",
		]);
		expect(telemetry.summary().totalErrors).toBe(2);
	});

	it("does not retry when the policy is disabled", async () => {
		startServer(
			new FailoverPolicyStore({
				enabled: false,
				targets: ["stub/chat-model"],
			}),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(502);
		const body = JSON.parse(response.body);
		expect(body.error.attempts).toBeUndefined();
		expect(telemetry.summary().totalRequests).toBe(1);
	});

	it("skips stale targets and never retries the requested model", async () => {
		// Constructed directly (as from env config): targets are not validated
		// against the registry, so `ghost/model` simulates a removed provider.
		startServer(
			new FailoverPolicyStore({
				enabled: true,
				targets: ["ghost/model", "stub/broken-model", "stub/chat-model"],
			}),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-model",
				messages: [{ role: "user", content: "Hi" }],
			},
		});

		expect(response.statusCode).toBe(200);
		const body = JSON.parse(response.body);
		expect(body.model).toBe("stub/chat-model");
		// One failed attempt only: ghost skipped, broken-model not tried twice.
		expect(body.failover.attempts).toHaveLength(1);
		expect(telemetry.summary().totalRequests).toBe(2);
	});
});

describe("POST /v1/chat failover (stream)", () => {
	let provider: StubProvider;
	let telemetry: TelemetryService;
	let server: ReturnType<typeof createServer>;

	beforeAll(async () => {
		provider = await startStubProvider();
	});

	afterAll(async () => {
		await provider.close();
	});

	beforeEach(() => {
		telemetry = new TelemetryService();
	});

	afterEach(async () => {
		await server.close();
	});

	function startServer(failover: FailoverPolicyStore) {
		server = createServer({
			registry: provider.registry,
			telemetry,
			failover,
			logger: false,
		});
		return server;
	}

	function parseSse(body: string) {
		const events = body
			.split("\n\n")
			.filter((line) => line.startsWith("data: "))
			.map((line) => line.slice("data: ".length));
		return {
			done: events.at(-1) === "[DONE]",
			parsed: events
				.filter((event) => event !== "[DONE]")
				.map((event) => JSON.parse(event)),
		};
	}

	it("streams from the fallback when the requested model fails to start", async () => {
		startServer(
			new FailoverPolicyStore({ enabled: true, targets: ["stub/chat-model"] }),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-model",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			},
		});

		expect(response.statusCode).toBe(200);
		const { done, parsed } = parseSse(response.body);
		expect(done).toBe(true);

		const failover = parsed.find((event) => event.type === "failover");
		expect(failover.from).toBe("stub/broken-model");
		expect(failover.to).toBe("stub/chat-model");
		expect(failover.error).toContain("provider exploded");

		const text = parsed
			.filter((event) => event.type === "text-delta")
			.map((event) => event.text)
			.join("");
		expect(text).toBe("Hello world");

		const finish = parsed.find((event) => event.type === "finish");
		expect(finish.model).toBe("stub/chat-model");
		expect(finish.usage.totalTokens).toBe(15);
		expect(finish.failover.requestedModel).toBe("stub/broken-model");
		expect(finish.failover.attempts).toHaveLength(1);

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(2);
		expect(summary.totalErrors).toBe(1);
	});

	it("fails over when the stream does not start within the timeout", async () => {
		startServer(
			new FailoverPolicyStore({
				enabled: true,
				targets: ["stub/chat-model"],
				timeoutMs: 100,
			}),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/slow-model",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			},
		});

		const { done, parsed } = parseSse(response.body);
		expect(done).toBe(true);
		const failover = parsed.find((event) => event.type === "failover");
		expect(failover.error).toBe("timed out after 100ms");
		const finish = parsed.find((event) => event.type === "finish");
		expect(finish.model).toBe("stub/chat-model");
	});

	it("does not fail over once output has been streamed", async () => {
		startServer(
			new FailoverPolicyStore({ enabled: true, targets: ["stub/chat-model"] }),
		);

		const response = await server.inject({
			method: "POST",
			url: "/v1/chat",
			payload: {
				model: "stub/broken-stream-model",
				messages: [{ role: "user", content: "Hi" }],
				stream: true,
			},
		});

		const { done, parsed } = parseSse(response.body);
		expect(done).toBe(true);
		// Output reached the client, then the provider died: the stream must
		// error out rather than restart on another model mid-response.
		const text = parsed
			.filter((event) => event.type === "text-delta")
			.map((event) => event.text)
			.join("");
		expect(text).toBe("partial ");
		expect(parsed.some((event) => event.type === "failover")).toBe(false);
		expect(parsed.some((event) => event.type === "error")).toBe(true);
		expect(parsed.some((event) => event.type === "finish")).toBe(false);

		const summary = telemetry.summary();
		expect(summary.totalRequests).toBe(1);
		expect(summary.totalErrors).toBe(1);
	});
});
