import type {
	CreateLoop,
	LoopObservationInput,
	OrgActorRef,
} from "@autonomo.us/common";
import { describe, expect, it, vi } from "vitest";
import { MemoryLoopRepository } from "../src/loops/repository.js";
import { LoopsService } from "../src/loops/service.js";
import type { OrganizationDirectory } from "../src/organization/directory.js";
import { OrganizationService } from "../src/organization/organization.js";
import { MemoryOrganizationRepository } from "../src/organization/repository.js";

const actor = (id: string, kind: "agent" | "user" = "agent") => ({ kind, id });
const admin = actor("admin", "user"),
	reporter = actor("quality"),
	renderer = actor("splice"),
	reviewer = actor("iris"),
	owner = actor("captain");
const workspaceId = "studio";
const c = (a: OrgActorRef) => ({ workspaceId, actor: a });
const clock = Date.parse("2026-06-19T12:00:00Z");
async function setup() {
	let now = clock;
	const revoked = new Set<string>();
	const directory: OrganizationDirectory = {
		active: async (w) => w === workspaceId || w === "other",
		resolve: async (w, a) =>
			[admin, reporter, renderer, reviewer, owner].some(
				(x) => a.id === x.id && a.kind === x.kind,
			) && w === workspaceId
				? {
						use: true,
						loopAct: !revoked.has(a.id),
						decide: true,
						manage: a.id === admin.id,
						identity: {
							...a,
							name: a.id,
							type: a.kind === "user" ? "human" : "token",
						},
					}
				: null,
		list: async () => [],
		evidence: async () => true,
	};
	const orgRepo = new MemoryOrganizationRepository(),
		repo = new MemoryLoopRepository(),
		organization = new OrganizationService(orgRepo, directory, {
			now: () => now,
		});
	const p = await organization.position(c(admin), null, {
		title: "Studio director",
		occupant: owner,
	});
	const r = await organization.position(c(admin), null, {
		title: "Art director",
		occupant: reviewer,
	});
	await organization.rule(c(admin), "continuity", {
		ownerPositionId: r.id,
		fallbackPositionIds: [],
		deadlineMinutes: 30,
	});
	const service = new LoopsService(
		repo,
		organization,
		directory,
		orgRepo,
		() => now,
	);
	const spec: CreateLoop = {
		name: "Continuity",
		goal: "Increase acceptance",
		ownerPositionId: p.id,
		metric: {
			name: "Acceptance",
			source: "QC",
			direction: "at_least",
			target: 80,
			staleAfterMinutes: 60,
		},
		workflow: {
			triggerCount: 2,
			decisionKey: "continuity",
			steps: [
				{
					id: "review",
					kind: "decision",
					name: "Change reference?",
					assignee: null,
				},
				{
					id: "retry",
					kind: "action",
					name: "Render retry",
					assignee: renderer,
					maxCostCents: 80,
				},
				{
					id: "verify",
					kind: "verify",
					name: "Inspect retry",
					assignee: reporter,
				},
			],
		},
	};
	const { id } = await service.create(c(admin), spec);
	const obs = (
		eventId: string,
		delta: Partial<LoopObservationInput> = {},
	): LoopObservationInput => ({
		eventId,
		workId: "shot-14",
		workRevision: "rev-2",
		observedAt: new Date(now).toISOString(),
		numerator: 0,
		denominator: 0,
		trigger: true,
		...delta,
	});
	return {
		revoked,
		service,
		id,
		spec,
		repo,
		orgRepo,
		organization,
		obs,
		skip: (ms: number) => {
			now += ms;
		},
	};
}
describe("workspace loops", () => {
	it("previews unique triggers by work revision and resolves the real reviewer without recording work", async () => {
		const f = await setup(),
			config = {
				ownerPositionId: f.spec.ownerPositionId,
				workflow: f.spec.workflow,
			};
		const a = {
				eventId: "a",
				workId: "shot",
				workRevision: "1",
				trigger: true,
			},
			b = { ...a, eventId: "b" },
			other = { ...a, eventId: "c", workRevision: "2" },
			ignore = { ...a, eventId: "d", trigger: false };
		const before = await f.service.get(c(admin), f.id);
		const preview = await f.service.preview(c(admin), {
			...config,
			observations: [a, a, b, other, ignore],
		});
		expect(preview.distinctEvents).toBe(4);
		expect(preview.matched).toEqual([
			{ workId: "shot", workRevision: "1", count: 2 },
		]);
		expect(preview.steps.map((s) => s.kind)).toEqual([
			"decision",
			"action",
			"verify",
		]);
		expect(preview.route.steps[0].position.occupant?.id).toBe(reviewer.id);
		expect(await f.service.get(c(admin), f.id)).toEqual(before);
		expect((await f.organization.list(c(reviewer))).cases).toEqual([]);
		await expect(
			f.service.preview(c(admin), {
				...config,
				observations: [a, { ...a, trigger: false }],
			}),
		).rejects.toThrow("different observation");
		await expect(
			f.service.preview(c(admin), {
				...config,
				observations: Array(101).fill(a),
			}),
		).rejects.toThrow("100 observations");
		await expect(
			f.service.preview(c(reporter), { ...config, observations: [] }),
		).rejects.toThrow("workspace actor");
	});

	it("aggregates weighted daily observations, retaining gaps and independent freshness", async () => {
		const f = await setup();
		const write = (e: string, d: Partial<LoopObservationInput>) =>
			f.service.observe(c(reporter), f.id, f.obs(e, { trigger: false, ...d }));
		expect((await f.service.get(c(admin), f.id)).status).toBe("no_data");
		await write("prior", {
			observedAt: "2026-06-13T12:00:00Z",
			numerator: 1,
			denominator: 4,
		});
		const today = f.obs("current", {
			trigger: false,
			numerator: 1,
			denominator: 1,
		});
		await Promise.all(
			Array.from({ length: 8 }, () =>
				f.service.observe(c(reporter), f.id, today),
			),
		);
		await write("more", { numerator: 0, denominator: 9 });
		await expect(
			write("current", { numerator: 2, denominator: 2 }),
		).rejects.toThrow("different observation");
		const stats = await f.service.get(c(admin), f.id);
		expect(stats).toMatchObject({
			current: { numerator: 1, denominator: 10, value: 10 },
			status: "off_target",
			change: -15,
			activeRuns: 0,
		});
		expect(stats.trend.map((d) => d.value)).toEqual([
			25,
			null,
			null,
			null,
			null,
			null,
			10,
		]);
		f.skip(2 * 3600000);
		await f.service.observe(c(reporter), f.id, f.obs("diagnostic"));
		expect((await f.service.get(c(admin), f.id)).status).toBe("stale");
		f.skip(9 * 86400000);
		const stale = await f.service.get(c(admin), f.id);
		expect(stale.current?.value).toBe(10);
		expect(stale.trend.every((d) => d.value === null)).toBe(true);
	});
	it("keeps the run pinned across publishing and accepts only one claim and scoped verified outcome", async () => {
		const f = await setup();
		const token = {
			workspaceId,
			actor: { kind: "api-token" as const, id: "ingestion-1" },
		};
		const a = f.obs("a"),
			b = f.obs("b");
		await f.service.observe(token, f.id, a);
		await Promise.all([b, b, b].map((e) => f.service.observe(token, f.id, e)));
		let view = await f.service.get(c(admin), f.id);
		expect(view.runs).toHaveLength(1);
		const run = view.runs[0];
		expect(view.status).toBe("no_data");
		expect(view.pendingDecisions).toBe(1);
		expect(run.events[0].actor).toEqual(token.actor);
		expect((await f.service.get(c(renderer), f.id)).pendingDecisions).toBe(0);
		expect(
			(await f.service.getRun(c(renderer), f.id, run.id)).caseId,
		).toBeNull();
		if (!run.caseId) throw new Error("Expected bound decision");
		const orgCase = await f.organization.read(c(reviewer), run.caseId);
		expect(orgCase.requester.id).toBe(owner.id);
		expect(orgCase.question).toContain("80 USD cents");
		expect(orgCase.question).toContain("rev-2");
		const publish = {
			expectedVersion: 1,
			target: 75,
			workflow: { ...f.spec.workflow, triggerCount: 3 },
		};
		const race = await Promise.allSettled([
			f.service.publish(c(admin), f.id, publish),
			f.service.publish(c(admin), f.id, publish),
		]);
		expect(race.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
		await f.organization.act(c(reviewer), orgCase.id, {
			action: "approve",
			expectedRevision: orgCase.revision,
		});
		view = await f.service.get(c(admin), f.id);
		let active = view.runs[0];
		expect(view.workflow.triggerCount).toBe(3);
		expect(view.metric.target).toBe(75);
		expect(active.workflow.triggerCount).toBe(2);
		expect(active.version).toBe(1);
		expect(view.pendingDecisions).toBe(0);
		const claim = {
			expectedRevision: active.revision,
			action: "claim" as const,
		};
		await expect(
			f.service.command(c(reporter), f.id, active.id, claim),
		).rejects.toThrow("assigned actor");
		const claims = await Promise.allSettled(
			[1, 2].map(() => f.service.command(c(renderer), f.id, active.id, claim)),
		);
		expect(claims.map((r) => r.status).sort()).toEqual([
			"fulfilled",
			"rejected",
		]);
		active = await f.service.getRun(c(renderer), f.id, active.id);
		expect(active.executionKey).toBe(`${active.id}:retry`);
		const complete = {
			expectedRevision: active.revision,
			action: "complete" as const,
			evidence: "work:replacement",
		};
		await expect(
			f.service.command(c(renderer), f.id, active.id, complete),
		).rejects.toThrow("approved ceiling");
		await expect(
			f.service.command(c(renderer), f.id, active.id, {
				...complete,
				costCents: 81,
			}),
		).rejects.toThrow("approved ceiling");
		active = await f.service.command(c(renderer), f.id, active.id, {
			...complete,
			costCents: 76,
		});
		expect(active.events.at(-1)?.costCents).toBe(76);
		const pass = {
			expectedRevision: active.revision,
			action: "pass" as const,
			evidence: "work:qc",
		};
		await expect(
			f.service.command(c(renderer), f.id, active.id, pass),
		).rejects.toThrow("assigned actor");
		expect(
			(await f.service.command(c(reporter), f.id, active.id, pass)).status,
		).toBe("completed");
		await f.service.observe(token, f.id, a);
		const final = await f.service.get(c(admin), f.id);
		expect(final.runs).toHaveLength(1);
		expect(final.activeRuns).toBe(0);
		expect(final.current).toBeNull();
	});
	it("retries a partially completed trigger and rejects forged case links", async () => {
		const f = await setup();
		await f.service.observe(c(reporter), f.id, f.obs("a"));
		const event = f.obs("b");
		const original = f.organization.openLoopCase.bind(f.organization);
		vi.spyOn(f.organization, "openLoopCase").mockImplementationOnce(
			async (c, input) => {
				await original(c, input);
				throw new Error("Interrupted before attaching case");
			},
		);
		await expect(f.service.observe(c(reporter), f.id, event)).rejects.toThrow(
			"Interrupted",
		);
		const observed = await f.service.observe(c(reporter), f.id, event);
		if (!observed.runId) throw new Error("Missing run");
		const run = await f.service.getRun(c(admin), f.id, observed.runId);
		if (!run.caseId) throw new Error("Missing bound case");
		const real = await f.orgRepo.getCase(workspaceId, run.caseId);
		if (!real) throw new Error("Missing durable case");
		await expect(
			f.organization.open(c(reporter), {
				decisionKey: "continuity",
				sourceWorkId: real.sourceWorkId,
				sourceRevision: real.sourceRevision,
				question: "Bypass authorization",
			}),
		).rejects.toThrow();
		vi.spyOn(f.orgRepo, "getCase").mockResolvedValueOnce({
			...real,
			question: "Different authorization",
		});
		await expect(f.service.getRun(c(admin), f.id, run.id)).rejects.toThrow(
			"recorded owner",
		);
		expect((await f.repo.run(workspaceId, f.id, run.id))?.run.stepIndex).toBe(
			0,
		);
	});
	it("checks current execution grants, and a changes request never releases the action", async () => {
		const f = await setup();
		f.revoked.add(renderer.id);
		await expect(
			f.service.publish(c(admin), f.id, {
				expectedVersion: 1,
				workflow: f.spec.workflow,
			}),
		).rejects.toThrow("assignee is unavailable");
		await f.service.observe(c(reporter), f.id, f.obs("a"));
		await f.service.observe(c(reporter), f.id, f.obs("b"));
		const run = (await f.service.get(c(admin), f.id)).runs[0];
		if (!run.caseId) throw new Error("Expected a routed case");
		const review = await f.organization.read(c(reviewer), run.caseId);
		await f.organization.act(c(reviewer), review.id, {
			expectedRevision: review.revision,
			action: "request_changes",
			reason: "Use a different reference",
		});
		const receipt = await f.service.getRun(c(admin), f.id, run.id);
		expect(receipt.status).toBe("changes_requested");
		await expect(
			f.service.command(c(renderer), f.id, receipt.id, {
				expectedRevision: receipt.revision,
				action: "claim",
			}),
		).rejects.toThrow("currently authorized");
		f.revoked.delete(renderer.id);
		await expect(
			f.service.command(c(renderer), f.id, receipt.id, {
				expectedRevision: receipt.revision,
				action: "claim",
			}),
		).rejects.toThrow("current revision");
		expect((await f.service.get(c(admin), f.id)).activeRuns).toBe(0);
	});

	it("isolates work revisions and workspace identities; rejects ambiguous metrics and verifier roles", async () => {
		const f = await setup();
		await expect(f.service.create(c(reporter), f.spec)).rejects.toThrow(
			"available to this workspace actor",
		);
		await expect(
			f.service.get({ workspaceId: "other", actor: admin }, f.id),
		).rejects.toThrow();
		await expect(
			f.service.observe(c(reporter), f.id, f.obs("bad", { trigger: false })),
		).rejects.toThrow("Denominator");
		await expect(
			f.service.observe(
				c(reporter),
				f.id,
				f.obs("future", { observedAt: "2030-01-01T00:00:00Z" }),
			),
		).rejects.toThrow("timestamp");
		await expect(
			f.service.observe(
				c(reporter),
				f.id,
				f.obs("private", { evidence: "channel:private:note" }),
			),
		).rejects.toThrow("opaque");
		const steps = f.spec.workflow.steps.map((s) =>
			s.kind === "verify" ? { ...s, assignee: renderer } : s,
		);
		await expect(
			f.service.publish(c(admin), f.id, {
				expectedVersion: 1,
				workflow: { ...f.spec.workflow, steps },
			}),
		).rejects.toThrow("independent");
		await f.service.observe(c(reporter), f.id, f.obs("one"));
		await f.service.observe(
			c(reporter),
			f.id,
			f.obs("two", { workRevision: "rev-3" }),
		);
		expect((await f.service.get(c(admin), f.id)).activeRuns).toBe(0);
	});
});
