import { randomUUID } from "node:crypto";
import type {
	SynapseActor,
	SynapseFlag,
	SynapseMaintenanceBatch,
	SynapseProposal,
	SynapseSpaceId,
} from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { MemorySynapseRepository } from "../src/synapse/memory-repository.js";
import { MongoSynapseRepository } from "../src/synapse/mongo-repository.js";
import {
	revisionId,
	type StoredNote,
	type StoredRevision,
	type SynapseRepository,
} from "../src/synapse/repository.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn("[synapse-repository] no MongoDB — skipping the MongoDB half.");
const mongoUrl = uniqueMongoUrl("synapse");
const cleanup = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
afterAll(async () => {
	if (available) await cleanup.db().dropDatabase();
	await cleanup.close();
});

const actor: SynapseActor = { kind: "user", id: "u", name: "U" };

function note(
	space: SynapseSpaceId,
	title: string,
	extra: Partial<StoredNote> = {},
): StoredNote {
	const at = extra.createdAt ?? "2026-11-08T10:00:00.000Z";
	return {
		id: randomUUID(),
		space,
		title,
		titleKey: title.toLowerCase(),
		properties: {},
		body: "",
		links: [],
		linkKeys: [],
		tags: [],
		tagKeys: [],
		categories: [],
		categoryKeys: [],
		searchText: title.toLowerCase(),
		propertyKeys: [],
		createdAt: at,
		updatedAt: at,
		createdBy: actor,
		updatedBy: actor,
		revision: 1,
		...extra,
	};
}

/** Every implementation must pass the same expectations. */
function contract(name: string, open: () => SynapseRepository) {
	describe(name, () => {
		it("excludes title keys and filters proposals by the shared space they target", async () => {
			const repo = open();
			try {
				const space: SynapseSpaceId = `shared-${randomUUID()}`;
				for (const title of ["Ada", "Bob", "Cy"])
					await repo.insertNote(note(space, title));
				const sort = { by: "titleKey" as const, direction: "asc" as const };
				expect(
					(
						await repo.findNotes(
							{ space, excludeTitleKeys: ["bob"] },
							{ sort, limit: 10 },
						)
					).map((item) => item.title),
				).toEqual(["Ada", "Cy"]);
				expect(
					await repo.countNotes({ space, excludeTitleKeys: ["ada", "cy"] }),
				).toBe(1);
				expect(await repo.countNotes({ space, excludeTitleKeys: [] })).toBe(3);
				const author = randomUUID();
				const proposal = (target: SynapseSpaceId): SynapseProposal => ({
					id: randomUUID(),
					space: target,
					action: "create",
					title: "T",
					body: "b",
					reason: "r",
					status: "pending",
					author: { kind: "agent", id: author, name: "A" },
					createdAt: "2026-11-08T00:00:00.000Z",
					baseRevision: null,
				});
				const mine = proposal(space);
				await repo.insertProposal(mine);
				await repo.insertProposal(proposal("shared"));
				expect(
					(await repo.listProposals({ space, authorId: author })).map(
						(item) => item.id,
					),
				).toEqual([mine.id]);
				expect(
					await repo.countProposals({ space: "shared", authorId: author }),
				).toBe(1);
				expect(await repo.countProposals({ authorId: author })).toBe(2);
			} finally {
				await repo.close();
			}
		});

		it("lists a shared space's latest decisions, most recently decided first", async () => {
			const repo = open();
			try {
				const space: SynapseSpaceId = `shared-${randomUUID()}`;
				const actor = { kind: "agent" as const, id: randomUUID(), name: "A" };
				const proposal = (
					title: string,
					status: SynapseProposal["status"],
					decidedAt?: string,
					target: SynapseSpaceId = space,
				): SynapseProposal => ({
					id: randomUUID(),
					space: target,
					action: "create",
					title,
					body: "b",
					reason: "r",
					status,
					author: actor,
					createdAt: "2026-11-08T00:00:00.000Z",
					baseRevision: null,
					...(decidedAt
						? {
								decidedAt,
								decidedBy: { kind: "user" as const, id: "u", name: "U" },
							}
						: {}),
				});
				for (const item of [
					proposal("Waiting", "pending"),
					proposal("Older", "approved", "2026-11-09T00:00:00.000Z"),
					proposal("Newer", "rejected", "2026-11-10T00:00:00.000Z"),
					proposal("Newest", "approved", "2026-11-11T00:00:00.000Z"),
					proposal(
						"Elsewhere",
						"approved",
						"2026-11-12T00:00:00.000Z",
						"shared",
					),
				])
					await repo.insertProposal(item);
				expect(
					(await repo.recentDecisions(space, 2)).map((item) => item.title),
				).toEqual(["Newest", "Newer"]);
				expect(await repo.recentDecisions(space, 10)).toHaveLength(3);
			} finally {
				await repo.close();
			}
		});

		it("claims titles uniquely per space and compares revisions on replace and delete", async () => {
			const repo = open();
			try {
				const a = note("shared", "Ada");
				expect(await repo.insertNote(a)).toBe(true);
				expect(await repo.insertNote(note("shared", "ADA"))).toBe(false);
				expect(await repo.insertNote(note("agent-x", "Ada"))).toBe(true);
				expect(await repo.insertNote(note("agent-x", "Bob"))).toBe(true);
				expect((await repo.getNote("shared", "ada"))?.id).toBe(a.id);
				expect(await repo.getNote("shared", "bob")).toBeNull();
				expect(
					await repo.replaceNote({ ...a, body: "v2", revision: 2 }, 1),
				).toBe(true);
				expect(
					await repo.replaceNote({ ...a, body: "v3", revision: 3 }, 1),
				).toBe(false);
				expect((await repo.getNote("shared", "ada"))?.body).toBe("v2");
				// Renaming onto a title held by another note is refused.
				const bob = await repo.getNote("agent-x", "bob");
				expect(
					await repo.replaceNote(
						{
							...(bob as StoredNote),
							title: "ADA",
							titleKey: "ada",
							revision: 2,
						},
						1,
					),
				).toBe(false);
				expect(await repo.deleteNote(a.id, 1)).toBe(false);
				expect(await repo.deleteNote(a.id, 2)).toBe(true);
				expect(await repo.deleteNote(a.id)).toBe(false);
				expect(await repo.insertNote(note("shared", "Ada"))).toBe(true);
			} finally {
				await repo.close();
			}
		});

		it("filters, sorts, pages, counts, and scans", async () => {
			const repo = open();
			const space = `agent-${randomUUID()}` as const;
			try {
				await repo.insertNote(
					note(space, "Alpha", {
						links: ["People", "Beta"],
						linkKeys: ["people", "beta"],
						categories: ["People"],
						categoryKeys: ["people"],
						tags: ["projects/active"],
						tagKeys: ["projects/active"],
						searchText: "alpha\nthe quick brown fox",
						propertyKeys: [
							{ k: "status", v: "active" },
							{ k: "n", v: "6" },
						],
						createdAt: "2026-11-01T00:00:00.000Z",
						updatedAt: "2026-11-03T00:00:00.000Z",
					}),
				);
				await repo.insertNote(
					note(space, "beta", {
						links: ["Gamma"],
						linkKeys: ["gamma"],
						tags: ["projects"],
						tagKeys: ["projects"],
						searchText: "beta\nquick (brown) fox.",
						propertyKeys: [{ k: "status", v: "done" }],
						createdAt: "2026-11-02T00:00:00.000Z",
						updatedAt: "2026-11-02T00:00:00.000Z",
					}),
				);
				await repo.insertNote(
					note(space, "Gamma", {
						links: ["Beta"],
						linkKeys: ["beta"],
						tags: ["projectsx"],
						tagKeys: ["projectsx"],
						searchText: "gamma\nslow fox",
						createdAt: "2026-11-03T00:00:00.000Z",
						updatedAt: "2026-11-01T00:00:00.000Z",
					}),
				);
				await repo.insertNote(
					note("shared", "Alpha", { searchText: "alpha quick" }),
				);
				const titles = async (
					filter: Parameters<SynapseRepository["findNotes"]>[0],
					options: Partial<Parameters<SynapseRepository["findNotes"]>[1]> = {},
				) =>
					(
						await repo.findNotes(filter, {
							sort: { by: "titleKey", direction: "asc" },
							limit: 10,
							...options,
						})
					).map((item) => item.title);
				expect(await titles({ space })).toEqual(["Alpha", "beta", "Gamma"]);
				expect(
					await titles(
						{ space },
						{ sort: { by: "updatedAt", direction: "desc" } },
					),
				).toEqual(["Alpha", "beta", "Gamma"]);
				expect(
					await titles(
						{ space },
						{ sort: { by: "createdAt", direction: "desc" } },
					),
				).toEqual(["Gamma", "beta", "Alpha"]);
				expect(await titles({ space }, { limit: 1, offset: 1 })).toEqual([
					"beta",
				]);
				expect(await titles({ space, titleKey: "beta" })).toEqual(["beta"]);
				expect(
					await titles({ space, titleKeys: ["beta", "gamma", "nope"] }),
				).toEqual(["beta", "Gamma"]);
				expect(await titles({ space, linkKey: "beta" })).toEqual([
					"Alpha",
					"Gamma",
				]);
				expect(await titles({ space, linkKeys: ["people", "gamma"] })).toEqual([
					"Alpha",
					"beta",
				]);
				expect(await titles({ space, categoryKey: "people" })).toEqual([
					"Alpha",
				]);
				expect(await titles({ space, tagPrefix: "projects" })).toEqual([
					"Alpha",
					"beta",
				]);
				expect(await titles({ space, tagPrefix: "projects/active" })).toEqual([
					"Alpha",
				]);
				expect(await titles({ space, terms: ["quick", "fox"] })).toEqual([
					"Alpha",
					"beta",
				]);
				expect(await titles({ space, terms: ["(brown)"] })).toEqual(["beta"]);
				expect(await titles({ space, terms: ["quick", "slow"] })).toEqual([]);
				expect(
					await titles({ space, where: [{ k: "status", v: "active" }] }),
				).toEqual(["Alpha"]);
				expect(
					await titles({
						space,
						where: [
							{ k: "status", v: "active" },
							{ k: "n", v: "6" },
						],
					}),
				).toEqual(["Alpha"]);
				expect(
					await titles({
						space,
						where: [
							{ k: "status", v: "active" },
							{ k: "n", v: "7" },
						],
					}),
				).toEqual([]);
				expect(await repo.countNotes({ space })).toBe(3);
				expect(await repo.countNotes({ space, terms: ["fox"] })).toBe(3);
				const scanned = await repo.scanNotes(space);
				expect(scanned.map((entry) => entry.title).sort()).toEqual([
					"Alpha",
					"Gamma",
					"beta",
				]);
				expect(scanned[0]).not.toHaveProperty("body");
				expect(scanned[0]).not.toHaveProperty("searchText");
				expect(
					scanned.find((entry) => entry.title === "Alpha")?.linkKeys,
				).toEqual(["people", "beta"]);
				const stats = await repo.spaceStats();
				expect(stats.find((item) => item.space === space)).toEqual({
					space,
					noteCount: 3,
					createdAt: "2026-11-01T00:00:00.000Z",
					updatedAt: "2026-11-03T00:00:00.000Z",
				});
			} finally {
				await repo.close();
			}
		});

		it("orders titles by code point like MongoDB, punctuation, accents, and emoji included", async () => {
			const repo = open();
			const space = `agent-${randomUUID()}` as const;
			try {
				for (const title of [
					"zeta",
					"Émile",
					"a-b",
					"~tilde",
					"ab",
					"_under",
					"a b",
					"eagle",
					"\uFFFD mark",
					"\u{1F600} smile",
				])
					await repo.insertNote(note(space, title));
				const titles = (
					await repo.findNotes(
						{ space },
						{ sort: { by: "titleKey", direction: "asc" }, limit: 20 },
					)
				).map((item) => item.title);
				expect(titles).toEqual([
					"_under",
					"a b",
					"a-b",
					"ab",
					"eagle",
					"zeta",
					"~tilde",
					"Émile",
					"\uFFFD mark",
					"\u{1F600} smile",
				]);
			} finally {
				await repo.close();
			}
		});

		it("finds a day's notes", async () => {
			const repo = open();
			const space = `agent-${randomUUID()}` as const;
			const range = {
				from: "2026-11-08T00:00:00.000Z",
				to: "2026-11-09T00:00:00.000Z",
			};
			try {
				await repo.insertNote(
					note(space, "2026-11-08", { createdAt: "2026-11-09T01:00:00.000Z" }),
				);
				await repo.insertNote(
					note(space, "2026-11-08 standup", {
						createdAt: "2026-11-09T01:00:00.000Z",
					}),
				);
				await repo.insertNote(
					note(space, "Created", { createdAt: "2026-11-08T23:59:59.000Z" }),
				);
				await repo.insertNote(
					note(space, "Edge", { createdAt: "2026-11-09T00:00:00.000Z" }),
				);
				await repo.insertNote(
					note(space, "Dated", {
						createdAt: "2026-11-09T01:00:01.000Z",
						propertyKeys: [{ k: "published", v: "2026-11-08t09:00" }],
					}),
				);
				await repo.insertNote(
					note(space, "Other property", {
						createdAt: "2026-11-09T01:00:00.000Z",
						propertyKeys: [{ k: "deadline", v: "2026-11-08" }],
					}),
				);
				await repo.insertNote(
					note(space, "Linker", {
						createdAt: "2026-11-09T01:00:02.000Z",
						links: ["2026-11-08"],
						linkKeys: ["2026-11-08"],
					}),
				);
				const found = await repo.findDailyNotes(space, "2026-11-08", range, 10);
				expect(found.map((item) => item.title)).toEqual([
					"Linker",
					"Dated",
					"2026-11-08 standup",
					"Created",
				]);
				expect(
					await repo.findDailyNotes(space, "2026-11-08", range, 2),
				).toHaveLength(2);
			} finally {
				await repo.close();
			}
		});

		it("keeps space records and proposals", async () => {
			const repo = open();
			const space = `agent-${randomUUID()}` as const;
			try {
				await repo.upsertSpaceRecord(
					space,
					"2026-11-08T00:00:00.000Z",
					undefined,
					space,
				);
				await repo.upsertSpaceRecord(
					space,
					"2026-11-08T01:00:00.000Z",
					"Agent A",
					space,
				);
				await repo.upsertSpaceRecord(
					space,
					"2026-11-08T02:00:00.000Z",
					undefined,
					"ignored",
				);
				expect(
					(await repo.listSpaceRecords()).find((record) => record.id === space),
				).toEqual({
					id: space,
					name: "Agent A",
					createdAt: "2026-11-08T00:00:00.000Z",
					updatedAt: "2026-11-08T02:00:00.000Z",
				});
				const author = randomUUID();
				const make = (title: string, createdAt: string): SynapseProposal => ({
					id: randomUUID(),
					space: "shared",
					action: "create",
					title,
					body: "b",
					reason: "r",
					status: "pending",
					author: { kind: "agent", id: author, name: "A" },
					createdAt,
					baseRevision: null,
				});
				const first = make("First", "2026-11-08T00:00:00.000Z");
				const second = make("Second", "2026-11-08T00:00:01.000Z");
				await repo.insertProposal(first);
				await repo.insertProposal(second);
				expect(await repo.getProposal(first.id)).toEqual(first);
				expect(await repo.getProposal(randomUUID())).toBeNull();
				expect(
					(await repo.listProposals({ authorId: author })).map(
						(item) => item.title,
					),
				).toEqual(["Second", "First"]);
				expect(
					await repo.countProposals({ authorId: author, status: "pending" }),
				).toBe(2);
				const decision = {
					status: "rejected" as const,
					decidedAt: "2026-11-08T01:00:00.000Z",
					decidedBy: actor,
					decisionReason: "no",
				};
				const now = { now: "2026-11-08T01:00:00.000Z" };
				expect(await repo.decideProposal(first.id, decision, now)).toBe(true);
				expect(await repo.decideProposal(first.id, decision, now)).toBe(false);
				expect(await repo.decideProposal(randomUUID(), decision, now)).toBe(
					false,
				);
				expect(await repo.getProposal(first.id)).toEqual({
					...first,
					...decision,
				});
				expect(
					await repo.countProposals({ authorId: author, status: "pending" }),
				).toBe(1);
				expect(
					(
						await repo.listProposals({ authorId: author, status: "rejected" })
					).map((p) => p.id),
				).toEqual([first.id]);
				// Claims: one live claim at a time, honored by every decision,
				// released on failure, ignored once expired, and never returned.
				const t0 = "2026-11-08T02:00:00.000Z";
				const t1 = "2026-11-08T02:00:30.000Z";
				const t2 = "2026-11-08T02:02:00.000Z";
				const until = "2026-11-08T02:01:00.000Z";
				const approval = {
					status: "approved" as const,
					decidedAt: t1,
					decidedBy: actor,
				};
				expect(
					await repo.claimProposal(first.id, { id: "c0", until }, t0),
				).toBe(false);
				expect(
					await repo.claimProposal(second.id, { id: "c1", until }, t0),
				).toBe(true);
				expect(
					await repo.claimProposal(second.id, { id: "c2", until }, t1),
				).toBe(false);
				expect(
					await repo.decideProposal(second.id, decision, { now: t1 }),
				).toBe(false);
				expect(
					await repo.decideProposal(second.id, approval, {
						now: t1,
						claimId: "c2",
					}),
				).toBe(false);
				expect(await repo.getProposal(second.id)).toEqual(second);
				expect(await repo.releaseProposalClaim(second.id, "c2")).toBe(false);
				expect(await repo.releaseProposalClaim(second.id, "c1")).toBe(true);
				expect(
					await repo.claimProposal(second.id, { id: "c3", until }, t1),
				).toBe(true);
				// An expired claim no longer blocks; its holder can no longer decide.
				expect(
					await repo.claimProposal(
						second.id,
						{ id: "c4", until: "2026-11-08T02:03:00.000Z" },
						t2,
					),
				).toBe(true);
				expect(
					await repo.decideProposal(second.id, approval, {
						now: t2,
						claimId: "c3",
					}),
				).toBe(false);
				expect(
					await repo.decideProposal(second.id, approval, {
						now: t2,
						claimId: "c4",
					}),
				).toBe(true);
				expect(await repo.getProposal(second.id)).toEqual({
					...second,
					...approval,
				});
			} finally {
				await repo.close();
			}
		});

		it("keeps flags and moves them between states", async () => {
			const repo = open();
			try {
				const space: SynapseSpaceId = `shared-${randomUUID()}`;
				const author = randomUUID();
				const make = (
					problem: string,
					createdAt: string,
					extra: Partial<SynapseFlag> = {},
				): SynapseFlag => ({
					id: randomUUID(),
					space,
					kind: "missing",
					problem,
					status: "open",
					author: { kind: "agent", id: author, name: "A" },
					createdAt,
					...extra,
				});
				const first = make("First", "2026-11-08T00:00:00.000Z", {
					title: "Pricing",
					suggestion: "Say it.",
					task: "Report",
				});
				const second = make("Second", "2026-11-08T00:00:01.000Z");
				const other = make("Other", "2026-11-08T00:00:02.000Z", {
					author: { kind: "user", id: "u", name: "U" },
				});
				const elsewhere = make("Elsewhere", "2026-11-08T00:00:03.000Z", {
					space: `shared-${randomUUID()}`,
				});
				for (const flag of [first, second, other, elsewhere])
					await repo.insertFlag(flag);
				expect(await repo.getFlag(first.id)).toEqual(first);
				expect(await repo.getFlag(randomUUID())).toBeNull();
				const problems = async (
					filter: Parameters<SynapseRepository["listFlags"]>[0],
					limit = 10,
				) => (await repo.listFlags(filter, limit)).map((flag) => flag.problem);
				expect(await problems({ space })).toEqual(["Other", "Second", "First"]);
				expect(await problems({ space }, 2)).toEqual(["Other", "Second"]);
				// Further back: the next page, and nothing past the end.
				expect(
					(await repo.listFlags({ space }, 2, second)).map(
						(flag) => flag.problem,
					),
				).toEqual(["First"]);
				expect(await repo.listFlags({ space }, 2, first)).toEqual([]);
				// The place holds whatever the filter: a flag of another status or
				// another space still says where the older ones begin.
				expect(
					(await repo.listFlags({ space, authorId: author }, 5, other)).map(
						(flag) => flag.problem,
					),
				).toEqual(["Second", "First"]);
				expect(
					(await repo.listFlags({ space }, 5, elsewhere)).map(
						(flag) => flag.problem,
					),
				).toEqual(["Other", "Second", "First"]);
				// Flags filed at the same instant are told apart by their IDs.
				const twinSpace: SynapseSpaceId = `shared-${randomUUID()}`;
				const twins = ["a", "b"].map((letter) =>
					make(`Twin ${letter}`, "2026-11-07T00:00:00.000Z", {
						id: `${letter}${randomUUID().slice(1)}`,
						space: twinSpace,
					}),
				);
				for (const twin of twins) await repo.insertFlag(twin);
				const twinSpaceOnly = { space: twinSpace };
				expect(
					(await repo.listFlags(twinSpaceOnly, 5, first)).map(
						(flag) => flag.problem,
					),
				).toEqual(["Twin b", "Twin a"]);
				expect(
					(await repo.listFlags(twinSpaceOnly, 5, twins[1])).map(
						(flag) => flag.problem,
					),
				).toEqual(["Twin a"]);
				expect(await repo.listFlags(twinSpaceOnly, 5, twins[0])).toEqual([]);
				expect(await problems({ space, authorId: author })).toEqual([
					"Second",
					"First",
				]);
				expect(await repo.countFlags({ space, status: "open" })).toBe(3);

				const proposalId = randomUUID();
				const proposed = { status: "proposed" as const, proposalId };
				expect(
					await repo.setFlagState(first.id, { status: ["open"] }, proposed),
				).toBe(true);
				// Only from the states named, and only for a flag that exists.
				expect(
					await repo.setFlagState(first.id, { status: ["open"] }, proposed),
				).toBe(false);
				expect(
					await repo.setFlagState(randomUUID(), { status: ["open"] }, proposed),
				).toBe(false);
				expect(await repo.getFlag(first.id)).toEqual({ ...first, ...proposed });
				expect(await problems({ proposalId, status: "proposed" })).toEqual([
					"First",
				]);
				expect(await problems({ space, status: "open" })).toEqual([
					"Other",
					"Second",
				]);
				// Another proposal's decision does not move it.
				expect(
					await repo.setFlagState(
						first.id,
						{ status: ["proposed"], proposalId: randomUUID() },
						{ status: "open" },
					),
				).toBe(false);
				const resolved = {
					status: "resolved" as const,
					proposalId,
					resolvedAt: "2026-11-08T01:00:00.000Z",
					resolvedBy: actor,
					resolution: "Approved.",
				};
				expect(
					await repo.setFlagState(
						first.id,
						{ status: ["proposed"], proposalId },
						resolved,
					),
				).toBe(true);
				expect(await repo.getFlag(first.id)).toEqual({ ...first, ...resolved });
				// A state replaces the one before it: a reopened flag keeps nothing of its answer.
				expect(
					await repo.setFlagState(
						first.id,
						{ status: ["resolved"] },
						{ status: "open" },
					),
				).toBe(true);
				expect(await repo.getFlag(first.id)).toEqual(first);
				expect(await repo.countFlags({ proposalId })).toBe(0);
			} finally {
				await repo.close();
			}
		});

		it("matches any of several terms and returns alias keys with the index", async () => {
			const repo = open();
			try {
				const space: SynapseSpaceId = `shared-${randomUUID()}`;
				await repo.insertNote(
					note(space, "Ada", {
						searchText: "ada\nwrites programs",
						aliasKeys: ["countess of lovelace"],
					}),
				);
				await repo.insertNote(
					note(space, "Bob", { searchText: "bob\nprices things (a+b)" }),
				);
				await repo.insertNote(note(space, "Cy", { searchText: "cy\nidle" }));
				const sort = { by: "titleKey" as const, direction: "asc" as const };
				const titles = async (anyTerms: string[], terms?: string[]) =>
					(
						await repo.findNotes(
							{ space, anyTerms, ...(terms ? { terms } : {}) },
							{ sort, limit: 10 },
						)
					).map((item) => item.title);
				expect(await titles(["program", "pric"])).toEqual(["Ada", "Bob"]);
				// Terms are text, not patterns.
				expect(await titles(["(a+b)", "zzz"])).toEqual(["Bob"]);
				expect(await titles(["zzz"])).toEqual([]);
				expect(await titles([])).toEqual(["Ada", "Bob", "Cy"]);
				expect(await titles(["program", "pric"], ["bob"])).toEqual(["Bob"]);
				expect(
					await repo.countNotes({ space, anyTerms: ["idle", "ada"] }),
				).toBe(2);
				const index = await repo.scanNotes(space);
				expect(index.find((entry) => entry.title === "Ada")?.aliasKeys).toEqual(
					["countess of lovelace"],
				);
				expect(
					index.find((entry) => entry.title === "Bob")?.aliasKeys ?? [],
				).toEqual([]);
			} finally {
				await repo.close();
			}
		});

		it("keeps a note's past states by id and by the titles it had", async () => {
			const repo = open();
			try {
				const space: SynapseSpaceId = `shared-${randomUUID()}`;
				const other: SynapseSpaceId = `shared-${randomUUID()}`;
				const noteId = randomUUID();
				const state = (
					revision: number,
					title: string,
					extra: Partial<StoredRevision> = {},
				): StoredRevision => ({
					id: revisionId(extra.noteId ?? noteId, revision),
					noteId,
					space,
					title,
					titleKey: title.toLowerCase(),
					revision,
					change: revision === 1 ? "created" : "updated",
					at: `2026-11-08T10:00:0${revision}.000Z`,
					by: actor,
					properties: { n: revision },
					body: `body ${revision}`,
					...extra,
				});
				await repo.insertRevision(state(1, "Draft"));
				await repo.insertRevision(state(2, "Draft"));
				await repo.insertRevision(state(3, "Final"));
				// The same state again changes nothing.
				await repo.insertRevision(state(2, "Draft", { body: "rewritten" }));
				const later = randomUUID();
				await repo.insertRevision(
					state(1, "Draft", {
						noteId: later,
						at: "2026-11-09T00:00:00.000Z",
						body: "a later note with an old title",
					}),
				);
				await repo.insertRevision(
					state(1, "Draft", { noteId: randomUUID(), space: other }),
				);
				const revisions = async (
					by: { noteId: string } | { titleKey: string },
					limit = 10,
				) =>
					(await repo.listRevisions(space, by, limit)).map((item) => [
						item.revision,
						item.title,
						item.body,
					]);
				expect(await revisions({ noteId })).toEqual([
					[3, "Final", "body 3"],
					[2, "Draft", "body 2"],
					[1, "Draft", "body 1"],
				]);
				expect(await revisions({ noteId }, 2)).toHaveLength(2);
				// A title leads to the note that had it last.
				expect(await revisions({ titleKey: "final" })).toHaveLength(3);
				expect(await revisions({ titleKey: "draft" })).toEqual([
					[1, "Draft", "a later note with an old title"],
				]);
				expect(await revisions({ titleKey: "nothing" })).toEqual([]);
				expect(await revisions({ noteId: randomUUID() })).toEqual([]);
				expect(await repo.getRevision(noteId, 2)).toMatchObject({
					id: revisionId(noteId, 2),
					space,
					change: "updated",
					by: actor,
					properties: { n: 2 },
					body: "body 2",
				});
				expect(await repo.getRevision(noteId, 9)).toBeNull();
				expect(
					(
						await repo.revisionsSince(space, "2026-11-08T10:00:02.000Z", 10)
					).map((item) => [item.noteId === noteId, item.revision]),
				).toEqual([
					[false, 1],
					[true, 3],
				]);
				expect(
					await repo.revisionsSince(space, "2026-11-08T10:00:00.000Z", 1),
				).toHaveLength(1);
				await repo.pruneRevisions(noteId, 2);
				expect(await revisions({ noteId })).toEqual([[3, "Final", "body 3"]]);
				expect(await revisions({ titleKey: "draft" })).toHaveLength(1);
			} finally {
				await repo.close();
			}
		});

		it("leases a space's maintenance run and keeps its batch and dismissals", async () => {
			const repo = open();
			try {
				const space: SynapseSpaceId = `shared-${randomUUID()}`;
				const batch = (id: string, revision = 1): SynapseMaintenanceBatch => ({
					id,
					space,
					createdAt: "2026-11-08T10:00:00.000Z",
					revision,
					findings: [
						{
							id: "f1",
							kind: "duplicate",
							titles: ["A", "B"],
							summary: "Same.",
							fix: { action: "merge", from: "B", into: "A" },
							state: "open",
						},
					],
					digest: { since: null, changed: ["x"], needsYou: ["y"] },
				});
				const at = (minute: number) =>
					`2026-11-08T10:${String(minute).padStart(2, "0")}:00.000Z`;
				expect(await repo.getMaintenance(space)).toBeNull();
				// The first claim creates the record; a second waits for the lease.
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l1", until: at(5) },
						at(0),
						at(0),
					),
				).toBe(true);
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l2", until: at(6) },
						at(1),
						"9999",
					),
				).toBe(false);
				expect(await repo.getMaintenance(space)).toEqual({
					space,
					lastRunAt: null,
					batch: null,
					dismissed: [],
				});
				expect(
					await repo.finishMaintenance(space, "l2", batch("b0"), at(2)),
				).toBe(false);
				// An expired lease is taken over; the lost one cannot finish.
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l3", until: at(20) },
						at(6),
						"9999",
					),
				).toBe(true);
				expect(
					await repo.finishMaintenance(space, "l1", batch("b0"), at(7)),
				).toBe(false);
				expect(
					await repo.finishMaintenance(space, "l3", batch("b1"), at(8)),
				).toBe(true);
				expect(await repo.getMaintenance(space)).toEqual({
					space,
					lastRunAt: at(8),
					batch: batch("b1"),
					dismissed: [],
				});
				expect(
					(await repo.listMaintenanceRuns()).find((run) => run.space === space),
				).toEqual({ space, lastRunAt: at(8) });
				// Not due until its last run is older than `dueBefore`.
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l4", until: at(30) },
						at(9),
						at(8),
					),
				).toBe(false);
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l4", until: at(30) },
						at(9),
						at(9),
					),
				).toBe(true);
				// A failed run hands the space back at once.
				await repo.releaseMaintenance(space, "other");
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l5", until: at(31) },
						at(10),
						"9999",
					),
				).toBe(false);
				await repo.releaseMaintenance(space, "l4");
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l5", until: at(31) },
						at(10),
						"9999",
					),
				).toBe(true);
				await repo.releaseMaintenance(space, "l5");

				// A review replaces the batch only at the revision it read.
				const reviewed = { ...batch("b1", 2) };
				reviewed.findings[0].state = "dismissed";
				expect(await repo.reviewMaintenance(space, reviewed, 3, ["f1"])).toBe(
					false,
				);
				expect(
					await repo.reviewMaintenance(space, { ...reviewed, id: "b9" }, 1, [
						"f1",
					]),
				).toBe(false);
				expect(await repo.reviewMaintenance(space, reviewed, 1, ["f1"])).toBe(
					true,
				);
				expect(await repo.reviewMaintenance(space, reviewed, 1, ["f1"])).toBe(
					false,
				);
				expect(
					await repo.reviewMaintenance(space, { ...reviewed, revision: 3 }, 2, [
						"f1",
						"f2",
					]),
				).toBe(true);
				const record = await repo.getMaintenance(space);
				expect(record?.batch?.revision).toBe(3);
				expect(record?.batch?.findings[0].state).toBe("dismissed");
				expect(record?.dismissed.sort()).toEqual(["f1", "f2"]);
				// The next run keeps what was dismissed.
				expect(
					await repo.claimMaintenance(
						space,
						{ id: "l6", until: at(40) },
						at(11),
						"9999",
					),
				).toBe(true);
				expect(
					await repo.finishMaintenance(space, "l6", batch("b2"), at(12)),
				).toBe(true);
				expect((await repo.getMaintenance(space))?.dismissed.sort()).toEqual([
					"f1",
					"f2",
				]);
				expect(
					await repo.reviewMaintenance(
						`shared-${randomUUID()}`,
						batch("b2"),
						1,
						[],
					),
				).toBe(false);
			} finally {
				await repo.close();
			}
		});
	});
}

contract("memory repository", () => new MemorySynapseRepository());
describe.skipIf(!available)("mongodb", () => {
	contract("mongodb repository", () => new MongoSynapseRepository(mongoUrl));
	it("creates the documented indexes once and fails with 503 when MongoDB is down", async () => {
		const repo = new MongoSynapseRepository(mongoUrl);
		try {
			await repo.countNotes({ space: "shared" });
			const indexes = await cleanup.db().collection("synapse_notes").indexes();
			expect(indexes.map((index) => index.name).sort()).toEqual([
				"_id_",
				"space_categories",
				"space_links",
				"space_tags",
				"space_title",
				"space_updated",
			]);
			expect(
				indexes.find((index) => index.name === "space_title")?.unique,
			).toBe(true);
			expect(
				(await cleanup.db().collection("synapse_revisions").indexes())
					.map((index) => index.name)
					.sort(),
			).toEqual(["_id_", "note_revision", "space_at", "space_title_at"]);
			expect(
				(await cleanup.db().collection("synapse_flags").indexes())
					.map((index) => index.name)
					.sort(),
			).toEqual(["_id_", "author_status", "proposal", "space_status"]);
		} finally {
			await repo.close();
		}
		const down = new MongoSynapseRepository(
			"mongodb://127.0.0.1:1/unavailable",
		);
		try {
			await expect(down.countNotes({ space: "shared" })).rejects.toMatchObject({
				statusCode: 503,
			});
		} finally {
			await down.close();
		}
	}, 15_000);
});
