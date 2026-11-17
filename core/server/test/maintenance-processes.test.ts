import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { MongoClient } from "mongodb";
import { expect, it, vi } from "vitest";
import {
	MongoEventRepository,
	type Subscription,
} from "../src/mcp-events/repository.js";
import { controlPlaneConnection } from "../src/mongo.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
const waitFor = (assertion: () => void) =>
	vi.waitFor(assertion, { timeout: 5000 });
it.skipIf(!available)(
	"separate Node processes respect Mongo leases and recover a killed delivery with its stable ID",
	async () => {
		const url = uniqueMongoUrl("mcprace");
		const mongo = controlPlaneConnection(url);
		const repository = new MongoEventRepository(mongo);
		const now = Date.now();
		const id = randomUUID();
		const value: Subscription = {
			id,
			workspaceId: "synthetic-workspace",
			agentId: "synthetic-agent",
			name: "channel.message",
			arguments: { channel_id: "synthetic-channel" },
			url: "https://synthetic.invalid/",
			secret: "synthetic-secret",
			expiresAt: now + 86400000,
			verifiedUntil: now + 300000,
			active: true,
			seen: [],
			leaseId: null,
			leaseUntil: 0,
			version: 0,
			queue: [
				{
					attempts: 0,
					dueAt: now,
					event: {
						eventId: "stable-event",
						name: "channel.message",
						timestamp: new Date(now).toISOString(),
						cursor: null,
						data: {
							channel_id: "synthetic-channel",
							message_id: "synthetic-message",
							seq: 1,
							thread_id: null,
							author: { kind: "user", id: "synthetic-user", name: "Test" },
						},
					},
				},
			],
		};
		const children: ReturnType<typeof fork>[] = [];
		function start() {
			const messages: Array<{ type: string; id?: string }> = [];
			const child = fork(
				fileURLToPath(
					new URL("./fixtures/maintenance/sweeper.ts", import.meta.url),
				),
				[],
				{
					execArgv: [
						"--import",
						fileURLToPath(
							new URL("../node_modules/tsx/dist/loader.mjs", import.meta.url),
						),
					],
					env: { TEST_MONGO_URL: url },
					stdio: ["ignore", "ignore", "pipe", "ipc"],
				},
			);
			children.push(child);
			child.on("message", (message: { type: string; id?: string }) =>
				messages.push(message),
			);
			return { child, messages };
		}
		try {
			await repository.insert(value);
			const crashed = start();
			await waitFor(() =>
				expect(crashed.messages.some((x) => x.type === "ready")).toBe(true),
			);
			crashed.child.send({ type: "sweep", now });
			await waitFor(() =>
				expect(crashed.messages.some((x) => x.type === "delivery")).toBe(true),
			);
			const exited = new Promise((resolve) =>
				crashed.child.once("exit", resolve),
			);
			crashed.child.kill("SIGKILL");
			await exited;
			expect((await repository.get(id))?.leaseUntil).toBe(now + 60000);
			const early = start();
			await waitFor(() =>
				expect(early.messages.some((x) => x.type === "ready")).toBe(true),
			);
			early.child.send({ type: "sweep", now: now + 59999 });
			await waitFor(() =>
				expect(early.messages.some((x) => x.type === "done")).toBe(true),
			);
			expect(early.messages.filter((x) => x.type === "delivery")).toHaveLength(
				0,
			);
			const peers = [start(), start()];
			await waitFor(() =>
				expect(
					peers.every((p) => p.messages.some((x) => x.type === "ready")),
				).toBe(true),
			);
			for (const peer of peers)
				peer.child.send({ type: "sweep", now: now + 60001 });
			// The losing process finishes while the winner still holds the callback open.
			await waitFor(() =>
				expect(
					peers.some((p) => p.messages.some((x) => x.type === "done")),
				).toBe(true),
			);
			await waitFor(() =>
				expect(
					peers.flatMap((p) => p.messages).filter((x) => x.type === "delivery"),
				).toHaveLength(1),
			);
			const winner = peers.find((p) =>
				p.messages.some((x) => x.type === "delivery"),
			);
			expect(winner?.messages.find((x) => x.type === "delivery")?.id).toBe(
				"stable-event",
			);
			winner?.child.send({ type: "release" });
			await waitFor(() =>
				expect(
					peers.every((p) => p.messages.some((x) => x.type === "done")),
				).toBe(true),
			);
			expect((await repository.get(id))?.queue).toEqual([]);
		} finally {
			for (const child of children)
				if (child.exitCode === null) child.kill("SIGKILL");
			await mongo.close();
			const cleanup = new MongoClient(url);
			try {
				await cleanup.db().dropDatabase();
			} finally {
				await cleanup.close();
			}
		}
	},
	20000,
);
