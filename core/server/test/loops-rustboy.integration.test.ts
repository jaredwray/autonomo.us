import type {
	CreateLoop,
	DecisionCase,
	LoopDetail,
	LoopObservationInput,
	LoopRun,
	LoopSamplesPage,
	OrgPosition,
} from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

it.skipIf(!(await mongoAvailable()))(
	"recovers the approved run on another gateway and keeps a successful retry out of the first-pass metric",
	async () => {
		const mongodbUrl = uniqueMongoUrl("loops_e2e");
		const client = new MongoClient(mongodbUrl);
		closers.push(async () => {
			try {
				await client.db().dropDatabase();
			} finally {
				await client.close();
			}
		});
		const first = await startChannels(closers, { mongodbUrl });
		const second = await startChannels(closers, { mongodbUrl });
		const base = `/v1/${first.workspaceId}`;
		const position = (
			title: string,
			occupant: { kind: "user" | "agent"; id: string },
		) =>
			first.ok<OrgPosition>(
				"POST",
				`${base}/organization/positions`,
				{ body: { title, occupant } },
				201,
			);
		const reviewer = await first.agent("Iris", [
			"mcp:read",
			"mcp:call",
			"organization:decide",
		]);
		const renderer = await first.agent("Splice", [
			"mcp:read",
			"mcp:call",
			"loops:read",
			"loops:act",
		]);
		const verifier = await first.agent("QC", [
			"mcp:read",
			"mcp:call",
			"loops:act",
		]);
		const owner = await position("Studio director", {
			kind: "user",
			id: first.owner.user.id,
		});
		const art = await position("Art director", {
			kind: "agent",
			id: reviewer.id,
		});
		await first.ok("PUT", `${base}/organization/rules/continuity`, {
			body: {
				ownerPositionId: art.id,
				fallbackPositionIds: [],
				deadlineMinutes: 30,
				expectedVersion: 0,
			},
		});
		const config: CreateLoop = {
			name: "Shot continuity",
			goal: "Accept the first render",
			ownerPositionId: owner.id,
			metric: {
				name: "First-pass acceptance",
				source: "QC first renders",
				direction: "at_least",
				target: 80,
				staleAfterMinutes: 1440,
			},
			workflow: {
				triggerCount: 2,
				decisionKey: "continuity",
				steps: [
					{
						id: "review",
						kind: "decision",
						name: "Switch the reference?",
						assignee: null,
					},
					{
						id: "retry",
						kind: "action",
						name: "Render one retry",
						assignee: { kind: "agent", id: renderer.id },
						maxCostCents: 80,
					},
					{
						id: "verify",
						kind: "verify",
						name: "Check screen direction",
						assignee: { kind: "agent", id: verifier.id },
					},
				],
			},
		};
		const created = await first.ok<LoopDetail>(
			"POST",
			`${base}/loops`,
			{ body: config },
			201,
		);
		const path = `${base}/loops/${created.id}`;
		const source = await first.apiToken(["loops:report"]);
		const input: LoopObservationInput = {
			eventId: "sample-1",
			workId: "shot-014",
			workRevision: "r3",
			observedAt: new Date().toISOString(),
			numerator: 18,
			denominator: 25,
			trigger: false,
			evidence: "work:qc/batch-1",
		};
		const observe = (gateway: typeof first, event: LoopObservationInput) =>
			gateway.ok<{ eventId: string; runId: string | null }>(
				"POST",
				`${path}/observations`,
				{ token: source, body: event },
			);
		await observe(first, input);
		const failedCheck = {
			...input,
			numerator: 0,
			denominator: 0,
			trigger: true,
			eventId: "lighting",
		};
		expect((await observe(first, failedCheck)).runId).toBeNull();
		const secondCheck = { ...failedCheck, eventId: "direction" };
		const [one, two] = await Promise.all([
			observe(first, secondCheck),
			observe(second, secondCheck),
		]);
		expect(one.runId).toBeTruthy();
		expect(two.runId).toBe(one.runId);
		const detail = () => second.ok<LoopDetail>("GET", path);
		let loop = await detail();
		expect(loop.runs).toHaveLength(1);
		expect(loop.current).toMatchObject({
			value: 72,
			numerator: 18,
			denominator: 25,
		});
		expect(loop.pendingDecisions).toBe(1);
		const waiting = loop.runs[0];
		expect(waiting.caseId).toBeTruthy();
		const decision = await first.tool<DecisionCase>(
			reviewer.secret,
			"organization_read_case",
			{ caseId: waiting.caseId },
		);
		expect(decision.data.assignee?.id).toBe(reviewer.id);
		expect(
			(
				await first.refused("POST", `${base}/organization/cases`, {
					body: {
						decisionKey: "continuity",
						sourceWorkId: decision.data.sourceWorkId,
						sourceRevision: "r3",
						question: "Unrelated work",
					},
				})
			).status,
		).toBe(400);
		expect(
			(
				await first.tool(reviewer.secret, "organization_act", {
					caseId: waiting.caseId,
					expectedRevision: decision.data.revision,
					action: "approve",
				})
			).isError,
		).toBe(false);
		const run = (await detail()).runs[0];
		const action = (secret: string, args: object) =>
			second.tool<LoopRun>(secret, "loops_run_action", {
				loopId: created.id,
				runId: run.id,
				...args,
			});
		const competing = await Promise.all([
			action(renderer.secret, {
				action: "claim",
				expectedRevision: run.revision,
			}),
			action(renderer.secret, {
				action: "claim",
				expectedRevision: run.revision,
			}),
		]);
		expect(competing.filter((r) => !r.isError)).toHaveLength(1);
		const claim = competing.find((r) => !r.isError)?.data;
		expect(claim?.claimedBy?.id).toBe(renderer.id);
		const completed = await action(renderer.secret, {
			action: "complete",
			expectedRevision: claim?.revision,
			evidence: "work:render/cut-4",
			costCents: 80,
		});
		expect(completed.isError).toBe(false);
		expect(
			(
				await action(renderer.secret, {
					action: "pass",
					expectedRevision: completed.data.revision,
					evidence: "work:render/cut-4",
				})
			).isError,
		).toBe(true);
		const verified = await action(verifier.secret, {
			action: "pass",
			expectedRevision: completed.data.revision,
			evidence: "work:qc/cut-4",
		});
		expect(verified.data.status).toBe("completed");
		expect(verified.data.events.some((event) => event.costCents === 80)).toBe(
			true,
		);
		await observe(second, secondCheck);
		loop = await detail();
		expect(loop.runs).toHaveLength(1);
		expect(loop).toMatchObject({
			activeRuns: 0,
			pendingDecisions: 0,
			current: { value: 72, numerator: 18, denominator: 25 },
		});
		const nextShot = {
			...input,
			eventId: "sample-2",
			workId: "shot-015",
			numerator: 1,
			denominator: 1,
		};
		await observe(second, nextShot);
		loop = await detail();
		expect(loop.current).toMatchObject({ numerator: 19, denominator: 26 });
		const samplePath = `${path}/samples?day=${input.observedAt.slice(0, 10)}&limit=1`;
		const latest = await second.ok<LoopSamplesPage>("GET", samplePath);
		expect(latest.observations.map((o) => o.eventId)).toEqual(["sample-2"]);
		expect(latest.observations[0].actor.kind).toBe("api-token");
		if (!latest.next) throw new Error("Expected a second sample page.");
		const prior = await first.ok<LoopSamplesPage>(
			"GET",
			`${samplePath}&after=${encodeURIComponent(latest.next)}`,
		);
		expect(prior.observations.map((o) => o.eventId)).toEqual(["sample-1"]);
		expect(prior.next).toBeNull();
		expect(
			(await first.refused("GET", `${samplePath}&after=invalid`)).status,
		).toBe(400);
	},
	30_000,
);
