import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	DecisionCase,
	DecisionCasePage,
	DecisionRoute,
	OrgBranch,
} from "@autonomo.us/common";
import { afterEach, expect, it } from "vitest";
import { continuityRequest, seedRustboy } from "../scripts/fixtures/rustboy.js";
import { ShotConsumer } from "../scripts/fixtures/shot-consumer.js";
import { createServer, sweepBackgroundWork } from "../src/server.js";

const cleanups: (() => undefined | Promise<unknown>)[] = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});

async function setup() {
	let now = Date.now();
	const server = createServer({
		config: { providers: [], corsOrigins: [] },
		logger: false,
		organizationNow: () => now,
	});
	cleanups.push(() => server.close());
	const s = await seedRustboy(server);
	const dir = mkdtempSync(join(tmpdir(), "rustboy-consumer-"));
	const db = join(dir, "shots.sqlite");
	let consumer = new ShotConsumer(db);
	cleanups.push(() => {
		consumer.close();
		rmSync(dir, { recursive: true, force: true });
	});
	const blocked = async () => {
		expect(consumer.check("lighting")).toBe(false);
		expect(consumer.check("lighting")).toBe(false);
		expect(consumer.check("wardrobe")).toBe(true);
		const opened = await s.open();
		expect(consumer.check("wardrobe")).toBe(true);
		expect((await s.open()).id).toBe(opened.id);
		return opened;
	};
	const read = (c: DecisionCase) =>
		s.tool<DecisionCase>(s.editor.secret, "organization_read_case", {
			caseId: c.id,
		});
	const decide = (c: DecisionCase, action: string, reason?: string) =>
		s.tool<DecisionCase>(s.artist.secret, "organization_act", {
			caseId: c.id,
			expectedRevision: c.revision,
			action,
			reason,
		});
	const expire = async () => {
		now += 31 * 60_000;
		await sweepBackgroundWork(server);
	};
	return {
		s,
		blocked,
		decide,
		read,
		expire,
		get consumer() {
			return consumer;
		},
		restartConsumer() {
			consumer.close();
			consumer = new ShotConsumer(db);
		},
	};
}

it("routes visual continuity independently of reporting and resumes exactly one shot after replay and reconnect", async () => {
	const f = await setup();
	const { s } = f;
	const branch = await s.tool<OrgBranch>(
		s.editor.secret,
		"organization_context",
	);
	expect(branch.positions.find((p) => p.id === s.splice.id)?.managerId).toBe(
		s.captain.id,
	);
	const route = await s.tool<DecisionRoute>(
		s.editor.secret,
		"organization_lookup",
		{ decisionKey: "visual-continuity" },
	);
	expect(route.steps.map((step) => step.position.occupant?.name)).toEqual([
		"Iris",
		"Jared",
	]);
	expect(route.deadlineMinutes).toBe(30);
	const c = await f.blocked();
	const queue = await s.tool<DecisionCasePage>(
		s.artist.secret,
		"organization_list_cases",
	);
	expect(queue.cases.map((item) => item.id)).toEqual([c.id]);
	expect(c.evidence).toEqual(continuityRequest.evidence);
	expect(f.consumer.shot("rustboy/shot-015")?.state).toBe("running");
	await f.decide(c, "approve");
	const outcome = (await f.read(c)).outcome;
	if (!outcome) throw new Error("Missing durable outcome");
	expect(outcome.by.name).toBe("Iris");
	expect(f.consumer.apply({ ...outcome, sourceRevision: "cut-2" })).toBe(false);
	expect(f.consumer.apply(outcome)).toBe(true);
	f.restartConsumer();
	const replay = (await f.read(c)).outcome;
	expect(replay?.id).toBe(outcome.id);
	expect(f.consumer.apply(outcome)).toBe(false);
	expect(f.consumer.shot()).toEqual({ state: "running", resumes: 1 });
	expect(f.consumer.shot("rustboy/shot-015")).toEqual({
		state: "running",
		resumes: 0,
	});
});
it("returns requested changes and the reviewer's reason to Splice", async () => {
	const f = await setup(),
		c = await f.blocked();
	await f.decide(c, "request_changes", "Match the established silhouette.");
	const outcome = (await f.read(c)).outcome;
	if (!outcome) throw new Error("Missing outcome");
	expect(outcome.reason).toBe("Match the established silhouette.");
	expect(f.consumer.apply(outcome)).toBe(true);
	expect(f.consumer.shot()).toEqual({ state: "changes_requested", resumes: 0 });
});
it("hands the same case to Jared at the deadline and rejects a late approval", async () => {
	const f = await setup(),
		c = await f.blocked();
	await f.expire();
	const assigned = await f.s.admin<DecisionCase>("GET", `/cases/${c.id}`);
	expect(assigned.assignee?.name).toBe("Jared");
	expect(
		assigned.history
			.filter((entry) => entry.event === "assigned")
			.map((entry) => entry.assignee?.name),
	).toEqual(["Iris", "Jared"]);
	await f.s.admin("POST", `/cases/${c.id}/act`, {
		action: "request_changes",
		expectedRevision: assigned.revision,
		reason: "Preserve reference A.",
	});
	await expect(f.decide(c, "approve")).rejects.toThrow();
	const final = await f.read(c);
	expect(final.status).toBe("changes_requested");
	expect(final.outcome?.by.name).toBe("Jared");
	expect(final.history.filter((h) => h.event === "timeout")).toHaveLength(1);
});
it("returns a 25-position first page from a 1,000-position organization", async () => {
	const { s } = await setup();
	for (let n = 4; n < 1000; n++)
		await s.admin("POST", "/positions", {
			title: `Production role ${n}`,
			managerId: s.jared.id,
		});
	const first = await s.admin<OrgBranch>("GET", "/branch");
	expect(first.positions).toHaveLength(25);
	expect(first.positions[0].id).toBe(s.jared.id);
	expect(first.next).toBeTruthy();
	const second = await s.admin<OrgBranch>("GET", `/branch?after=${first.next}`);
	expect(
		second.positions.every(
			(p) => !first.positions.some((previous) => p.id === previous.id),
		),
	).toBe(true);
	const branch = await s.tool<OrgBranch>(
		s.editor.secret,
		"organization_context",
	);
	expect(branch.positions.map((p) => p.id)).toEqual([
		s.captain.id,
		s.splice.id,
	]);
}, 30_000);
