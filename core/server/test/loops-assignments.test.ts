import { MongoClient } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { LoopsAssignments } from "../src/loops/assignments.js";
import {
	type LoopRepository,
	MemoryLoopRepository,
	MongoLoopRepository,
	type RunRecord,
} from "../src/loops/repository.js";
import { MongoConnection } from "../src/mongo.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const performer = { kind: "agent" as const, id: "editor" };
const reviewer = { kind: "agent" as const, id: "qc" };
function run(id: string, workspaceId = "studio"): RunRecord {
	return {
		ownerPositionId: "director",
		createdAt: "2026-01-01T00:00:00.000Z",
		workspaceId,
		waiting: false,
		run: {
			id,
			loopId: "continuity",
			version: 1,
			workId: "shot",
			workRevision: "v1",
			status: "active",
			revision: 1,
			stepIndex: 1,
			caseId: "approved",
			claimedBy: null,
			events: [],
			workflow: {
				triggerCount: 1,
				decisionKey: "continuity",
				steps: [
					{ id: "approve", kind: "decision", name: "Approve", assignee: null },
					{ id: "render", kind: "action", name: "Render", assignee: performer },
					{ id: "verify", kind: "verify", name: "Verify", assignee: reviewer },
				],
			},
		},
	};
}

async function handoff(repo: LoopRepository) {
	const record = run("a"),
		other = run("b"),
		foreign = run("f", "other");
	for (const row of [record, other, foreign]) await repo.saveRun(row, 0);
	let now = 1;
	const notify = vi
		.fn()
		.mockRejectedValueOnce(new Error("temporary failure"))
		.mockResolvedValue(undefined);
	const assignments = new LoopsAssignments(
		repo,
		async () => {},
		notify,
		() => now,
	);
	const page = await assignments.list("studio", performer, undefined, 1);
	expect(page.assignments.map((s) => s.runId)).toEqual(["a"]);
	expect(
		(
			await assignments.list("studio", performer, page.next ?? undefined, 1)
		).assignments.map((s) => s.runId),
	).toEqual(["b"]);
	expect((await assignments.list("studio", reviewer)).assignments).toEqual([]);
	expect(
		(await assignments.list("studio", { kind: "user", id: "editor" }))
			.assignments,
	).toEqual([]);
	await expect(assignments.sweep()).rejects.toThrow("temporary failure");
	expect(notify).toHaveBeenCalledTimes(3);
	await assignments.sweep();
	expect(notify).toHaveBeenCalledTimes(3);
	now += 31_000;
	// A fresh gateway resumes the same durable assignment after enqueue failed.
	const restarted = new LoopsAssignments(
		repo,
		async () => {},
		notify,
		() => now,
	);
	await Promise.all([restarted.sweep(), restarted.sweep()]);
	expect(notify).toHaveBeenCalledTimes(4);
	const change = structuredClone(record);
	change.run.revision++;
	change.run.stepIndex = 2;
	await repo.saveRun(change, 1);
	await repo.acknowledgeAssignment(record);
	const event = {
		type: "loop.assigned" as const,
		loopId: "continuity",
		runId: "a",
		stepIndex: 1,
		at: record.createdAt,
	};
	expect(await restarted.mayNotify("studio", performer.id, event)).toBe(false);
	expect(
		await restarted.mayNotify("other", reviewer.id, { ...event, stepIndex: 2 }),
	).toBe(false);
	await restarted.sweep();
	expect(notify).toHaveBeenCalledTimes(5);
	expect(notify.mock.calls.at(-1)).toEqual([
		"studio",
		"qc",
		{ key: expect.any(String), event: { ...event, stepIndex: 2 } },
	]);
	expect(
		await restarted.mayNotify("studio", reviewer.id, {
			...event,
			stepIndex: 2,
		}),
	).toBe(true);
	expect(
		(await restarted.list("studio", reviewer)).assignments[0],
	).toMatchObject({
		runId: "a",
		stepId: "verify",
		claimed: false,
		revision: 2,
	});
}

it("recovers the current assignment after a failed enqueue and suppresses stale work", async () => {
	await handoff(new MemoryLoopRepository());
});

it("returns claimed work and its provider key after reconnect, including the last evidence for its verifier", async () => {
	const repo = new MemoryLoopRepository(),
		row = run("resume"),
		notify = vi.fn();
	row.run.claimedBy = performer;
	row.run.workflow.steps[1].maxCostCents = 80;
	await repo.saveRun(row, 0);
	const assignments = new LoopsAssignments(repo, async () => {}, notify);
	expect(
		(await assignments.list("studio", performer)).assignments,
	).toMatchObject([
		{ claimed: true, executionKey: "resume:render", maxCostCents: 80 },
	]);
	await assignments.sweep();
	expect(notify).not.toHaveBeenCalled();
	row.run.stepIndex = 2;
	row.run.claimedBy = null;
	row.run.revision++;
	row.run.events.push({
		at: row.createdAt,
		actor: performer,
		message: "Rendered",
		evidence: "work:shot/014/render-77",
	});
	await repo.saveRun(row, 1);
	expect((await assignments.list("studio", performer)).assignments).toEqual([]);
	expect(
		(await assignments.list("studio", reviewer)).assignments[0],
	).toMatchObject({ stepId: "verify", evidence: "work:shot/014/render-77" });
});

it("reconciles pending organization cases without opening the page and wakes the newly assigned agent in the same sweep", async () => {
	const repo = new MemoryLoopRepository(),
		row = run("waiting"),
		notify = vi.fn();
	row.waiting = true;
	row.run.stepIndex = 0;
	await repo.saveRun(row, 0);
	const assignments = new LoopsAssignments(
		repo,
		async (r) => {
			r.waiting = false;
			r.run.stepIndex = 1;
			r.run.revision++;
			await repo.saveRun(r, 1);
		},
		notify,
	);
	await assignments.sweep();
	expect(notify).toHaveBeenCalledTimes(1);
	expect(
		(await assignments.list("studio", performer)).assignments,
	).toHaveLength(1);
});

describe.skipIf(!(await mongoAvailable()))("MongoDB assignments", () => {
	it("stores, retries and acknowledges the same handoff across gateway instances", async () => {
		const uri = uniqueMongoUrl("lass"),
			conn = new MongoConnection(uri, (u) => new MongoClient(u));
		try {
			await handoff(new MongoLoopRepository(conn));
		} finally {
			const client = new MongoClient(uri);
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
				await conn.close();
			}
		}
	});
});
