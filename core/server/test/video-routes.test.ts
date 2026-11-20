import type {
	TelemetryEvent,
	VideoConnection,
	VideoJob,
	VideoJobList,
	VideoModelList,
	VideoPolicy,
	VideoSettings,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROUTE_RULES } from "../src/auth/access.js";
import type { ApiConfig } from "../src/config.js";
import { redactDownloadUrl } from "../src/routes/video.js";
import type { FetchLike } from "../src/video/types.js";
import { startChannels } from "./channel-helpers.js";

const RUNWAY_KEY = "rw-route-secret-key-123";
const GOOGLE_KEY = "goog-route-secret-key-456";
const SIGNED = "https://cdn.example.com/out/video.mp4?X-Amz-Signature=abc";
const MP4 = Buffer.from("not really an mp4");

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	vi.useRealTimers();
	for (const close of cleanups.splice(0).reverse()) await close();
});

const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

/**
 * Runway and Google as their APIs answer. With `leak`, every answer is an
 * error that quotes the key it was sent.
 */
function providers() {
	const state = { leak: false, running: false, calls: [] as string[] };
	let tasks = 0;
	const fetchImpl: FetchLike = async (input, init = {}) => {
		const url = new URL(String(input));
		const method = init.method ?? "GET";
		state.calls.push(`${method} ${url.host}${url.pathname}`);
		const headers = new Headers(init.headers);
		const key =
			headers.get("authorization")?.replace("Bearer ", "") ??
			headers.get("x-goog-api-key") ??
			"";
		if (state.leak)
			return json(
				{
					error: `Key ${key} rejected; see https://provider.example/keys?k=${key}`,
					detail: `Key ${key} rejected`,
				},
				method === "POST" ? 503 : 500,
			);
		if (url.host === "api.dev.runwayml.com") {
			if (method === "POST") return json({ id: `task-${++tasks}` });
			if (method === "DELETE") return new Response(null, { status: 204 });
			if (state.running)
				return json({ id: "task", status: "RUNNING", progress: 0.5 });
			return json({
				id: "task",
				status: "SUCCEEDED",
				output: [SIGNED],
				cost: { credits: 150 },
			});
		}
		if (url.host === "generativelanguage.googleapis.com") {
			if (method === "POST")
				return json({ id: "v1_interaction", status: "in_progress" });
			if (state.running)
				return json({ id: "v1_interaction", status: "in_progress" });
			return json({
				id: "v1_interaction",
				status: "completed",
				steps: [
					{
						type: "model_output",
						content: [
							{
								type: "video",
								mime_type: "video/mp4",
								data: MP4.toString("base64"),
							},
						],
					},
				],
			});
		}
		return json({ error: "unexpected host" }, 404);
	};
	return { fetchImpl, state };
}

async function start(config: Partial<ApiConfig> = {}) {
	const provider = providers();
	const api = await startChannels(cleanups, config, {
		videoFetch: provider.fetchImpl,
	});
	const addRunway = () =>
		api.ok<VideoConnection>(
			"POST",
			"/v1/video/connections",
			{ body: { name: "runway", kind: "runway", apiKey: RUNWAY_KEY } },
			201,
		);
	const addGoogle = () =>
		api.ok<VideoConnection>(
			"POST",
			"/v1/video/connections",
			{ body: { name: "google", kind: "google", apiKey: GOOGLE_KEY } },
			201,
		);
	/** Moves the clock past the poll interval, leaving real timers alone. */
	const later = (ms = 6000) => {
		const now = Date.now();
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(now + ms);
	};
	return { ...api, provider, addRunway, addGoogle, later };
}

describe("video over the REST API", () => {
	it("adds a connection, starts a video, and follows it to a download link", async () => {
		const api = await start();
		const settings = await api.ok<VideoSettings>("GET", "/v1/video");
		expect(settings).toMatchObject({
			available: true,
			configured: false,
			connections: [],
			persistence: "memory",
		});
		expect(
			await api.ok<VideoModelList>("GET", "/v1/video/models"),
		).toMatchObject({
			available: false,
			canGenerate: true,
		});
		expect(
			await api.refused("POST", "/v1/video/jobs", { body: { prompt: "x" } }),
		).toMatchObject({
			status: 409,
			message: expect.stringContaining("not set up"),
		});

		const created = await api.addRunway();
		expect(created).toMatchObject({
			name: "runway",
			keyConfigured: true,
			source: "saved",
		});
		expect(JSON.stringify(created)).not.toContain(RUNWAY_KEY);
		const listed = await api.ok<VideoSettings>("GET", "/v1/video");
		expect(listed.configured).toBe(true);
		expect(JSON.stringify(listed)).not.toContain(RUNWAY_KEY);

		const job = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ body: { prompt: "A paper boat on a stream", durationSeconds: 6 } },
			202,
		);
		expect(job).toMatchObject({
			status: "queued",
			provider: "runway",
			model: "seedance2_5",
			durationSeconds: 6,
			costUsd: 1.8,
			createdBy: { kind: "user" },
		});
		expect(api.provider.state.calls).toEqual([
			"POST api.dev.runwayml.com/v1/text_to_video",
		]);

		api.later();
		const done = await api.ok<VideoJob>("GET", `/v1/video/jobs/${job.id}`);
		expect(done.status).toBe("succeeded");
		expect(done.video?.url).toMatch(
			new RegExp(`^${api.origin}/video/downloads/[A-Za-z0-9_-]{43}$`),
		);
		expect(JSON.stringify(done)).not.toContain("cdn.example.com");

		const download = await fetch(done.video?.url ?? "", { redirect: "manual" });
		expect(download.status).toBe(302);
		expect(download.headers.get("location")).toBe(SIGNED);
		expect(download.headers.get("cache-control")).toBe("private, no-store");
		expect(download.headers.get("referrer-policy")).toBe("no-referrer");

		const list = await api.ok<VideoJobList>("GET", "/v1/video/jobs?limit=10");
		expect(list.jobs.map((item) => item.id)).toEqual([job.id]);
		expect(list.nextBefore).toBeNull();
		expect(
			await api.refused("GET", `/v1/video/jobs/vid_${crypto.randomUUID()}`),
		).toEqual({
			status: 404,
			message: "Video job not found.",
		});
		expect((await api.call("GET", "/v1/video/jobs/not-an-id")).status).toBe(
			400,
		);
	});

	it("streams a Google video with headers that keep it from rendering as a page", async () => {
		const api = await start();
		await api.addGoogle();
		const job = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ body: { prompt: "x", resolution: "360p" } },
			202,
		);
		api.later();
		const done = await api.ok<VideoJob>("GET", `/v1/video/jobs/${job.id}`);
		const response = await fetch(done.video?.url ?? "");
		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toBe("video/mp4");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
		expect(response.headers.get("content-security-policy")).toBe(
			"default-src 'none'; sandbox",
		);
		expect(response.headers.get("content-disposition")).toBe(
			`attachment; filename="${job.id}.mp4"`,
		);
		expect(Buffer.from(await response.arrayBuffer())).toEqual(MP4);
		const missing = await fetch(
			`${api.origin}/video/downloads/${"a".repeat(43)}`,
		);
		expect(missing.status).toBe(404);
		expect((await fetch(`${api.origin}/video/downloads/short`)).status).toBe(
			404,
		);
	});

	it("changes the policy and connections, and cancels a job", async () => {
		const api = await start();
		await api.addRunway();
		await api.addGoogle();
		// The monthly budget moved to budgets; a script that still sends it hears so.
		expect(
			await api.refused("PUT", "/v1/video/policy", {
				body: {
					order: ["google"],
					callerVideosPerDay: 5,
					monthlyBudgetUsd: 10,
					maxDurationSeconds: 8,
					revision: 0,
				},
			}),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("is a budget now"),
		});
		const policy = await api.ok<VideoPolicy>("PUT", "/v1/video/policy", {
			body: {
				order: ["google"],
				callerVideosPerDay: 5,
				maxDurationSeconds: 8,
				revision: 0,
			},
		});
		expect(policy.revision).toBe(1);
		expect(
			await api.refused("PUT", "/v1/video/policy", {
				body: { ...policy, revision: 0 },
			}),
		).toMatchObject({ status: 409 });
		expect(
			await api.refused("POST", "/v1/video/jobs", {
				body: { prompt: "x", durationSeconds: 9 },
			}),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("up to 8 seconds"),
		});
		const job = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ body: { prompt: "x" } },
			202,
		);
		expect(job.provider).toBe("google");
		api.provider.state.running = true;
		const canceled = await api.ok<VideoJob>(
			"POST",
			`/v1/video/jobs/${job.id}/cancel`,
		);
		expect(canceled.status).toBe("canceled");
		expect(api.provider.state.calls).toContain(
			"POST generativelanguage.googleapis.com/v1beta/interactions/v1_interaction/cancel",
		);
		const updated = await api.ok<VideoConnection>(
			"PATCH",
			"/v1/video/connections/runway",
			{
				body: { enabled: false },
			},
		);
		expect(updated.enabled).toBe(false);
		await api.ok("DELETE", "/v1/video/connections/google", {}, 204);
		expect(
			(await api.ok<VideoSettings>("GET", "/v1/video")).policy.order,
		).toEqual([]);
		expect(
			await api.refused("POST", "/v1/video/connections", {
				body: { name: "x", kind: "sora", apiKey: "k" },
			}),
		).toMatchObject({ status: 400 });
	});

	it("lets members look but only admins and granted tokens change settings or spend", async () => {
		const api = await start();
		await api.addRunway();
		const member = await api.join("viewer@example.com");
		expect(
			(await api.call("GET", "/v1/video", { token: member.token })).status,
		).toBe(200);
		const models = await api.ok<VideoModelList>("GET", "/v1/video/models", {
			token: member.token,
		});
		expect(models.canGenerate).toBe(false);
		for (const [method, path, body] of [
			["POST", "/v1/video/jobs", { prompt: "x" }],
			["GET", "/v1/video/jobs", undefined],
			[
				"POST",
				"/v1/video/connections",
				{ name: "g", kind: "google", apiKey: "k" },
			],
			["DELETE", "/v1/video/connections/runway", undefined],
		] as const)
			expect(
				(await api.call(method, path, { token: member.token, body })).status,
			).toBe(403);

		const reader = await api.apiToken(["video:read"]);
		expect((await api.call("GET", "/v1/video", { token: reader })).status).toBe(
			200,
		);
		expect(
			(
				await api.ok<VideoModelList>("GET", "/v1/video/models", {
					token: reader,
				})
			).canGenerate,
		).toBe(false);
		expect(
			(
				await api.call("POST", "/v1/video/jobs", {
					token: reader,
					body: { prompt: "x" },
				})
			).status,
		).toBe(403);
		const editor = await api.apiToken(["video:edit"]);
		expect((await api.call("GET", "/v1/video", { token: editor })).status).toBe(
			200,
		);
		const spender = await api.apiToken(["video:generate"]);
		const job = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ token: spender, body: { prompt: "x" } },
			202,
		);
		expect(job.createdBy.kind).toBe("api-token");
		expect(
			(await api.call("GET", "/v1/video", { token: spender })).status,
		).toBe(403);
	});

	it("masks a download link's token in logs", () => {
		expect(redactDownloadUrl(`/video/downloads/${"a".repeat(43)}?x=1`)).toBe(
			"/video/downloads/[token]?x=1",
		);
		expect(redactDownloadUrl("/v1/abc/video/jobs")).toBe("/v1/abc/video/jobs");
	});

	it("declares a scope for every video route", () => {
		const routes = [...ROUTE_RULES.keys()].filter((key) =>
			key.includes("/video"),
		);
		expect(routes).toHaveLength(10);
		for (const key of routes)
			expect(ROUTE_RULES.get(key)).toMatchObject({ scope: "workspace" });
	});
});

describe("video over MCP", () => {
	it("lists the tools, and tells an agent what it can make", async () => {
		const api = await start();
		const plain = await api.agent("Plain");
		const tools = (
			(await api.rpc(plain.secret, "tools/list")).result as {
				tools: Array<{ name: string }>;
			}
		).tools
			.map((tool) => tool.name)
			.filter((name) => name.startsWith("video_"));
		expect(tools).toEqual([
			"video_models",
			"video_generate",
			"video_status",
			"video_cancel",
			"video_list",
		]);
		const none = await api.tool<VideoModelList>(plain.secret, "video_models");
		expect(none.data.available).toBe(false);
		expect(none.text).toContain("no video provider");
		await api.addRunway();
		const some = await api.tool<VideoModelList>(plain.secret, "video_models");
		expect(some.data).toMatchObject({ available: true, canGenerate: false });
		expect(some.text).toContain("seedance2_5");
		expect(some.text).toContain("lacks the video:generate grant");
	});

	it("needs the grant to start a video, and shows an agent only its own jobs", async () => {
		const api = await start();
		await api.addRunway();
		const plain = await api.agent("Plain");
		const refused = await api.rpc(plain.secret, "tools/call", {
			name: "video_generate",
			arguments: { prompt: "x" },
		});
		expect(refused.error).toMatchObject({
			code: -32001,
			message: expect.stringContaining("video:generate"),
		});
		const first = await api.agent("First", [
			"mcp:read",
			"mcp:call",
			"video:generate",
		]);
		const second = await api.agent("Second", [
			"mcp:read",
			"mcp:call",
			"video:generate",
		]);
		const started = await api.tool<VideoJob>(first.secret, "video_generate", {
			prompt: "A lighthouse at dusk",
			durationSeconds: 5,
		});
		expect(started.isError).toBe(false);
		expect(started.data).toMatchObject({
			status: "queued",
			createdBy: { id: `agent:${first.id}`, kind: "agent" },
		});
		expect(started.text).toContain(`Video ${started.data.id} is queued`);

		api.later();
		const ready = await api.tool<VideoJob>(first.secret, "video_status", {
			id: started.data.id,
		});
		expect(ready.data.status).toBe("succeeded");
		expect(ready.text).toContain(`${api.origin}/video/downloads/`);
		expect(ready.text).not.toContain("cdn.example.com");

		const elsewhere = await api.tool(second.secret, "video_status", {
			id: started.data.id,
		});
		expect(elsewhere).toMatchObject({
			isError: true,
			text: "Video job not found.",
		});
		const person = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ body: { prompt: "x" } },
			202,
		);
		expect(
			(await api.tool(first.secret, "video_cancel", { id: person.id })).text,
		).toBe("Video job not found.");
		const own = await api.tool<VideoJobList>(first.secret, "video_list", {});
		expect(own.data.jobs.map((job) => job.id)).toEqual([started.data.id]);
		expect(
			(await api.tool<VideoJobList>(second.secret, "video_list", {})).text,
		).toBe("You have no video jobs.");
		const bad = await api.rpc(first.secret, "tools/call", {
			name: "video_status",
			arguments: { id: "nope" },
		});
		expect(bad.error?.code).toBe(-32602);
	});

	it("serves no video tools and refuses the routes with VIDEO_DISABLED", async () => {
		const api = await start({ video: { disabled: true, connections: [] } });
		const agent = await api.agent("Agent", [
			"mcp:read",
			"mcp:call",
			"video:generate",
		]);
		const tools = (
			(await api.rpc(agent.secret, "tools/list")).result as {
				tools: Array<{ name: string }>;
			}
		).tools.map((tool) => tool.name);
		expect(tools.some((name) => name.startsWith("video_"))).toBe(false);
		expect((await api.ok<VideoSettings>("GET", "/v1/video")).available).toBe(
			false,
		);
		for (const [method, path, body] of [
			["GET", "/v1/video/models", undefined],
			["POST", "/v1/video/jobs", { prompt: "x" }],
			[
				"POST",
				"/v1/video/connections",
				{ name: "g", kind: "google", apiKey: "k" },
			],
		] as const)
			expect(await api.refused(method, path, { body })).toMatchObject({
				status: 503,
				message: expect.stringContaining("turned off"),
			});
	});

	it("uses environment connections in the default workspace", async () => {
		const api = await start({
			video: {
				disabled: false,
				connections: [
					{ name: "runway", kind: "runway", apiKey: RUNWAY_KEY, enabled: true },
				],
			},
		});
		const settings = await api.ok<VideoSettings>("GET", "/v1/video");
		expect(settings.connections).toMatchObject([
			{ name: "runway", source: "environment" },
		]);
		expect(
			await api.refused("DELETE", "/v1/video/connections/runway"),
		).toMatchObject({ status: 409 });
	});
});

describe("provider keys", () => {
	it("never appear in a response, a job, a tool result, or telemetry", async () => {
		const api = await start();
		await api.addRunway();
		await api.addGoogle();
		api.provider.state.leak = true;
		const seen: string[] = [];
		const job = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ body: { prompt: "x" } },
			202,
		);
		expect(job.status).toBe("failed");
		expect(job.attempts.map((attempt) => attempt.outcome)).toEqual([
			"provider-error",
			"provider-error",
		]);
		seen.push(JSON.stringify(job));
		const agent = await api.agent("Agent", [
			"mcp:read",
			"mcp:call",
			"video:generate",
		]);
		const tool = await api.tool<VideoJob>(agent.secret, "video_generate", {
			prompt: "y",
		});
		seen.push(tool.text, JSON.stringify(tool.data));
		// A job that started, then fails its status check.
		api.provider.state.leak = false;
		const started = await api.ok<VideoJob>(
			"POST",
			"/v1/video/jobs",
			{ body: { prompt: "z", provider: "runway" } },
			202,
		);
		api.provider.state.leak = true;
		api.later();
		seen.push(
			JSON.stringify(await api.ok("GET", `/v1/video/jobs/${started.id}`)),
		);
		seen.push(JSON.stringify(await api.ok("GET", "/v1/video")));
		seen.push(JSON.stringify(await api.ok("GET", "/v1/video/jobs")));
		const events = await api.ok<{ events: TelemetryEvent[] }>(
			"GET",
			"/v1/telemetry/events",
		);
		const video = events.events.filter(
			(event) => event.type === "gateway.video",
		);
		expect(video.length).toBeGreaterThan(0);
		seen.push(JSON.stringify(events));
		const everything = seen.join("\n");
		expect(everything).not.toContain(RUNWAY_KEY);
		expect(everything).not.toContain(GOOGLE_KEY);
		expect(everything).not.toContain("provider.example");
		expect(JSON.stringify(video)).not.toContain('"x"');
	});
});
