import type {
	DecisionCase,
	OrgBranch,
	OrgIdentity,
	OrgPosition,
} from "@autonomo.us/common";
import { afterEach, expect, it } from "vitest";
import { startChannels } from "./channel-helpers.js";

const closers: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of closers.splice(0).reverse()) await close();
});
it("uses authenticated workspace roles and live grants across REST and MCP, including same-ID lookups across workspaces", async () => {
	const a = await startChannels(closers);
	const base = `/v1/${a.workspaceId}/organization`;
	const apiKey = await a.apiToken(["channels:read"]);
	const member = await a.join("member@studio.example");
	expect(
		(await a.refused("GET", `${base}/branch`, { token: apiKey })).status,
	).toBe(403);
	expect(
		(
			await a.refused("POST", `${base}/positions`, {
				token: member.token,
				body: { title: "Owner" },
			})
		).status,
	).toBe(403);
	const owner = await a.agent("Iris", [
		"mcp:read",
		"mcp:call",
		"organization:decide",
	]);
	const requester = await a.agent("Splice");
	const p = await a.ok<OrgPosition>(
		"POST",
		`${base}/positions`,
		{ body: { title: "Art", occupant: { kind: "agent", id: owner.id } } },
		201,
	);
	const bot = await a.ok<{ id: string }>(
		"POST",
		`/v1/${a.workspaceId}/bots`,
		{
			body: {
				name: "Hosted",
				instructions: "Test",
				model: "auto",
				tools: true,
			},
		},
		201,
	);
	const oauth = await a.ok<{ id: string }>(
		"POST",
		`/v1/${a.workspaceId}/agents/oauth`,
		{ body: { name: "OAuth", description: "Test", permissions: ["mcp:call"] } },
		201,
	);
	const identities = await a.ok<{ identities: OrgIdentity[] }>(
		"GET",
		`${base}/identities`,
	);
	expect(identities.identities).toEqual(
		expect.arrayContaining([
			expect.objectContaining({ id: bot.id, type: "instructions" }),
			expect.objectContaining({ id: oauth.id, type: "oauth" }),
			expect.objectContaining({ id: owner.id, type: "token" }),
			expect.objectContaining({ id: a.owner.user.id, type: "human" }),
		]),
	);
	await a.ok("PUT", `${base}/rules/continuity`, {
		body: {
			ownerPositionId: p.id,
			fallbackPositionIds: [],
			deadlineMinutes: 30,
		},
	});
	const source = await a.createChannel("cuts");
	await a.addAgent(source.id, requester.id, "read");
	const cut = await a.post(source.id, "Rejected cut, synthetic evidence.");
	const evidence = [
		{ label: "Rejected cut", ref: `channel:${source.id}:${cut.id}` },
	];
	const caseArgs = {
		evidence,
		decisionKey: "continuity",
		sourceWorkId: "shot-014",
		sourceRevision: "r2",
		question: "Change the reference?",
	};
	const c = (
		await a.tool<DecisionCase>(
			requester.secret,
			"organization_open_case",
			caseArgs,
		)
	).data;
	expect(c.requester.id).toBe(requester.id);
	expect(c.evidence).toEqual(evidence);
	expect(
		(
			await a.tool<DecisionCase>(owner.secret, "organization_read_case", {
				caseId: c.id,
			})
		).data.evidence,
	).toEqual([]);
	await a.addAgent(source.id, owner.id, "read");
	expect(
		(
			await a.tool<DecisionCase>(owner.secret, "organization_read_case", {
				caseId: c.id,
			})
		).data.evidence,
	).toEqual(evidence);
	expect(
		(await a.tool(owner.secret, "organization_read_case", { caseId: c.id }))
			.isError,
	).toBe(false);
	expect(
		(
			await a.rpc(requester.secret, "tools/call", {
				name: "organization_act",
				arguments: {
					caseId: c.id,
					action: "approve",
					expectedRevision: c.revision,
				},
			})
		).error?.code,
	).toBe(-32001);
	const other = await a.ok<{ id: string }>(
		"POST",
		"/v1/workspaces",
		{ body: { name: "Foreign", description: "" } },
		201,
	);
	const foreign = `/v1/${other.id}/organization`;
	expect((await a.ok<OrgBranch>("GET", `${foreign}/branch`)).positions).toEqual(
		[],
	);
	expect((await a.refused("GET", `${foreign}/cases/${c.id}`)).status).toBe(404);
	expect((await a.refused("GET", `${foreign}/positions/${p.id}`)).status).toBe(
		404,
	);
	expect(
		(
			await a.refused("POST", `${foreign}/positions`, {
				body: { title: "Mixed", occupant: { kind: "agent", id: owner.id } },
			})
		).status,
	).toBe(409);
	expect(
		(await a.refused("GET", `${base}/cases/${c.id}`, { token: member.token }))
			.status,
	).toBe(404);
	await a.ok("DELETE", `/v1/${a.workspaceId}/agent-tokens/${owner.id}`);
	const triage = (
		await a.tool<DecisionCase>(requester.secret, "organization_read_case", {
			caseId: c.id,
		})
	).data;
	expect(triage.status).toBe("triage");
});
