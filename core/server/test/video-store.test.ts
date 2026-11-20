import { DEFAULT_VIDEO_POLICY } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { controlPlaneConnection } from "../src/mongo.js";
import { ServiceError } from "../src/service-error.js";
import { type VideoJobRecord, VideoJobStore } from "../src/video/jobs.js";
import { VideoStore, validateVideoPolicy } from "../src/video/store.js";
import type { VideoConfig } from "../src/video/types.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const DEFAULT = { id: "00000000-0000-4000-8000-000000000001", isDefault: true };
const OTHER = { id: "00000000-0000-4000-8000-000000000002", isDefault: false };
const ENV_RUNWAY: VideoConfig = {
	name: "runway",
	kind: "runway",
	apiKey: "rw-env-key",
	enabled: true,
};
const KEY = "luma-saved-secret";

const available = await mongoAvailable();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ServiceError)
			return { status: error.statusCode, message: error.message };
		throw error;
	}
	throw new Error("Expected a refusal.");
}

function dropOnCleanup(url: string, close: () => Promise<void>) {
	cleanups.push(async () => {
		const client = new MongoClient(url);
		await client.db().dropDatabase();
		await client.close();
		await close();
	});
}

function stores(): Array<[string, () => Promise<VideoStore>]> {
	const memory: [string, () => Promise<VideoStore>] = [
		"memory",
		async () => new VideoStore([ENV_RUNWAY]),
	];
	if (!available) return [memory];
	return [
		memory,
		[
			"mongodb",
			async () => {
				const url = uniqueMongoUrl("vstore");
				const store = new VideoStore([ENV_RUNWAY], url);
				dropOnCleanup(url, () => store.close());
				return store;
			},
		],
	];
}

function jobStores(
	now: () => Date = () => new Date(),
): Array<[string, () => Promise<VideoJobStore>]> {
	const memory: [string, () => Promise<VideoJobStore>] = [
		"memory",
		async () => new VideoJobStore(undefined, now),
	];
	if (!available) return [memory];
	return [
		memory,
		[
			"mongodb",
			async () => {
				const url = uniqueMongoUrl("vjobs");
				const mongo = controlPlaneConnection(url);
				const jobs = new VideoJobStore(mongo, now);
				dropOnCleanup(url, () => jobs.close());
				return jobs;
			},
		],
	];
}

describe.each(stores())("VideoStore (%s)", (_name, make) => {
	it("lists environment connections in the default workspace only, without keys", async () => {
		const store = await make();
		const list = await store.list(DEFAULT);
		expect(list).toEqual([
			expect.objectContaining({
				name: "runway",
				kind: "runway",
				keyConfigured: true,
				source: "environment",
				usage: expect.objectContaining({ videos: 0, costUsd: 0 }),
			}),
		]);
		expect(JSON.stringify(list)).not.toContain("rw-env-key");
		expect(await store.list(OTHER)).toEqual([]);
		expect(store.persistence).toBe(_name === "memory" ? "memory" : "mongodb");
	});

	it("saves connections, validates each kind, and never returns the key", async () => {
		const store = await make();
		const created = await store.create(OTHER, {
			name: "luma",
			kind: "luma",
			apiKey: ` ${KEY} `,
			creditPriceUsd: 0.008,
			defaultModel: "ray-3.2",
		});
		expect(created).toMatchObject({
			name: "luma",
			keyConfigured: true,
			enabled: true,
			creditPriceUsd: 0.008,
			defaultModel: "ray-3.2",
			source: "saved",
		});
		expect(JSON.stringify(await store.list(OTHER))).not.toContain(KEY);
		expect((await store.connection(OTHER, "luma"))?.apiKey).toBe(KEY);

		expect(
			await refusal(
				store.create(OTHER, { name: "luma", kind: "luma", apiKey: "x" }),
			),
		).toMatchObject({ status: 409 });
		expect(
			await refusal(
				store.create(OTHER, { name: "Bad Name", kind: "luma", apiKey: "x" }),
			),
		).toMatchObject({ status: 400 });
		expect(
			await refusal(
				store.create(OTHER, { name: "v", kind: "sora" as never, apiKey: "x" }),
			),
		).toMatchObject({ status: 400 });
		expect(
			await refusal(
				store.create(OTHER, { name: "v", kind: "runway", apiKey: " " }),
			),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("API key"),
		});
		expect(
			await refusal(
				store.create(OTHER, {
					name: "v",
					kind: "runway",
					apiKey: "x",
					defaultModel: "ray-3.2",
				}),
			),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("not a runway model"),
		});
		expect(
			await refusal(
				store.create(OTHER, {
					name: "v",
					kind: "runway",
					apiKey: "x",
					creditPriceUsd: 1,
				}),
			),
		).toMatchObject({
			status: 400,
			message: expect.stringContaining("only used by Luma"),
		});
		expect(
			await refusal(
				store.create(OTHER, {
					name: "v",
					kind: "luma",
					apiKey: "x",
					creditPriceUsd: 11,
				}),
			),
		).toMatchObject({ status: 400 });
	});

	it("caps the number of connections", async () => {
		const store = await make();
		for (let index = 0; index < 10; index++)
			await store.create(OTHER, {
				name: `v${index}`,
				kind: "google",
				apiKey: "k",
			});
		expect(
			await refusal(
				store.create(OTHER, { name: "v10", kind: "google", apiKey: "k" }),
			),
		).toMatchObject({
			status: 409,
			message: expect.stringContaining("at most 10"),
		});
	});

	it("updates the fields sent, keeps the key unless one is sent, and a new key clears a problem", async () => {
		const store = await make();
		await store.create(OTHER, { name: "g", kind: "google", apiKey: "old-key" });
		await store.setProblem(OTHER, "g", {
			kind: "key",
			detail: "refused",
			at: "2026-01-01T00:00:00Z",
		});
		expect((await store.list(OTHER))[0].problem).toMatchObject({ kind: "key" });
		const off = await store.update(OTHER, "g", { enabled: false });
		expect(off).toMatchObject({ enabled: false, problem: { kind: "key" } });
		expect((await store.connection(OTHER, "g"))?.apiKey).toBe("old-key");
		const rekeyed = await store.update(OTHER, "g", {
			apiKey: "new-key",
			defaultModel: "gemini-omni-1.2-flash",
		});
		expect(rekeyed).toMatchObject({
			problem: null,
			defaultModel: "gemini-omni-1.2-flash",
		});
		expect((await store.connection(OTHER, "g"))?.apiKey).toBe("new-key");
		const cleared = await store.update(OTHER, "g", { defaultModel: "" });
		expect(cleared.defaultModel).toBeUndefined();
		expect(await refusal(store.update(OTHER, "missing", {}))).toMatchObject({
			status: 404,
		});
		expect(
			await refusal(store.update(DEFAULT, "runway", { enabled: false })),
		).toMatchObject({
			status: 409,
			message: expect.stringContaining("environment"),
		});
		expect(await refusal(store.remove(DEFAULT, "runway"))).toMatchObject({
			status: 409,
		});
		expect(await refusal(store.remove(OTHER, "missing"))).toMatchObject({
			status: 404,
		});
	});

	it("records problems of environment connections in memory", async () => {
		const store = await make();
		await store.setProblem(DEFAULT, "runway", {
			kind: "credits",
			detail: "out",
			at: "2026-01-01T00:00:00Z",
		});
		expect((await store.entries(DEFAULT))[0].problem).toMatchObject({
			kind: "credits",
		});
		await store.setProblem(OTHER, "runway", null);
	});

	it("keeps a policy with a revision, refuses a stale one, and drops removed connections from the order", async () => {
		const store = await make();
		await store.create(OTHER, { name: "a", kind: "google", apiKey: "k" });
		await store.create(OTHER, { name: "b", kind: "luma", apiKey: "k" });
		const first = await store.policy(OTHER);
		expect(first).toEqual({ ...DEFAULT_VIDEO_POLICY, revision: 0 });
		const saved = await store.updatePolicy(OTHER, {
			order: ["b", "a"],
			revision: 0,
		});
		expect(saved).toEqual({ order: ["b", "a"], revision: 1 });
		expect(
			await refusal(store.updatePolicy(OTHER, { ...saved, revision: 0 })),
		).toMatchObject({ status: 409 });
		expect(
			await refusal(store.updatePolicy(OTHER, { ...saved, order: ["nope"] })),
		).toMatchObject({ status: 400 });
		await store.remove(OTHER, "b");
		expect((await store.policy(OTHER)).order).toEqual(["a"]);
		expect(await store.policy(DEFAULT)).toMatchObject({ revision: 0 });
	});

	it("holds against each limit's count, all or none, counts the month's spend, and gives holds back", async () => {
		const store = await make();
		const hold = (callerId: string, costUsd: number, callerCap = 2) =>
			store.hold(OTHER, {
				connection: "a",
				limits: [
					{ key: `${OTHER.id}:limit:roomy:${callerId}`, cap: 100 },
					{ key: `${OTHER.id}:limit:tight:${callerId}`, cap: callerCap },
				],
				costUsd,
			});
		const first = await hold("agent:1", 1.5);
		expect(first).toMatchObject({ costMicros: 1_500_000 });
		expect(await hold("agent:1", 1)).toMatchObject({ costMicros: 1_000_000 });
		expect(await hold("agent:1", 0.1)).toEqual({
			refused: "caller",
			key: `${OTHER.id}:limit:tight:agent:1`,
		});
		// The roomy limit gave back what the refused hold took from it.
		const roomy = { key: `${OTHER.id}:limit:roomy:agent:1`, cap: 2 };
		expect(
			await store.hold(OTHER, { connection: "a", limits: [roomy], costUsd: 0 }),
		).toEqual({ refused: "caller", key: roomy.key });
		// Spend has no cap here any more: budgets hold their part first.
		expect(await hold("agent:2", 100)).toMatchObject({
			costMicros: 100_000_000,
		});
		expect((await store.spend(OTHER)).spentUsd).toBeCloseTo(102.5);
		if ("refused" in first) throw new Error("held");
		await store.release(first);
		expect((await store.spend(OTHER)).spentUsd).toBeCloseTo(101);
		expect(await hold("agent:1", 0.5)).toMatchObject({ costMicros: 500_000 });
	});

	it("seeds the first budget from the video budget a workspace had before", async () => {
		const store = await make();
		expect(await store.budgetSeed(OTHER.id)).toEqual({
			videoMonthlyBudgetUsd: 25,
			videoSpentUsd: 0,
		});
		await store.hold(OTHER, {
			connection: "a",
			limits: [{ key: `${OTHER.id}:limit:x:agent:1`, cap: 5 }],
			costUsd: 2,
		});
		if (store.persistence === "mongodb") {
			// A policy saved before budgets, with its own monthly budget.
			const internal = store as unknown as {
				policies: () => {
					insertOne: (doc: unknown) => Promise<unknown>;
				};
			};
			await internal.policies().insertOne({
				_id: OTHER.id,
				policy: {
					order: [],
					callerVideosPerDay: 4,
					monthlyBudgetUsd: 7.5,
					maxDurationSeconds: 10,
				},
				revision: 1,
			});
			// Saving the order keeps it until it seeds a budget.
			const policy = await store.policy(OTHER);
			expect(policy).toEqual({ order: [], revision: 1 });
			await store.updatePolicy(OTHER, policy);
			// The old videos a day and longest video seed the first limit.
			expect((await store.limits(OTHER.id)).limits).toMatchObject([
				{
					appliesTo: { kind: "everyone" },
					covers: { kind: "video" },
					videosPerDay: 4,
					maxDurationSeconds: 10,
					origin: "video-policy",
				},
			]);
		}
		expect(await store.budgetSeed(OTHER.id)).toEqual({
			videoMonthlyBudgetUsd: store.persistence === "mongodb" ? 7.5 : 25,
			videoSpentUsd: 2,
		});
	});

	it("treats a lost race to create a period's counter as a retry, not a refusal", async () => {
		const store = await make();
		if (store.persistence === "mongodb") {
			// Another hold creates the counter just before this one's upsert
			// inserts it: MongoDB answers the upsert with a duplicate key.
			const internal = store as unknown as {
				usage: () => {
					updateOne: (...args: unknown[]) => Promise<unknown>;
					insertOne: (doc: unknown) => Promise<unknown>;
				};
			};
			const usage = internal.usage.bind(store);
			let raced = false;
			internal.usage = () => {
				const collection = usage();
				return Object.assign(Object.create(collection), {
					updateOne: async (...args: unknown[]) => {
						const [filter, , options] = args as [
							{ _id: { $eq: string } },
							unknown,
							{ upsert?: boolean } | undefined,
						];
						// The month's spend is the counter that races here.
						if (
							options?.upsert &&
							!raced &&
							filter._id.$eq.startsWith(`${OTHER.id}:budget:`)
						) {
							raced = true;
							await collection.insertOne({
								_id: filter._id.$eq,
								videos: 1,
								costMicros: 100_000,
								workspaceId: OTHER.id,
								expiresAt: new Date(Date.now() + 86_400_000),
							});
							throw Object.assign(new Error("E11000 duplicate key"), {
								code: 11000,
							});
						}
						return (
							collection.updateOne as (...a: unknown[]) => Promise<unknown>
						)(...args);
					},
				});
			};
		}
		const held = await store.hold(OTHER, {
			connection: "a",
			limits: [{ key: `${OTHER.id}:limit:x:agent:1`, cap: 5 }],
			costUsd: 0.35,
		});
		expect(held).toMatchObject({ costMicros: 350_000 });
		const budget = await store.spend(OTHER);
		expect(budget.spentUsd).toBeCloseTo(
			store.persistence === "mongodb" ? 0.45 : 0.35,
		);
	});

	it.each([
		["the month's spend", 2],
		["the connection's spend", 3],
	])("gives back what it took when %s cannot be written", async (_, failing) => {
		const store = await make();
		const internal = store as unknown as {
			increment: (...args: unknown[]) => Promise<boolean>;
		};
		const increment = internal.increment.bind(store);
		let calls = 0;
		internal.increment = async (...args: unknown[]) => {
			calls += 1;
			// The limit's count is written first, then the month's, then the connection's.
			if (calls === failing)
				throw new ServiceError("Video settings are unavailable.", 503);
			return increment(...args);
		};
		const limit = { key: `${OTHER.id}:limit:x:agent:1`, cap: 1 };
		expect(
			await refusal(
				store.hold(OTHER, { connection: "a", limits: [limit], costUsd: 2 }),
			),
		).toMatchObject({ status: 503 });
		internal.increment = increment;
		expect((await store.spend(OTHER)).spentUsd).toBe(0);
		// The limit's one video a day was given back, so a hold can take it.
		const held = await store.hold(OTHER, {
			connection: "a",
			limits: [limit],
			costUsd: 0,
		});
		expect(held).toMatchObject({ keys: { limits: [limit.key] } });
		expect(
			await store.hold(OTHER, { connection: "a", limits: [limit], costUsd: 0 }),
		).toEqual({ refused: "caller", key: limit.key });
	});
});

describe("validateVideoPolicy", () => {
	const valid = { order: [], revision: 0 };
	const message = (input: Partial<typeof valid>) => {
		try {
			validateVideoPolicy({ ...valid, ...input }, new Set(["a"]));
			return null;
		} catch (error) {
			return (error as Error).message;
		}
	};
	it("checks every field", () => {
		expect(message({})).toBeNull();
		expect(message({ order: ["a", "a"] as never })).toContain("twice");
		expect(
			message({ order: Array.from({ length: 11 }, () => "a") as never }),
		).toContain("at most");
	});
});

function job(overrides: Partial<VideoJobRecord> = {}): VideoJobRecord {
	const createdAt = overrides.createdAt ?? "2026-11-19T10:00:00.000Z";
	return {
		_id: `vid_${crypto.randomUUID()}`,
		workspaceId: OTHER.id,
		workspaceDefault: false,
		status: "queued",
		progress: null,
		provider: "luma",
		kind: "luma",
		model: "ray-3.2",
		prompt: "a fox",
		durationSeconds: 5,
		aspectRatio: "16:9",
		resolution: "720p",
		hasImage: false,
		createdBy: { id: "agent:a", name: "A", kind: "agent" },
		createdAt,
		updatedAt: createdAt,
		completedAt: null,
		costUsd: 1,
		error: null,
		attempts: [],
		providerJobId: null,
		delivery: null,
		resultExpiresAt: null,
		downloadToken: crypto.randomUUID().replaceAll("-", "").padEnd(43, "x"),
		hold: null,
		lastPolledAt: null,
		expiresAt: new Date(Date.parse(createdAt) + 30 * 86_400_000),
		...overrides,
	};
}

describe.each(jobStores())("VideoJobStore (%s)", (_name, make) => {
	it("finds a job only in its own workspace, and by its token", async () => {
		const jobs = await make();
		const record = job();
		await jobs.insert(record);
		expect((await jobs.get(OTHER.id, record._id))?.prompt).toBe("a fox");
		expect(await jobs.get(DEFAULT.id, record._id)).toBeNull();
		expect((await jobs.byToken(record.downloadToken))?._id).toBe(record._id);
		expect(await jobs.byToken("nope")).toBeNull();
	});

	it("finishes a job for exactly one of two concurrent callers", async () => {
		const jobs = await make();
		const record = job({ status: "running" });
		await jobs.insert(record);
		const wins = await Promise.all([
			jobs.update(
				OTHER.id,
				record._id,
				{ status: "succeeded" },
				{ unfinished: true },
			),
			jobs.update(
				OTHER.id,
				record._id,
				{ status: "failed" },
				{ unfinished: true },
			),
		]);
		expect(wins.filter(Boolean)).toHaveLength(1);
		expect(
			await jobs.update(
				OTHER.id,
				record._id,
				{ status: "canceled" },
				{ unfinished: true },
			),
		).toBe(false);
		expect(await jobs.update(DEFAULT.id, record._id, { progress: 5 })).toBe(
			false,
		);
		const finished = await jobs.get(OTHER.id, record._id);
		expect(["succeeded", "failed"]).toContain(finished?.status);
		expect(
			await jobs.update(
				OTHER.id,
				record._id,
				{ status: "expired" },
				{ status: finished?.status },
			),
		).toBe(true);
	});
});

describe("VideoJobStore memory expiry", () => {
	it("drops a record past its expiry", async () => {
		let now = new Date("2026-11-19T10:00:00Z");
		const jobs = new VideoJobStore(undefined, () => now);
		const record = job({ expiresAt: new Date("2026-11-20T10:00:00Z") });
		await jobs.insert(record);
		expect(await jobs.get(OTHER.id, record._id)).not.toBeNull();
		now = new Date("2026-11-21T10:00:00Z");
		expect(await jobs.get(OTHER.id, record._id)).toBeNull();
		expect(await jobs.byToken(record.downloadToken)).toBeNull();
		expect(jobs.persistence).toBe("memory");
	});
});
