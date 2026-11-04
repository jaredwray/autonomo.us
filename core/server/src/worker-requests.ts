/**
 * Avvio finishes plugin callbacks through `process.nextTick`. On Workers the
 * native queue does not drain while Avvio's 10s plugin timer is pending, so
 * boot dies with `AVV_ERR_PLUGIN_EXEC_TIMEOUT` after ~10s of wall time.
 * Microtasks drain before that wait. The returned function puts the native
 * queue back so the MongoDB driver keeps its usual ordering after listen.
 */
export function scheduleTicksAsMicrotasks(): () => void {
	const original = process.nextTick;
	process.nextTick = ((
		callback: (...args: unknown[]) => void,
		...args: unknown[]
	) => {
		queueMicrotask(() => {
			callback(...args);
		});
	}) as typeof process.nextTick;
	return () => {
		process.nextTick = original;
	};
}

/**
 * Request bookkeeping for the Worker entry. One Fastify instance serves
 * overlapping requests in an isolate, and a streamed response outlives the
 * handler that produced it, so MongoDB clients are released only after the
 * last open response has finished.
 */
export class RequestTracker {
	private open = 0;

	constructor(private readonly release: () => Promise<void>) {}

	/** Counts a request in. The returned function counts it out once. */
	begin(): () => Promise<void> {
		this.open += 1;
		let ended = false;
		return async () => {
			if (ended) return;
			ended = true;
			this.open -= 1;
			if (this.open === 0) await this.release();
		};
	}
}

/**
 * Mirrors `response` through a new body and runs `done` after that body has
 * been fully sent or cancelled by the client. `finished` settles once `done`
 * has run, so the Worker can hand it to `ctx.waitUntil`.
 */
export function releaseAfterResponse(
	response: Response,
	done: () => Promise<void>,
): { response: Response; finished: Promise<void> } {
	if (!response.body) return { response, finished: done() };
	const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
	const finished = response.body.pipeTo(writable).then(
		() => done(),
		() => done(),
	);
	return { response: new Response(readable, response), finished };
}
