import { describe, expect, it } from "vitest";
import {
	googleAdapter,
	lumaAdapter,
	runwayAdapter,
	VIDEO_ADAPTERS,
} from "../src/video/providers/index.js";
import {
	providerMessage,
	safeResultUrl,
} from "../src/video/providers/shared.js";
import type {
	FetchLike,
	VideoCall,
	VideoConfig,
	VideoCreateResult,
	VideoFailure,
} from "../src/video/types.js";

const KEY = "video_live_very_secret_key_123";
const SIGNED = "https://cdn.example.com/out/video.mp4?X-Amz-Signature=abc";

type Seen = { url: string; init: RequestInit };

/** A fake fetch that records each request and answers with `answer`. */
function fake(
	answer: Response | ((seen: Seen) => Response | Promise<Response>),
) {
	const seen: Seen[] = [];
	const fetchImpl: FetchLike = async (input, init = {}) => {
		const request = { url: String(input), init };
		seen.push(request);
		return typeof answer === "function" ? answer(request) : answer.clone();
	};
	return { fetchImpl, seen };
}

const json = (
	body: unknown,
	status = 200,
	headers: Record<string, string> = {},
) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});

/** The request may have reached the provider before the connection failed. */
const failing: FetchLike = async () => {
	throw new TypeError(`fetch failed for https://api.example.com/?key=${KEY}`);
};

/** The connection was refused: the request never left. */
const refusedConnection: FetchLike = async () => {
	throw new TypeError("fetch failed", {
		cause: Object.assign(new Error("connect ECONNREFUSED"), {
			code: "ECONNREFUSED",
		}),
	});
};

/** An answer whose body breaks off while it is read. */
const brokenBody = (status: number) => () =>
	new Response(
		new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"id":'));
				controller.error(new Error("socket hang up"));
			},
		}),
		{ status, headers: { "content-type": "application/json" } },
	);

function call(overrides: Partial<VideoCall> = {}): VideoCall {
	return {
		model: "seedance2_5",
		prompt: "A red fox running through snow",
		durationSeconds: 5,
		aspectRatio: "16:9",
		resolution: "720p",
		signal: new AbortController().signal,
		...overrides,
	};
}

const runway: VideoConfig = {
	name: "runway",
	kind: "runway",
	apiKey: KEY,
	enabled: true,
};
const luma: VideoConfig = {
	name: "luma",
	kind: "luma",
	apiKey: KEY,
	enabled: true,
};
const google: VideoConfig = {
	name: "google-video",
	kind: "google",
	apiKey: KEY,
	enabled: true,
};
const signal = () => new AbortController().signal;

function header(seen: Seen, name: string) {
	return new Headers(seen.init.headers).get(name);
}

function expectFailure(
	result: VideoCreateResult,
	outcome: VideoFailure["outcome"],
): VideoFailure {
	expect(result.outcome).toBe(outcome);
	const failure = result as VideoFailure;
	expect(failure.detail).not.toContain(KEY);
	return failure;
}

describe("shared helpers", () => {
	it("removes keys and links from a provider's words and cuts them short", () => {
		expect(
			providerMessage(
				`bad key ${KEY} see https://docs.example.com/x?sig=1`,
				KEY,
			),
		).toBe("bad key [key] see [link]");
		expect(providerMessage("x".repeat(500)).length).toBe(300);
		expect(providerMessage(42)).toBe("");
		expect(providerMessage("echoed abc back", "abc")).toBe("echoed [key] back");
		expect(
			providerMessage("see ftp://files.example.com/x?token=secret", "ftp"),
		).toBe("see [link]");
	});

	it("accepts only https result links on public hosts", () => {
		expect(safeResultUrl(SIGNED)).toBe(SIGNED);
		expect(safeResultUrl(`${SIGNED}${"a".repeat(3000)}`)).toContain(
			"cdn.example.com",
		);
		expect(safeResultUrl("http://cdn.example.com/v.mp4")).toBeNull();
		expect(safeResultUrl("https://127.0.0.1/v.mp4")).toBeNull();
		expect(safeResultUrl("https://storage.internal/v.mp4")).toBeNull();
		expect(safeResultUrl("https://user:pw@cdn.example.com/v.mp4")).toBeNull();
		expect(safeResultUrl("https://cdn.example.com:9999/v.mp4")).toBeNull();
		expect(safeResultUrl("not a url")).toBeNull();
		expect(safeResultUrl(null)).toBeNull();
	});

	it("has an adapter for every kind", () => {
		expect(Object.keys(VIDEO_ADAPTERS).sort()).toEqual([
			"google",
			"luma",
			"runway",
		]);
	});
});

describe("Runway", () => {
	it("starts a text video with the documented request", async () => {
		const { fetchImpl, seen } = fake(
			json({ id: "task-1", estimatedCost: { credits: 150 } }),
		);
		const result = await runwayAdapter.create(runway, call(), fetchImpl);
		expect(result).toEqual({
			outcome: "accepted",
			providerJobId: "task-1",
			status: "queued",
		});
		expect(seen[0].url).toBe("https://api.dev.runwayml.com/v1/text_to_video");
		expect(seen[0].init.method).toBe("POST");
		expect(header(seen[0], "authorization")).toBe(`Bearer ${KEY}`);
		expect(header(seen[0], "x-runway-version")).toBe("2024-11-06");
		expect(JSON.parse(String(seen[0].init.body))).toEqual({
			model: "seedance2_5",
			promptText: "A red fox running through snow",
			ratio: "1280:720",
			duration: 5,
		});
	});

	it("starts from an image on the image endpoint, and maps sizes per resolution", async () => {
		const { fetchImpl, seen } = fake(json({ id: "task-2" }));
		await runwayAdapter.create(
			{ ...runway, baseUrl: "https://runway.test/" },
			call({
				model: "gen4.5",
				aspectRatio: "9:16",
				imageUrl: "https://images.example.com/cat.png",
			}),
			fetchImpl,
		);
		expect(seen[0].url).toBe("https://runway.test/v1/image_to_video");
		expect(JSON.parse(String(seen[0].init.body))).toMatchObject({
			model: "gen4.5",
			ratio: "720:1280",
			promptImage: "https://images.example.com/cat.png",
		});
		await runwayAdapter.create(
			runway,
			call({ resolution: "1080p", aspectRatio: "1:1" }),
			fetchImpl,
		);
		expect(JSON.parse(String(seen[1].init.body)).ratio).toBe("1440:1440");
		await runwayAdapter.create(runway, call({ resolution: "480p" }), fetchImpl);
		expect(JSON.parse(String(seen[2].init.body)).ratio).toBe("854:480");
		expectFailure(
			await runwayAdapter.create(
				runway,
				call({ resolution: "360p" }),
				fetchImpl,
			),
			"invalid",
		);
	});

	it("maps create errors without leaking the key", async () => {
		const cases: Array<
			[Response, VideoFailure["outcome"], Partial<VideoFailure>]
		> = [
			[
				json({ error: "Unauthorized" }, 401),
				"provider-error",
				{ problem: "key" },
			],
			[json({ error: "nope" }, 403), "provider-error", { problem: "key" }],
			[json({ error: "pay" }, 402), "provider-error", { problem: "credits" }],
			[
				json({ error: "You do not have enough credits" }, 400),
				"provider-error",
				{ problem: "credits" },
			],
			[
				json({ error: "Daily generation quota reached" }, 429, {
					"retry-after": "7",
				}),
				"provider-error",
				{ retryAfterMs: 7000 },
			],
			[
				json({ error: "slow" }, 429),
				"provider-error",
				{ retryAfterMs: 10_000 },
			],
			[
				json({ error: "slow" }, 429, { "retry-after": "86400" }),
				"provider-error",
				{ retryAfterMs: 600_000 },
			],
			[
				json({ error: "Billing is not enabled for this project" }, 403),
				"provider-error",
				{ problem: "credits" },
			],
			[
				json(
					{
						error: `Validation failed for ${KEY}`,
						issues: [
							{ code: "too_big", path: ["promptText"], message: "Too long" },
						],
					},
					400,
				),
				"invalid",
				{},
			],
			[json({ error: "boom" }, 503), "provider-error", {}],
		];
		for (const [response, outcome, extra] of cases) {
			const failure = expectFailure(
				await runwayAdapter.create(runway, call(), fake(response).fetchImpl),
				outcome,
			);
			expect(failure).toMatchObject({ billed: false, ...extra });
		}
		// A rate limit that mentions a quota is a rate limit, not a problem to fix.
		const limited = expectFailure(
			await runwayAdapter.create(
				runway,
				call(),
				fake(json({ error: "Quota exceeded for this minute" }, 429)).fetchImpl,
			),
			"provider-error",
		);
		expect(limited.problem).toBeUndefined();
		expect(limited.retryAfterMs).toBe(10_000);
		const invalid = expectFailure(
			await runwayAdapter.create(
				runway,
				call(),
				fake(
					json(
						{
							error: `Validation failed for ${KEY}`,
							issues: [{ path: ["promptText"], message: "Too long" }],
						},
						400,
					),
				).fetchImpl,
			),
			"invalid",
		);
		expect(invalid.detail).toContain("promptText: Too long");
		expect(invalid.detail).toContain("[key]");
	});

	it("treats a lost connection, a timeout, and an unnamed task safely", async () => {
		// The request may have been taken: no failover, and the hold stays.
		expect(
			expectFailure(
				await runwayAdapter.create(runway, call(), failing),
				"timeout",
			).detail,
		).toContain("may have started");
		// Refused before anything was sent: another provider may be tried.
		expectFailure(
			await runwayAdapter.create(runway, call(), refusedConnection),
			"provider-error",
		);
		// Accepted, but the answer broke off: the video may exist.
		expectFailure(
			await runwayAdapter.create(
				runway,
				call(),
				fake(brokenBody(200)).fetchImpl,
			),
			"timeout",
		);
		// An error status whose body broke off is still that error.
		expect(
			expectFailure(
				await runwayAdapter.create(
					runway,
					call(),
					fake(brokenBody(401)).fetchImpl,
				),
				"provider-error",
			),
		).toMatchObject({ problem: "key" });
		// A successful answer too large to read may also be a started video.
		expectFailure(
			await runwayAdapter.create(
				runway,
				call(),
				fake(
					() =>
						new Response("{}", {
							headers: { "content-length": String(8 * 1024 * 1024) },
						}),
				).fetchImpl,
			),
			"timeout",
		);
		const controller = new AbortController();
		controller.abort();
		expectFailure(
			await runwayAdapter.create(
				runway,
				call({ signal: controller.signal }),
				failing,
			),
			"timeout",
		);
		expectFailure(
			await runwayAdapter.create(runway, call(), fake(json({})).fetchImpl),
			"timeout",
		);
		expectFailure(
			await runwayAdapter.create(
				{ ...runway, apiKey: undefined },
				call(),
				fake(json({ id: "x" })).fetchImpl,
			),
			"provider-error",
		);
	});

	it("follows a task through every status", async () => {
		const poll = (body: unknown, status = 200) =>
			runwayAdapter.poll(
				runway,
				"task-1",
				signal(),
				fake(json(body, status)).fetchImpl,
			);
		const { fetchImpl, seen } = fake(json({ status: "PENDING" }));
		expect(
			await runwayAdapter.poll(runway, "task/1", signal(), fetchImpl),
		).toEqual({
			state: "queued",
			progress: null,
		});
		expect(seen[0].url).toBe("https://api.dev.runwayml.com/v1/tasks/task%2F1");
		expect(header(seen[0], "x-runway-version")).toBe("2024-11-06");
		expect(await poll({ status: "THROTTLED" })).toEqual({
			state: "queued",
			progress: null,
		});
		expect(await poll({ status: "RUNNING", progress: 0.42 })).toEqual({
			state: "running",
			progress: 42,
		});
		expect(await poll({ status: "RUNNING", progress: 7 })).toEqual({
			state: "running",
			progress: null,
		});
		expect(await poll({ status: "SUCCEEDED", output: [SIGNED] })).toEqual({
			state: "succeeded",
			delivery: { kind: "url", url: SIGNED, ttlMs: runwayAdapter.resultTtlMs },
		});
		expect(
			await poll({ status: "SUCCEEDED", output: ["http://10.0.0.1/v.mp4"] }),
		).toMatchObject({ state: "failed", code: "provider_error", billed: true });
		expect(await poll({ status: "CANCELLED" })).toEqual({ state: "canceled" });
		expect(await poll({ status: "CANCELED" })).toEqual({ state: "canceled" });
		expect(await poll({ status: "SOMETHING_NEW" })).toEqual({
			state: "running",
			progress: null,
		});
		expect(await poll({ error: "not found" }, 404)).toEqual({ state: "gone" });
	});

	it("maps task failures, billing by the cost Runway reports", async () => {
		const poll = (body: unknown) =>
			runwayAdapter.poll(runway, "t", signal(), fake(json(body)).fetchImpl);
		expect(
			await poll({
				status: "FAILED",
				failure: "Prompt was flagged",
				failureCode: "SAFETY.INPUT.TEXT",
				cost: { credits: 150 },
			}),
		).toMatchObject({ state: "failed", code: "moderated", billed: true });
		expect(
			await poll({
				status: "FAILED",
				failure: "flagged",
				failureCode: "INPUT_PREPROCESSING.SAFETY.TEXT",
				cost: { credits: 0 },
			}),
		).toMatchObject({ state: "failed", code: "moderated", billed: false });
		expect(
			await poll({
				status: "FAILED",
				failure: "x",
				failureCode: "SAFETY.INPUT.IMAGE",
			}),
		).toMatchObject({ billed: true });
		expect(
			await poll({
				status: "FAILED",
				failure: "bad image",
				failureCode: "ASSET.INVALID",
			}),
		).toMatchObject({ state: "failed", code: "invalid_input", billed: false });
		const internal = await poll({
			status: "FAILED",
			failure: `see https://runway.example/x?k=${KEY}`,
			failureCode: "INTERNAL",
			cost: { credits: 0 },
		});
		expect(internal).toMatchObject({ code: "provider_error", billed: false });
		expect(JSON.stringify(internal)).not.toContain(KEY);
		expect(JSON.stringify(internal)).not.toContain("runway.example");
	});

	it("reports a poll that could not be read as unknown", async () => {
		expect(
			await runwayAdapter.poll(runway, "t", signal(), failing),
		).toMatchObject({
			state: "unknown",
		});
		expect(
			await runwayAdapter.poll(
				runway,
				"t",
				signal(),
				fake(json({ error: "x" }, 401)).fetchImpl,
			),
		).toMatchObject({ state: "unknown", problem: "key" });
		expect(
			await runwayAdapter.poll(
				runway,
				"t",
				signal(),
				fake(json({ error: "x" }, 429, { "retry-after": "3" })).fetchImpl,
			),
		).toMatchObject({ state: "unknown", retryAfterMs: 3000 });
		const controller = new AbortController();
		controller.abort();
		expect(
			(await runwayAdapter.poll(runway, "t", controller.signal, failing)) as {
				detail: string;
			},
		).toMatchObject({ detail: expect.stringContaining("ran out of time") });
	});

	it("cancels with DELETE and never throws", async () => {
		const { fetchImpl, seen } = fake(new Response(null, { status: 204 }));
		await runwayAdapter.cancel?.(runway, "task-1", signal(), fetchImpl);
		expect(seen[0]).toMatchObject({
			url: "https://api.dev.runwayml.com/v1/tasks/task-1",
			init: { method: "DELETE" },
		});
		await expect(
			runwayAdapter.cancel?.(runway, "t", signal(), failing),
		).resolves.toBeUndefined();
	});

	it("estimates from the list prices, with a minimum and a safe fallback", () => {
		const estimate = (overrides: Partial<VideoCall>) =>
			runwayAdapter.estimateCostUsd(runway, call(overrides));
		expect(estimate({})).toBeCloseTo(1.5);
		expect(estimate({ durationSeconds: 2, model: "seedance2_5" })).toBeCloseTo(
			0.8,
		);
		expect(estimate({ resolution: "1080p", durationSeconds: 10 })).toBeCloseTo(
			6.8,
		);
		expect(estimate({ model: "gen4.5", durationSeconds: 10 })).toBeCloseTo(1.2);
		expect(estimate({ model: "unknown", durationSeconds: 4 })).toBeCloseTo(2);
	});
});

describe("Luma", () => {
	it("starts a video with the documented request", async () => {
		const { fetchImpl, seen } = fake(
			json({ id: "gen-1", state: "queued" }, 201),
		);
		const result = await lumaAdapter.create(
			luma,
			call({
				model: "ray-3.2",
				durationSeconds: 10,
				resolution: "540p",
				imageUrl: "https://images.example.com/a.jpg",
			}),
			fetchImpl,
		);
		expect(result).toEqual({
			outcome: "accepted",
			providerJobId: "gen-1",
			status: "queued",
		});
		expect(seen[0].url).toBe("https://agents.lumalabs.ai/v1/generations");
		expect(header(seen[0], "authorization")).toBe(`Bearer ${KEY}`);
		expect(JSON.parse(String(seen[0].init.body))).toEqual({
			model: "ray-3.2",
			type: "video",
			prompt: "A red fox running through snow",
			aspect_ratio: "16:9",
			video: {
				duration: "10s",
				resolution: "540p",
				start_frame: { url: "https://images.example.com/a.jpg" },
			},
		});
		expect(
			await lumaAdapter.create(
				luma,
				call({ model: "ray-3.2" }),
				fake(json({ id: "gen-2", state: "processing" }, 201)).fetchImpl,
			),
		).toMatchObject({ status: "running" });
	});

	it("maps create errors", async () => {
		const create = (response: Response) =>
			lumaAdapter.create(
				luma,
				call({ model: "ray-3.2" }),
				fake(response).fetchImpl,
			);
		expect(
			expectFailure(
				await create(json({ detail: "Invalid API key" }, 401)),
				"provider-error",
			),
		).toMatchObject({ problem: "key" });
		expect(
			expectFailure(
				await create(
					json({ detail: [{ loc: ["body", "prompt"], msg: "too long" }] }, 422),
				),
				"invalid",
			).detail,
		).toContain("body.prompt: too long");
		expect(
			expectFailure(
				await create(json({ detail: "Too many concurrent jobs" }, 429)),
				"provider-error",
			),
		).toMatchObject({ retryAfterMs: 10_000 });
		expect(
			expectFailure(
				await create(json({ detail: "Insufficient balance" }, 400)),
				"provider-error",
			),
		).toMatchObject({ problem: "credits" });
		expectFailure(await create(json({}, 201)), "timeout");
		expectFailure(await lumaAdapter.create(luma, call(), failing), "timeout");
		expectFailure(
			await lumaAdapter.create(luma, call(), refusedConnection),
			"provider-error",
		);
		expectFailure(
			await lumaAdapter.create({ ...luma, apiKey: "" }, call(), failing),
			"provider-error",
		);
	});

	it("follows a generation, taking a fresh link on each poll", async () => {
		const poll = (body: unknown, status = 200) =>
			lumaAdapter.poll(
				luma,
				"gen-1",
				signal(),
				fake(json(body, status)).fetchImpl,
			);
		const { fetchImpl, seen } = fake(json({ state: "queued" }));
		expect(await lumaAdapter.poll(luma, "gen-1", signal(), fetchImpl)).toEqual({
			state: "queued",
			progress: null,
		});
		expect(seen[0].url).toBe("https://agents.lumalabs.ai/v1/generations/gen-1");
		expect(await poll({ state: "processing" })).toEqual({
			state: "running",
			progress: null,
		});
		expect(
			await poll({
				state: "completed",
				output: [
					{ type: "image", url: "https://cdn.example.com/thumb.jpg" },
					{ type: "video", url: SIGNED },
				],
			}),
		).toEqual({
			state: "succeeded",
			delivery: { kind: "url", url: SIGNED, ttlMs: 55 * 60_000 },
		});
		expect(await poll({ state: "completed", output: [] })).toMatchObject({
			state: "failed",
			billed: true,
		});
		expect(await poll({ state: "brand_new" })).toEqual({
			state: "running",
			progress: null,
		});
		expect(await poll({ detail: "Not found" }, 404)).toEqual({ state: "gone" });
		expect(await poll({ detail: "nope" }, 401)).toMatchObject({
			state: "unknown",
			problem: "key",
		});
		expect(await lumaAdapter.poll(luma, "g", signal(), failing)).toMatchObject({
			state: "unknown",
		});
	});

	it("maps every failure code", async () => {
		const failed = (code: string) =>
			lumaAdapter.poll(
				luma,
				"g",
				signal(),
				fake(
					json({ state: "failed", failure_code: code, failure_reason: "why" }),
				).fetchImpl,
			);
		expect(await failed("content_moderated")).toMatchObject({
			code: "moderated",
			billed: true,
		});
		// Once Luma reports what it charged, that decides.
		const charged = (credits: number) =>
			lumaAdapter.poll(
				luma,
				"g",
				signal(),
				fake(
					json({
						state: "failed",
						failure_code: "content_moderated",
						usage: { credits_charged: credits },
					}),
				).fetchImpl,
			);
		expect(await charged(0)).toMatchObject({
			code: "moderated",
			billed: false,
		});
		expect(await charged(100)).toMatchObject({
			code: "moderated",
			billed: true,
		});
		for (const code of [
			"image_too_large",
			"unsupported_format",
			"corrupt_input",
			"invalid_request",
		])
			expect(await failed(code)).toMatchObject({
				code: "invalid_input",
				billed: false,
			});
		expect(await failed("output_not_found")).toEqual({ state: "gone" });
		expect(await failed("budget_exhausted")).toMatchObject({
			code: "provider_error",
			problem: "credits",
			billed: false,
		});
		expect(await failed("generation_failed")).toMatchObject({
			code: "provider_error",
			billed: false,
		});
	});

	it("has no cancel, and estimates from credits at the plan's price", () => {
		expect(lumaAdapter.cancel).toBeUndefined();
		const estimate = (config: VideoConfig, overrides: Partial<VideoCall>) =>
			lumaAdapter.estimateCostUsd(
				config,
				call({ model: "ray-3.2", ...overrides }),
			);
		expect(estimate(luma, {})).toBeCloseTo(1);
		expect(
			estimate(luma, { durationSeconds: 10, resolution: "1080p" }),
		).toBeCloseTo(12);
		expect(
			estimate({ ...luma, creditPriceUsd: 0.005 }, { resolution: "360p" }),
		).toBeCloseTo(0.1);
		expect(estimate(luma, { durationSeconds: 7 })).toBeCloseTo(3.5);
	});
});

describe("Google", () => {
	const video = Buffer.from("fake mp4 bytes").toString("base64");
	const completed = (steps: unknown) => ({
		id: "v1_abc",
		status: "completed",
		steps,
	});

	it("starts a background interaction with the key in a header", async () => {
		const { fetchImpl, seen } = fake(
			json({ id: "v1_abc", status: "in_progress" }),
		);
		const result = await googleAdapter.create(
			google,
			call({
				model: "gemini-omni-1.2-flash",
				resolution: "360p",
				aspectRatio: "9:16",
			}),
			fetchImpl,
		);
		expect(result).toEqual({
			outcome: "accepted",
			providerJobId: "v1_abc",
			status: "running",
		});
		expect(seen[0].url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/interactions",
		);
		expect(seen[0].url).not.toContain(KEY);
		expect(header(seen[0], "x-goog-api-key")).toBe(KEY);
		expect(header(seen[0], "api-revision")).toBe("2026-05-20");
		expect(JSON.parse(String(seen[0].init.body))).toEqual({
			model: "gemini-omni-1.2-flash",
			input: "A red fox running through snow",
			background: true,
			store: true,
			response_format: {
				type: "video",
				aspect_ratio: "9:16",
				resolution: "360p",
				duration: "5s",
			},
		});
		expect(
			await googleAdapter.create(
				google,
				call(),
				fake(json({ id: "v1_b" })).fetchImpl,
			),
		).toMatchObject({ status: "queued" });
		expect(
			await googleAdapter.create(
				google,
				call(),
				fake(json(completed([]))).fetchImpl,
			),
		).toMatchObject({ outcome: "accepted", status: "running" });
	});

	it("refuses an image start, and maps create errors and refusals", async () => {
		const { fetchImpl, seen } = fake(json({ id: "x" }));
		expectFailure(
			await googleAdapter.create(
				google,
				call({ imageUrl: "https://images.example.com/a.png" }),
				fetchImpl,
			),
			"invalid",
		);
		expect(seen).toHaveLength(0);
		const create = (response: Response) =>
			googleAdapter.create(google, call(), fake(response).fetchImpl);
		expect(
			expectFailure(
				await create(
					json(
						{ error: { code: 403, message: `API key ${KEY} not valid` } },
						403,
					),
				),
				"provider-error",
			),
		).toMatchObject({ problem: "key" });
		expectFailure(
			await create(json({ error: { message: "bad duration" } }, 400)),
			"invalid",
		);
		expect(
			expectFailure(
				await create(
					json({
						id: "v1_x",
						status: "failed",
						errors: [
							{ code: "PROMPT_BLOCKED", message: "Blocked by safety filters" },
						],
					}),
				),
				"refused",
			).detail,
		).toContain("refused the prompt");
		expectFailure(
			await create(
				json({
					id: "v1_x",
					status: "failed",
					errors: [{ message: "overloaded" }],
				}),
			),
			"provider-error",
		);
		expectFailure(await create(json({ status: "in_progress" })), "timeout");
		expectFailure(
			await googleAdapter.create(google, call(), failing),
			"timeout",
		);
		expectFailure(
			await googleAdapter.create(google, call(), refusedConnection),
			"provider-error",
		);
	});

	it("finds the video block at any depth and serves its bytes", async () => {
		const nested = completed([
			{ type: "thought", content: [{ type: "text", text: "..." }] },
			{
				type: "model_output",
				content: [{ type: "video", mime_type: "video/mp4", data: video }],
			},
		]);
		expect(
			await googleAdapter.poll(
				google,
				"v1_abc",
				signal(),
				fake(json(nested)).fetchImpl,
			),
		).toEqual({ state: "succeeded", delivery: { kind: "bytes" } });
		const deeper = completed([
			{
				type: "model_output",
				content: [{ parts: [{ type: "video", data: video }] }],
			},
		]);
		expect(
			await googleAdapter.poll(
				google,
				"v1_abc",
				signal(),
				fake(json(deeper)).fetchImpl,
			),
		).toMatchObject({ state: "succeeded" });
		const { fetchImpl, seen } = fake(json(nested));
		const content = await googleAdapter.content?.(
			google,
			"v1_abc",
			signal(),
			fetchImpl,
		);
		expect(content).toMatchObject({ kind: "ok", contentType: "video/mp4" });
		expect(
			Buffer.from((content as { bytes: Uint8Array }).bytes).toString(),
		).toBe("fake mp4 bytes");
		expect(seen[0].url).toBe(
			"https://generativelanguage.googleapis.com/v1beta/interactions/v1_abc",
		);
		expect(header(seen[0], "x-goog-api-key")).toBe(KEY);
	});

	it("maps every interaction status", async () => {
		const poll = (body: unknown, status = 200) =>
			googleAdapter.poll(
				google,
				"v1_abc",
				signal(),
				fake(json(body, status)).fetchImpl,
			);
		expect(await poll({ status: "in_progress" })).toEqual({
			state: "running",
			progress: null,
		});
		expect(
			await poll(completed([{ type: "model_output", content: [] }])),
		).toMatchObject({
			state: "failed",
			billed: true,
		});
		expect(
			await poll({
				status: "failed",
				errors: [{ code: "SAFETY", message: "blocked" }],
			}),
		).toMatchObject({ state: "failed", code: "moderated" });
		expect(
			await poll({ status: "failed", error: { message: "internal" } }),
		).toMatchObject({
			state: "failed",
			code: "provider_error",
			billed: false,
		});
		expect(await poll({ status: "cancelled" })).toEqual({ state: "canceled" });
		for (const status of [
			"requires_action",
			"incomplete",
			"requires_continuation",
		])
			expect(await poll({ status })).toMatchObject({
				state: "failed",
				billed: false,
			});
		expect(await poll({ status: "new_state" })).toEqual({
			state: "running",
			progress: null,
		});
		expect(await poll({ error: { message: "gone" } }, 404)).toEqual({
			state: "gone",
		});
		expect(await poll({ error: { message: "slow" } }, 429)).toMatchObject({
			state: "unknown",
			retryAfterMs: 10_000,
		});
		expect(
			await googleAdapter.poll(google, "v", signal(), failing),
		).toMatchObject({
			state: "unknown",
		});
	});

	it("refuses a result too large to hold", async () => {
		const huge = () =>
			new Response("x", {
				headers: { "content-length": String(64 * 1024 * 1024) },
			});
		expect(
			await googleAdapter.poll(google, "v", signal(), fake(huge).fetchImpl),
		).toMatchObject({
			state: "failed",
			billed: true,
		});
		expect(
			await googleAdapter.content?.(
				google,
				"v",
				signal(),
				fake(huge).fetchImpl,
			),
		).toMatchObject({ kind: "error" });
	});

	it("reports content that is gone or unreachable", async () => {
		const content = (response: Response) =>
			googleAdapter.content?.(google, "v", signal(), fake(response).fetchImpl);
		expect(await content(json({}, 404))).toEqual({ kind: "gone" });
		expect(await content(json(completed([])))).toEqual({ kind: "gone" });
		expect(await content(json({}, 500))).toMatchObject({ kind: "error" });
		expect(
			await googleAdapter.content?.(google, "v", signal(), failing),
		).toMatchObject({
			kind: "error",
		});
	});

	it("cancels and estimates", async () => {
		const { fetchImpl, seen } = fake(json({}));
		await googleAdapter.cancel?.(google, "v1_abc", signal(), fetchImpl);
		expect(seen[0]).toMatchObject({
			url: "https://generativelanguage.googleapis.com/v1beta/interactions/v1_abc/cancel",
			init: { method: "POST" },
		});
		await expect(
			googleAdapter.cancel?.(google, "v", signal(), failing),
		).resolves.toBeUndefined();
		expect(googleAdapter.estimateCostUsd(google, call())).toBeCloseTo(0.35);
		expect(
			googleAdapter.estimateCostUsd(google, call({ resolution: "360p" })),
		).toBeCloseTo(0.115);
		expect(
			googleAdapter.estimateCostUsd(google, call({ resolution: "1080p" })),
		).toBeCloseTo(2.5);
	});
});
