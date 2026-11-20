import { describe, expect, it } from "vitest";
import { ServiceError } from "../src/service-error.js";
import { VideoLimits } from "../src/video/limits.js";
import { VideoStore } from "../src/video/store.js";

const WS = { id: "00000000-0000-4000-8000-000000000003", isDefault: false };
const AGENT = { id: "agent:a1", name: "Agent One", kind: "agent" as const };

function make() {
	const store = new VideoStore(
		[],
		undefined,
		() => new Date("2026-11-20T12:00:00Z"),
	);
	const limits = new VideoLimits(store, {
		knownAgents: async () => new Set(["a1", "a2"]),
	});
	return { store, limits };
}

async function refusal(promise: Promise<unknown>) {
	try {
		await promise;
	} catch (error) {
		if (error instanceof ServiceError)
			return { status: error.statusCode, message: error.message };
		throw error;
	}
	throw new Error("expected a refusal");
}

describe("VideoLimits", () => {
	it("starts every workspace with one limit for everyone on every model", async () => {
		const { limits } = make();
		expect(await limits.list(WS)).toMatchObject([
			{
				appliesTo: { kind: "everyone" },
				covers: { kind: "video" },
				videosPerDay: 10,
				maxDurationSeconds: 10,
				enabled: true,
				origin: "video-policy",
			},
		]);
	});

	it("adds, changes only the fields sent, and deletes a limit", async () => {
		const { limits } = make();
		const added = await limits.create(WS, {
			appliesTo: { kind: "agents", agentIds: [" a1 ", "a1"] },
			covers: { kind: "video-model", model: "gen4.5" },
			videosPerDay: 2,
		});
		expect(added).toMatchObject({
			appliesTo: { kind: "agents", agentIds: ["a1"] },
			covers: { kind: "video-model", model: "gen4.5" },
			videosPerDay: 2,
			maxDurationSeconds: null,
			enabled: true,
		});
		const changed = await limits.update(WS, added.id, {
			maxDurationSeconds: 6,
			enabled: false,
		});
		expect(changed).toMatchObject({
			videosPerDay: 2,
			maxDurationSeconds: 6,
			enabled: false,
		});
		// Clearing one leaves the other.
		expect(
			await limits.update(WS, added.id, { videosPerDay: null }),
		).toMatchObject({ videosPerDay: null, maxDurationSeconds: 6 });
		expect(
			await refusal(limits.update(WS, added.id, { maxDurationSeconds: null })),
		).toMatchObject({
			status: 400,
			message: "Set videos a day, the longest video, or both.",
		});
		await limits.remove(WS, added.id);
		expect(await limits.list(WS)).toHaveLength(1);
		expect(await refusal(limits.remove(WS, added.id))).toMatchObject({
			status: 404,
		});
	});

	it("refuses unknown agents and models, and limits past the cap at once", async () => {
		const { limits } = make();
		expect(
			await refusal(
				limits.create(WS, {
					appliesTo: { kind: "agents", agentIds: ["nobody"] },
					covers: { kind: "video" },
					videosPerDay: 1,
				}),
			),
		).toMatchObject({ message: "nobody is not an agent in this workspace." });
		expect(
			await refusal(
				limits.create(WS, {
					appliesTo: { kind: "everyone" },
					covers: { kind: "video-model", model: "made-up" },
					videosPerDay: 1,
				}),
			),
		).toMatchObject({ message: "made-up is not a video model." });
		for (let index = 1; index < 50; index++)
			await limits.create(WS, {
				appliesTo: { kind: "everyone" },
				covers: { kind: "video" },
				videosPerDay: index,
			});
		expect(
			await refusal(
				limits.create(WS, {
					appliesTo: { kind: "everyone" },
					covers: { kind: "video" },
					videosPerDay: 1,
				}),
			),
		).toMatchObject({
			status: 409,
			message: "A workspace holds at most 50 video limits.",
		});
	});

	it("keeps a removed agent a limit already names, but refuses adding one", async () => {
		const store = new VideoStore([], undefined);
		let known = new Set(["a1", "a2"]);
		const limits = new VideoLimits(store, { knownAgents: async () => known });
		const added = await limits.create(WS, {
			appliesTo: { kind: "agents", agentIds: ["a1", "a2"] },
			covers: { kind: "video" },
			videosPerDay: 3,
		});
		known = new Set(["a1"]);
		expect(
			await limits.update(WS, added.id, { videosPerDay: 4 }),
		).toMatchObject({ videosPerDay: 4 });
		expect(
			await refusal(
				limits.update(WS, added.id, {
					appliesTo: { kind: "agents", agentIds: ["a1", "a2", "a3"] },
				}),
			),
		).toMatchObject({ message: "a3 is not an agent in this workspace." });
	});

	it("applies the strictest of the limits that cover a video", async () => {
		const { limits } = make();
		await limits.create(WS, {
			appliesTo: { kind: "agents", agentIds: ["a1"] },
			covers: { kind: "video" },
			maxDurationSeconds: 8,
		});
		await limits.create(WS, {
			appliesTo: { kind: "everyone" },
			covers: { kind: "video-model", model: "gen4.5" },
			videosPerDay: 1,
			maxDurationSeconds: 5,
		});
		const seedance = await limits.forVideo(WS, AGENT, "seedance2_5");
		expect(seedance.maxDurationSeconds).toBe(8);
		// The starting limit counts; the one without a count does not.
		expect(seedance.counts.map((count) => count.cap)).toEqual([10]);
		const gen = await limits.forVideo(WS, AGENT, "gen4.5");
		expect(gen.maxDurationSeconds).toBe(5);
		expect(gen.counts.map((count) => count.cap)).toEqual([10, 1]);
		expect(
			await limits.durations(WS, AGENT, ["seedance2_5", "gen4.5"]),
		).toEqual({ all: 8, byModel: { "gen4.5": 5 } });
		// Someone the agents limit does not name.
		expect(
			await limits.durations(
				WS,
				{ id: "user:1", name: "Founder", kind: "user" },
				["seedance2_5", "gen4.5"],
			),
		).toEqual({ all: 10, byModel: { "gen4.5": 5 } });
	});
});
