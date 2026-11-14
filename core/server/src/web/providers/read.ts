/** The most of a provider's answer the gateway reads, as for a plain request. */
export const MAX_PROVIDER_BYTES = 5 * 1024 * 1024;

/** A provider's answer was larger than the gateway reads. */
export class ResponseTooLarge extends Error {
	constructor(readonly limit: number) {
		super(`The answer is larger than ${Math.round(limit / 1024 / 1024)} MB.`);
	}
}

/**
 * Reads a response body as UTF-8 text, stopping and cancelling the stream
 * once it passes `limit` bytes, so a huge page cannot fill the gateway's
 * memory before anything is cut.
 */
export async function readLimited(
	response: Response,
	limit = MAX_PROVIDER_BYTES,
): Promise<string> {
	const declared = Number(response.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > limit) {
		await response.body?.cancel().catch(() => {});
		throw new ResponseTooLarge(limit);
	}
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let read = 0;
	let text = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		read += value.byteLength;
		if (read > limit) {
			await reader.cancel().catch(() => {});
			throw new ResponseTooLarge(limit);
		}
		text += decoder.decode(value, { stream: true });
	}
	return text + decoder.decode();
}
