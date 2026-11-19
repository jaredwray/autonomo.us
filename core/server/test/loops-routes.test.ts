import type {
	ApiTokenSecret,
	CreateLoop,
	DecisionCase,
	DecisionCasePage,
	LoopDetail,
	LoopPreview,
	OrgPosition,
} from "@autonomo.us/common";
import { afterEach, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});

it("binds observations to scoped API and MCP credentials and protects management and workspace boundaries", async () => {
	const a = await startChannels(closers),
		base = `/v1/${a.workspaceId}`;
	const member = await a.join("reviewer@loops.example"),
		readAgent = await a.agent("Observer", [
			"mcp:read",
			"mcp:call",
			"loops:read",
		]);
	const pos = await a.ok<OrgPosition>(
		"POST",
		`${base}/organization/positions`,
		{
			body: {
				title: "Quality",
				occupant: { kind: "user", id: a.owner.user.id },
			},
		},
		201,
	);
	const input: CreateLoop = {
		name: "Shot continuity",
		goal: "Improve first-pass acceptance",
		ownerPositionId: pos.id,
		metric: {
			name: "First pass",
			source: "QC",
			direction: "at_least",
			target: 80,
			staleAfterMinutes: 60,
		},
		workflow: {
			triggerCount: 2,
			decisionKey: "review",
			steps: [
				{ id: "review", kind: "decision", name: "Retry?", assignee: null },
				{
					id: "render",
					kind: "action",
					name: "Render",
					assignee: { kind: "user", id: a.owner.user.id },
					maxCostCents: 80,
				},
				{
					id: "verify",
					kind: "verify",
					name: "Check the cut",
					assignee: { kind: "user", id: member.user.id },
				},
			],
		},
	};
	expect(
		(
			await a.refused("POST", `${base}/loops`, {
				token: member.token,
				body: input,
			})
		).status,
	).toBe(403);
	const trigger = { workId: "shot", workRevision: "r1", trigger: true };
	const previewInput = {
		ownerPositionId: pos.id,
		workflow: input.workflow,
		observations: [
			{ ...trigger, eventId: "1" },
			{ ...trigger, eventId: "1" },
			{ ...trigger, eventId: "2" },
		],
	};
	const worker = await a.agent("Action worker", ["mcp:call", "loops:act"]);
	const eligible = await a.ok<{ identities: { id: string }[] }>(
		"GET",
		`${base}/organization/identities?loopAct=true`,
	);
	expect(eligible.identities.map((i) => i.id)).toEqual(
		expect.arrayContaining([worker.id, member.user.id]),
	);
	expect(eligible.identities.map((i) => i.id)).not.toContain(readAgent.id);
	const preview = await a.ok<LoopPreview>("POST", `${base}/loops/preview`, {
		body: previewInput,
	});
	expect(preview.distinctEvents).toBe(2);
	expect(preview.matched).toEqual([
		{ workId: "shot", workRevision: "r1", count: 2 },
	]);
	expect(
		(
			await a.refused("POST", `${base}/loops/preview`, {
				body: previewInput,
				token: member.token,
			})
		).status,
	).toBe(403);
	expect(await a.ok("GET", `${base}/loops`)).toEqual({
		loops: [],
		pendingDecisions: 0,
	});
	const ineligible = structuredClone(input);
	ineligible.workflow.steps[1].assignee = { kind: "agent", id: readAgent.id };
	expect(
		(await a.refused("POST", `${base}/loops`, { body: ineligible })).status,
	).toBe(400);
	const loop = await a.ok<LoopDetail>(
			"POST",
			`${base}/loops`,
			{ body: input },
			201,
		),
		detail = `${base}/loops/${loop.id}`;
	expect(loop.workflow.steps[1].maxCostCents).toBe(80);
	const source = await a.ok<ApiTokenSecret>(
		"POST",
		`${base}/api-tokens`,
		{
			body: {
				name: "QC source",
				description: "",
				ttlDays: 7,
				permissions: ["loops:report"],
			},
		},
		201,
	);
	const observation = {
		eventId: "batch-1",
		workId: "shot-1",
		workRevision: "v1",
		observedAt: new Date().toISOString(),
		trigger: false,
		numerator: 18,
		denominator: 25,
	};
	const wrongKey = await a.apiToken(["telemetry:read"]);
	expect(
		(
			await a.refused("POST", `${detail}/observations`, {
				token: wrongKey,
				body: observation,
			})
		).status,
	).toBe(403);
	expect(
		(await a.refused("GET", detail, { token: source.secret })).status,
	).toBe(403);
	expect(
		(
			await a.refused("POST", `${detail}/runs/missing/actions`, {
				token: source.secret,
				body: { action: "claim", expectedRevision: 1 },
			})
		).status,
	).toBe(403);
	await a.ok("POST", `${detail}/observations`, {
		token: source.secret,
		body: observation,
	});
	await a.ok("POST", `${detail}/observations`, {
		token: source.secret,
		body: observation,
	});
	const seen = await a.tool<LoopDetail>(readAgent.secret, "loops_read", {
		loopId: loop.id,
	});
	expect(seen.data.current?.value).toBe(72);
	expect(seen.data.observations).toHaveLength(1);
	expect(seen.data.observations[0].actor).toEqual({
		kind: "api-token",
		id: source.token.id,
	});
	expect(
		(
			await a.rpc(readAgent.secret, "tools/call", {
				name: "loops_observe",
				arguments: { loopId: loop.id, ...observation },
			})
		).error?.code,
	).toBe(-32001);
	const machine = await a.agent("Telemetry", ["mcp:call", "loops:report"]);
	expect(
		(
			await a.tool(machine.secret, "loops_observe", {
				loopId: loop.id,
				...observation,
				eventId: "check-1",
				denominator: 0,
				numerator: 0,
				trigger: true,
			})
		).isError,
	).toBe(false);
	const day = observation.observedAt.slice(0, 10);
	const samples = await a.tool(readAgent.secret, "loops_samples", {
		loopId: loop.id,
		day,
	});
	expect(samples.isError).toBe(false);
	expect(samples.data).toEqual(
		await a.ok("GET", `${detail}/samples?day=${day}`),
	);
	const fresh = await a.ok<LoopDetail>("GET", detail);
	expect(fresh.current?.denominator).toBe(25);
	expect(
		fresh.observations.find((row) => row.eventId === "check-1")?.actor,
	).toEqual({ kind: "agent", id: machine.id });
	const other = await a.ok<{ id: string }>(
		"POST",
		"/v1/workspaces",
		{ body: { name: "Other", description: "" } },
		201,
	);
	const foreign = `/v1/${other.id}/loops/${loop.id}`;
	expect((await a.refused("GET", foreign)).status).toBe(404);
	expect(
		(
			await a.refused("POST", `${foreign}/observations`, {
				token: source.secret,
				body: observation,
			})
		).status,
	).toBe(403);
});

it("only counts organization cases visible in the paged pending tab", async () => {
	const a = await startChannels(closers),
		base = `/v1/${a.workspaceId}`,
		org = `${base}/organization`;
	const requester = await a.join("requester@loops.example"),
		stranger = await a.join("stranger@loops.example");
	const p = await a.ok<OrgPosition>(
		"POST",
		`${org}/positions`,
		{
			body: {
				title: "Duty reviewer",
				occupant: { kind: "user", id: a.owner.user.id },
			},
		},
		201,
	);
	await a.ok("PUT", `${org}/rules/quality`, {
		body: {
			ownerPositionId: p.id,
			fallbackPositionIds: [],
			deadlineMinutes: 30,
		},
	});
	const open = (token: string, id: string) =>
		a.ok<DecisionCase>(
			"POST",
			`${org}/cases`,
			{
				token,
				body: {
					decisionKey: "quality",
					sourceWorkId: id,
					sourceRevision: "1",
					question: "Approve this revision?",
				},
			},
			201,
		);
	const item = await open(requester.token, "item1");
	await open(requester.token, "item2");
	await open(stranger.token, "item3");
	const count = async (token: string) =>
		(
			await a.ok<{ pendingDecisions: number }>("GET", `${base}/loops`, {
				token,
			})
		).pendingDecisions;
	expect(await count(a.owner.token)).toBe(3);
	expect(await count(stranger.token)).toBe(1);
	expect(await count(requester.token)).toBe(2);
	const page = await a.ok<DecisionCasePage>(
		"GET",
		`${org}/cases?view=pending&limit=1`,
		{ token: requester.token },
	);
	expect(page.cases).toHaveLength(1);
	expect(page.next).toBeTruthy();
	const next = await a.ok<DecisionCasePage>(
		"GET",
		`${org}/cases?view=pending&limit=1&after=${page.next}`,
		{ token: requester.token },
	);
	expect(next.cases).toHaveLength(1);
	expect(next.cases[0].id).not.toBe(page.cases[0].id);
	await a.ok("POST", `${org}/cases/${item.id}/act`, {
		body: { expectedRevision: item.revision, action: "approve" },
	});
	expect(await count(requester.token)).toBe(1);
	expect(await count(a.owner.token)).toBe(2);
});
