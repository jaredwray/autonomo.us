import { randomUUID } from "node:crypto";
import type { SynapseActor, SynapseProposal } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { MemorySynapseRepository } from "../src/synapse/memory-repository.js";
import { MongoSynapseRepository } from "../src/synapse/mongo-repository.js";
import type {
	StoredNote,
	SynapseRepository,
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
	space: "shared" | `agent-${string}`,
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
