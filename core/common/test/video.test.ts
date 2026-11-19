import { describe, expect, it } from "vitest";
import {
	AGENT_TOKEN_PERMISSIONS,
	API_TOKEN_PERMISSIONS,
	DEFAULT_VIDEO_MODEL,
	VIDEO_KINDS,
	VIDEO_LIMITS,
	VIDEO_MODELS,
	videoDurationAllowed,
	videoDurationsText,
	videoJobFinished,
	videoModel,
	videoModelProblem,
} from "../src/index.js";

describe("video models", () => {
	it("names a default model each kind offers", () => {
		for (const kind of VIDEO_KINDS) {
			expect(videoModel(kind, DEFAULT_VIDEO_MODEL[kind])).toBeDefined();
			expect(VIDEO_MODELS[kind].length).toBeGreaterThan(0);
		}
		expect(videoModel("runway", "ray-3.2")).toBeUndefined();
	});

	it("makes every model's own defaults, within the gateway's limits", () => {
		for (const kind of VIDEO_KINDS)
			for (const model of VIDEO_MODELS[kind]) {
				expect(
					videoModelProblem(model, { ...model.defaults, image: false }),
				).toBeNull();
				expect(model.defaults.durationSeconds).toBeLessThanOrEqual(10);
				expect(model.promptLength).toBeLessThanOrEqual(
					VIDEO_LIMITS.promptLength,
				);
				const durations = model.durations;
				const [min, max] =
					"min" in durations
						? [durations.min, durations.max]
						: [Math.min(...durations), Math.max(...durations)];
				expect(min).toBeGreaterThanOrEqual(VIDEO_LIMITS.minDurationSeconds);
				expect(max).toBeLessThanOrEqual(VIDEO_LIMITS.maxDurationSeconds);
			}
	});

	it("says what a model allows when it cannot make a request", () => {
		const ray = videoModel("luma", "ray-3.2");
		const omni = videoModel("google", "gemini-omni-1.2-flash");
		const gen = videoModel("runway", "gen4.5");
		if (!ray || !omni || !gen) throw new Error("missing model");
		const want = {
			durationSeconds: 5,
			aspectRatio: "16:9" as const,
			resolution: "720p" as const,
			image: false,
		};
		expect(videoModelProblem(ray, { ...want, durationSeconds: 7 })).toBe(
			"ray-3.2 makes videos of 5 or 10 seconds.",
		);
		expect(videoModelProblem(omni, { ...want, image: true })).toBe(
			"gemini-omni-1.2-flash does not start from an image.",
		);
		expect(videoModelProblem(omni, { ...want, aspectRatio: "1:1" })).toBe(
			"gemini-omni-1.2-flash makes 16:9, 9:16 videos.",
		);
		expect(videoModelProblem(omni, { ...want, resolution: "1080p" })).toBe(
			"gemini-omni-1.2-flash makes 360p, 720p videos.",
		);
		expect(videoModelProblem(gen, { ...want, promptLength: 1001 })).toBe(
			"gen4.5 takes prompts of up to 1000 characters.",
		);
		expect(videoDurationsText(omni)).toBe("3 to 15");
		expect(videoDurationsText({ ...ray, durations: [5] })).toBe("5");
		expect(videoDurationAllowed(omni, 3.5)).toBe(false);
	});

	it("knows which job statuses are finished", () => {
		expect(videoJobFinished("queued")).toBe(false);
		expect(videoJobFinished("running")).toBe(false);
		for (const status of [
			"succeeded",
			"failed",
			"canceled",
			"expired",
		] as const)
			expect(videoJobFinished(status)).toBe(true);
	});

	it("adds the video grants", () => {
		expect(API_TOKEN_PERMISSIONS).toMatchObject({
			"video:read": "Video: Read",
			"video:edit": "Video: Edit",
			"video:generate": "Video: Generate",
		});
		expect(AGENT_TOKEN_PERMISSIONS["video:generate"]).toBe("Video: Generate");
	});
});
