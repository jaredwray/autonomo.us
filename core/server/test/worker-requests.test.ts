import { describe, expect, it, vi } from "vitest";
import {
	RequestTracker,
	releaseAfterResponse,
	scheduleTicksAsMicrotasks,
} from "../src/worker-requests.js";

const encoder = new TextEncoder();

/** A streamed body whose chunks are released one at a time by the test. */
function streamedResponse(chunks: string[]) {
	let index = 0;
	const cancelled = vi.fn();
	const body = new ReadableStream<Uint8Array>({
		pull(controller) {
			if (index === chunks.length) {
				controller.close();
				return;
			}
			controller.enqueue(encoder.encode(chunks[index++]));
		},
		cancel: cancelled,
	});
	const response = new Response(body, {
		status: 200,
		headers: { "content-type": "text/event-stream", "x-trace": "abc" },
	});
	return { response, cancelled };
}

function settled<T>(promise: Promise<T>) {
	const state = { done: false };
	promise.then(
		() => {
			state.done = true;
		},
		() => {
			state.done = true;
		},
	);
	return state;
}

async function tick() {
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("releaseAfterResponse", () => {
	it("runs the release only after the whole body has been read", async () => {
		const { response } = streamedResponse(["data: a\n\n", "data: b\n\n"]);
		const done = vi.fn(async () => {});
		const tracked = releaseAfterResponse(response, done);
		const finished = settled(tracked.finished);

		expect(tracked.response.status).toBe(200);
		expect(tracked.response.headers.get("x-trace")).toBe("abc");

		const reader = tracked.response.body?.getReader();
		if (!reader) throw new Error("expected a body");
		const first = await reader.read();
		expect(new TextDecoder().decode(first.value)).toBe("data: a\n\n");
		await tick();
		expect(done).not.toHaveBeenCalled();
		expect(finished.done).toBe(false);

		await reader.read();
		const last = await reader.read();
		expect(last.done).toBe(true);
		await tracked.finished;
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("runs the release when the client cancels mid-stream", async () => {
		const { response, cancelled } = streamedResponse(["one", "two", "three"]);
		const done = vi.fn(async () => {});
		const tracked = releaseAfterResponse(response, done);

		const reader = tracked.response.body?.getReader();
		if (!reader) throw new Error("expected a body");
		await reader.read();
		await reader.cancel(new Error("client went away"));

		await tracked.finished;
		expect(done).toHaveBeenCalledTimes(1);
		expect(cancelled).toHaveBeenCalledTimes(1);
	});

	it("releases immediately for a response without a body", async () => {
		const response = new Response(null, { status: 204 });
		const done = vi.fn(async () => {});
		const tracked = releaseAfterResponse(response, done);
		expect(tracked.response).toBe(response);
		await tracked.finished;
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("settles once the release has finished, even when it fails", async () => {
		const response = new Response("ok");
		const done = vi.fn(async () => {
			throw new Error("close failed");
		});
		const tracked = releaseAfterResponse(response, done);
		expect(await tracked.response.text()).toBe("ok");
		await expect(tracked.finished).rejects.toThrow("close failed");
	});
});

/** Queues a promise reaction and a nextTick from a timer, then reports the order. */
function tickOrderFromTimer(): Promise<string[]> {
	return new Promise((resolve) => {
		setTimeout(() => {
			const order: string[] = [];
			Promise.resolve().then(() => {
				order.push("micro");
			});
			process.nextTick(() => {
				order.push("tick");
			});
			setTimeout(() => resolve(order), 0);
		}, 0);
	});
}

describe("scheduleTicksAsMicrotasks", () => {
	it("runs nextTick callbacks as microtasks, then restores the native queue", async () => {
		const original = process.nextTick;
		const restore = scheduleTicksAsMicrotasks();
		try {
			expect(process.nextTick).not.toBe(original);
			expect(await tickOrderFromTimer()).toEqual(["micro", "tick"]);
		} finally {
			restore();
		}
		expect(process.nextTick).toBe(original);
		expect(await tickOrderFromTimer()).toEqual(["tick", "micro"]);
	});
});

describe("RequestTracker", () => {
	it("releases once, after the last overlapping request ends", async () => {
		const release = vi.fn(async () => {});
		const tracker = new RequestTracker(release);

		const endFirst = tracker.begin();
		const endSecond = tracker.begin();
		await endFirst();
		expect(release).not.toHaveBeenCalled();
		await endSecond();
		expect(release).toHaveBeenCalledTimes(1);

		// Ending the same request twice must not unbalance the count.
		await endSecond();
		const endThird = tracker.begin();
		expect(release).toHaveBeenCalledTimes(1);
		await endThird();
		expect(release).toHaveBeenCalledTimes(2);
	});
});
