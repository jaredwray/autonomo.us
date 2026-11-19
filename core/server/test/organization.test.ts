import type { OrgActorRef } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { controlPlaneConnection } from "../src/mongo.js";
import type {
	OrganizationDirectory,
	OrgPrincipal,
} from "../src/organization/directory.js";
import { OrganizationService } from "../src/organization/organization.js";
import {
	type CaseNotice,
	MemoryOrganizationRepository,
	MongoOrganizationRepository,
	type OrganizationRepository,
} from "../src/organization/repository.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const workspaceId = "studio";
const actor = (id: string, kind: OrgActorRef["kind"] = "agent") => ({
	workspaceId,
	actor: { id, kind },
});
const admin = actor("producer", "user"),
	artist = actor("artist"),
	editor = actor("editor"),
	director = actor("director");
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const fn of cleanups.splice(0).reverse()) await fn();
});
const available = await mongoAvailable();
function setup(repo: OrganizationRepository) {
	const people = new Map<string, OrgPrincipal>();
	for (const c of [admin, artist, editor, director])
		people.set(c.actor.id, {
			identity: {
				...c.actor,
				name: c.actor.id,
				type: c.actor.kind === "user" ? "human" : "token",
			},
			use: true,
			manage: c === admin,
			decide: c !== editor,
		});
	const directory: OrganizationDirectory = {
		active: async () => true,
		resolve: async (w, who) =>
			w === workspaceId && people.get(who.id)?.identity.kind === who.kind
				? (people.get(who.id) ?? null)
				: null,
		list: async () => [...people.values()].map((p) => p.identity),
		evidence: async (_w, who, e) =>
			!e.ref.startsWith("channel:") || who.id === editor.actor.id,
	};
	let time = Date.UTC(2026, 0, 1);
	let failDelivery = false;
	const notices: CaseNotice[] = [];
	const service = (store = repo) =>
		new OrganizationService(store, directory, {
			now: () => time,
			notify: async (_w, _id, n) => {
				if (failDelivery) throw new Error("Synthetic outbox interruption");
				notices.push(n);
			},
		});
	const org = service();
	async function studio() {
		const fallback = await org.position(admin, null, {
			title: "Producer",
			occupant: admin.actor,
		});
		const manager = await org.position(admin, null, {
			title: "Director",
			occupant: director.actor,
			managerId: fallback.id,
		});
		const owner = await org.position(admin, null, {
			title: "Art",
			occupant: artist.actor,
			managerId: manager.id,
		});
		const requester = await org.position(admin, null, {
			title: "Editor",
			occupant: editor.actor,
			managerId: manager.id,
		});
		await org.settings(admin, {
			leadPositionId: manager.id,
			humanFallbackPositionId: fallback.id,
		});
		const spec = {
			ownerPositionId: owner.id,
			fallbackPositionIds: [fallback.id],
			deadlineMinutes: 30,
		};
		await org.rule(admin, "continuity", spec);
		const input = {
			decisionKey: "continuity",
			sourceWorkId: "shot-014",
			sourceRevision: "r2",
			question: "May I change this shot to reference B?",
			requesterPositionId: requester.id,
			evidence: [
				{ label: "Rejected cut", ref: "channel:source:message" },
				{ label: "Proposed reference", ref: "work:reference-B" },
			],
		};
		return { owner, manager, fallback, requester, input, spec };
	}
	return {
		org,
		service,
		studio,
		people,
		notices,
		directory,
		clock: (ms: number) => {
			time += ms;
		},
		fail: (on: boolean) => {
			failDelivery = on;
		},
	};
}
describe.each(["memory", "mongodb"])("workspace organization (%s)", (kind) => {
	const test = kind === "mongodb" && !available ? it.skip : it;
	function repositories() {
		if (kind === "memory") {
			const repo = new MemoryOrganizationRepository();
			return { repo, reconnect: () => repo };
		}
		const url = uniqueMongoUrl("org");
		const client = new MongoClient(url);
		cleanups.push(async () => {
			await client.db().dropDatabase();
			await client.close();
		});
		const reconnect = () => {
			const connection = controlPlaneConnection(url);
			cleanups.push(() => connection.close());
			return new MongoOrganizationRepository(connection);
		};
		return { repo: reconnect(), reconnect };
	}
	test("serializes conflicting branch moves and retains historical positions on archive", async () => {
		const { org, studio } = setup(repositories().repo);
		const { manager, owner, requester } = await studio();
		const moved = await Promise.allSettled([
			org.position(admin, owner.id, { managerId: requester.id }),
			org.position(admin, requester.id, { managerId: owner.id }),
		]);
		expect(moved.filter((x) => x.status === "fulfilled")).toHaveLength(1);
		await expect(
			org.position(admin, manager.id, { managerId: manager.id }),
		).rejects.toMatchObject({ statusCode: 409 });
		const before = await org.detail(admin, manager.id);
		expect(before.position.childCount).toBe(1);
		await org.position(admin, manager.id, { archived: true });
		expect((await org.detail(admin, manager.id)).position.archived).toBe(true);
		expect((await org.branch(admin, { q: "director" })).positions).toEqual([]);
	});
	test("enforces workspace access, role ambiguity, rule precedence, and source evidence permissions", async () => {
		const { org, studio } = setup(repositories().repo);
		const { manager, owner, requester, fallback, input, spec } = await studio();
		expect(
			(await org.preview(editor, { decisionKey: "unfamiliar" })).steps.map(
				(s) => s.position.id,
			),
		).toEqual([manager.id, fallback.id]);
		expect(
			(await org.preview(editor, { decisionKey: "continuity" })).steps.map(
				(s) => s.position.id,
			),
		).toEqual([owner.id, fallback.id]);
		await org.position(admin, null, {
			title: "Second position",
			occupant: editor.actor,
		});
		await expect(
			org.preview(editor, { decisionKey: "unfamiliar" }),
		).rejects.toMatchObject({ statusCode: 409 });
		await expect(
			org.open(editor, { ...input, requesterPositionId: owner.id }),
		).rejects.toMatchObject({ statusCode: 403 });
		await expect(org.rule(editor, "continuity", spec)).rejects.toMatchObject({
			statusCode: 403,
		});
		await expect(
			org.settings(admin, {
				leadPositionId: owner.id,
				humanFallbackPositionId: owner.id,
			}),
		).rejects.toMatchObject({ statusCode: 400 });
		const created = await org.open(editor, input);
		expect(created.evidence).toHaveLength(2);
		expect(
			(await org.read(artist, created.id)).evidence.map((e) => e.ref),
		).toEqual(["work:reference-B"]);
		await expect(
			org.open(artist, {
				...input,
				sourceWorkId: "shot-015",
				requesterPositionId: owner.id,
			}),
		).rejects.toMatchObject({ statusCode: 403 });
		await expect(
			org.detail({ ...admin, workspaceId: "other" }, requester.id),
		).rejects.toMatchObject({ statusCode: 403 });
		expect((await org.detail(director, owner.id)).cases).toHaveLength(0);
		await expect(org.read(director, created.id)).rejects.toMatchObject({
			statusCode: 404,
		});
	});
	test("deduplicates blocked work under concurrency, accepts one outcome, and retries pending notifications after restart", async () => {
		const { repo, reconnect } = repositories(),
			{ org, service, studio, notices, fail } = setup(repo),
			{ input } = await studio();
		fail(true);
		const creates = await Promise.all(
			Array.from({ length: 4 }, () => org.open(editor, input)),
		);
		expect(new Set(creates.map((x) => x.id)).size).toBe(1);
		expect(creates[0].history.map((e) => e.event)).toEqual([
			"opened",
			"assigned",
		]);
		const afterRestart = service(reconnect());
		fail(false);
		await afterRestart.sweep();
		expect(
			notices.some(
				(n) =>
					n.type === "decision.assigned" && n.recipient.id === artist.actor.id,
			),
		).toBe(true);
		await expect(
			afterRestart.open(editor, {
				...input,
				question: "Approve a different reference?",
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		const c = creates[0];
		const outcomes = await Promise.allSettled([
			org.act(artist, c.id, {
				action: "approve",
				expectedRevision: c.revision,
			}),
			afterRestart.act(artist, c.id, {
				action: "request_changes",
				expectedRevision: c.revision,
				reason: "A visible mismatch.",
			}),
		]);
		expect(outcomes.filter((x) => x.status === "fulfilled")).toHaveLength(1);
		const final = await afterRestart.read(editor, c.id);
		expect(final.outcome).toMatchObject({
			sourceWorkId: input.sourceWorkId,
			sourceRevision: input.sourceRevision,
			by: { id: artist.actor.id },
		});
		expect(
			final.history.filter((e) =>
				["approved", "changes_requested"].includes(e.event),
			),
		).toHaveLength(1);
		expect((await afterRestart.open(editor, input)).outcome?.id).toBe(
			final.outcome?.id,
		);
		expect(
			notices.some(
				(n) =>
					n.type === "decision.outcome" && n.outcomeId === final.outcome?.id,
			),
		).toBe(true);
	});
	test("returns a receipt after a permitted handoff and refuses any further action by the former assignee", async () => {
		const { org, studio } = setup(repositories().repo);
		const { input, fallback, manager } = await studio();
		const c = await org.open(editor, input);
		await expect(
			org.act(artist, c.id, {
				action: "handoff",
				targetPositionId: manager.id,
				expectedRevision: c.revision,
			}),
		).rejects.toMatchObject({ statusCode: 403 });
		const moved = await org.act(artist, c.id, {
			action: "handoff",
			targetPositionId: fallback.id,
			expectedRevision: c.revision,
			reason: "Needs a person.",
		});
		expect(moved).toMatchObject({
			id: c.id,
			canAct: false,
			canHandoff: false,
			assigneePositionId: fallback.id,
		});
		expect(moved.history.at(-2)).toMatchObject({
			event: "handoff",
			by: { id: artist.actor.id },
			reason: "Needs a person.",
		});
		await expect(
			org.act(artist, c.id, {
				action: "approve",
				expectedRevision: moved.revision,
			}),
		).rejects.toMatchObject({ statusCode: 404 });
		expect((await org.read(admin, c.id)).canAct).toBe(true);
	});
	test("processes a deadline after restart without rerouting historical cases under a newer rule", async () => {
		const { repo, reconnect } = repositories(),
			{ org, service, studio, clock } = setup(repo),
			{ input, manager, spec, fallback } = await studio();
		const c = await org.open(editor, input);
		await org.rule(admin, "continuity", {
			...spec,
			ownerPositionId: manager.id,
		});
		clock(30 * 60_000 + 1);
		const restarted = service(reconnect());
		await Promise.all([
			restarted.sweep(),
			org
				.act(artist, c.id, { action: "approve", expectedRevision: c.revision })
				.catch(() => {}),
		]);
		const moved = await restarted.read(admin, c.id);
		expect(moved).toMatchObject({
			id: c.id,
			status: "open",
			assigneePositionId: fallback.id,
			route: { ruleVersion: 1 },
		});
		expect(moved.history.map((e) => e.event)).toEqual([
			"opened",
			"assigned",
			"timeout",
			"assigned",
		]);
		await expect(
			org.act(artist, c.id, {
				action: "approve",
				expectedRevision: moved.revision,
			}),
		).rejects.toMatchObject({ statusCode: 404 });
		const done = await restarted.act(admin, c.id, {
			action: "request_changes",
			reason: "Repair the cut.",
			expectedRevision: moved.revision,
		});
		expect(
			(await org.list(editor, { view: "requested" })).cases[0].outcome?.id,
		).toBe(done.outcome?.id);
		expect(done.outcome?.reason).toBe("Repair the cut.");
	});
	test("revalidates possession, vacancy and grants, and leaves an exhausted case actionable only by human triage", async () => {
		const { org, studio, people } = setup(repositories().repo),
			{ input, owner, fallback, manager } = await studio();
		const c = await org.open(editor, input);
		await org.position(admin, owner.id, { occupant: director.actor });
		expect((await org.list(director)).cases.map((x) => x.id)).toEqual([c.id]);
		await expect(
			org.act(artist, c.id, {
				action: "approve",
				expectedRevision: c.revision,
			}),
		).rejects.toMatchObject({ statusCode: 404 });
		await org.position(admin, fallback.id, { occupant: null });
		const granted = people.get(director.actor.id) as OrgPrincipal;
		granted.decide = false;
		const triage = await org.read(admin, c.id);
		expect(triage).toMatchObject({
			status: "triage",
			canAct: false,
			canHandoff: true,
		});
		await expect(org.list(editor, { view: "triage" })).rejects.toMatchObject({
			statusCode: 403,
		});
		expect(
			(await org.list(admin, { view: "triage" })).cases.map((x) => x.id),
		).toEqual([c.id]);
		await expect(
			org.act(admin, c.id, {
				action: "approve",
				expectedRevision: triage.revision,
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		granted.decide = true;
		const again = await org.act(admin, c.id, {
			action: "handoff",
			targetPositionId: manager.id,
			expectedRevision: triage.revision,
		});
		expect(again).toMatchObject({
			id: c.id,
			assigneePositionId: manager.id,
			status: "open",
		});
		expect(again.route).toEqual(c.route);
	});
});
