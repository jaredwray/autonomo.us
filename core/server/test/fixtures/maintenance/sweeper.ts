// Synthetic cross-process delivery probe; never connects to a real callback.

import type { Callback } from "../../../src/mcp-events/callback.js";
import { McpEvents } from "../../../src/mcp-events/events.js";
import { MongoEventRepository } from "../../../src/mcp-events/repository.js";
import { controlPlaneConnection } from "../../../src/mongo.js";

const mongo = controlPlaneConnection(process.env.TEST_MONGO_URL ?? "");
let release: (() => void) | undefined;
let now = 0;
const events = new McpEvents({
	repository: new MongoEventRepository(mongo),
	now: () => now,
	authorized: async () => true,
	threadAuthor: async () => null,
	callback: {
		post: async (_subscription, id, _body, _time, _challenge, beforeSend) => {
			if (!(await beforeSend?.())) return { status: 0 };
			const held = new Promise<void>((resolve) => {
				release = resolve;
			});
			process.send?.({ type: "delivery", id });
			await held;
			return { status: 200 };
		},
	} as Callback,
});
process.on("message", async (message: { type: string; now: number }) => {
	if (message.type === "release") {
		release?.();
		return;
	}
	if (message.type !== "sweep") return;
	now = message.now;
	try {
		await events.sweep(1);
		await events.close();
		await mongo.close();
		process.send?.({ type: "done" });
		process.disconnect();
	} catch {
		process.exit(1);
	}
});
process.send?.({ type: "ready" });
