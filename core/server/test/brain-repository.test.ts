import { randomUUID } from "node:crypto";
import type { BrainActor, BrainProposal } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { MemoryBrainRepository } from "../src/brain/memory-repository.js";
import { MongoBrainRepository } from "../src/brain/mongo-repository.js";
import type { BrainRepository, StoredNote } from "../src/brain/repository.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn("[brain-repository] no MongoDB — skipping the MongoDB half.");
const mongoUrl = uniqueMongoUrl("brain");
const cleanup = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 1500 });
afterAll(async () => {
	if (available) await cleanup.db().dropDatabase();
	await cleanup.close();
});

const actor: BrainActor = { kind: "user", id: "u", name: "U" };

function note(
	vault: "shared" | `agent-${string}`,
	title: string,
	extra: Partial<StoredNote> = {},
): StoredNote {
	const at = extra.createdAt ?? "2026-11-08T10:00:00.000Z";
	return {
		id: randomUUID(),
		vault,
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
function contract(name: string, open: () => BrainRepository) {
	describe(name, () => {
		it("claims titles uniquely per vault and compares revisions on replace and delete", async () => {
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
			const vault = `agent-${randomUUID()}` as const;
			try {
				await repo.insertNote(
					note(vault, "Alpha", {
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
					note(vault, "beta", {
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
					note(vault, "Gamma", {
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
					filter: Parameters<BrainRepository["findNotes"]>[0],
					options: Partial<Parameters<BrainRepository["findNotes"]>[1]> = {},
				) =>
					(
						await repo.findNotes(filter, {
							sort: { by: "titleKey", direction: "asc" },
							limit: 10,
							...options,
						})
					).map((item) => item.title);
				expect(await titles({ vault })).toEqual(["Alpha", "beta", "Gamma"]);
				expect(
					await titles(
						{ vault },
						{ sort: { by: "updatedAt", direction: "desc" } },
					),
				).toEqual(["Alpha", "beta", "Gamma"]);
				expect(
					await titles(
						{ vault },
						{ sort: { by: "createdAt", direction: "desc" } },
					),
				).toEqual(["Gamma", "beta", "Alpha"]);
				expect(await titles({ vault }, { limit: 1, offset: 1 })).toEqual([
					"beta",
				]);
				expect(await titles({ vault, titleKey: "beta" })).toEqual(["beta"]);
				expect(
					await titles({ vault, titleKeys: ["beta", "gamma", "nope"] }),
				).toEqual(["beta", "Gamma"]);
				expect(await titles({ vault, linkKey: "beta" })).toEqual([
					"Alpha",
					"Gamma",
				]);
				expect(await titles({ vault, linkKeys: ["people", "gamma"] })).toEqual([
					"Alpha",
					"beta",
				]);
				expect(await titles({ vault, categoryKey: "people" })).toEqual([
					"Alpha",
				]);
				expect(await titles({ vault, tagPrefix: "projects" })).toEqual([
					"Alpha",
					"beta",
				]);
				expect(await titles({ vault, tagPrefix: "projects/active" })).toEqual([
					"Alpha",
				]);
				expect(await titles({ vault, terms: ["quick", "fox"] })).toEqual([
					"Alpha",
					"beta",
				]);
				expect(await titles({ vault, terms: ["(brown)"] })).toEqual(["beta"]);
				expect(await titles({ vault, terms: ["quick", "slow"] })).toEqual([]);
				expect(
					await titles({ vault, where: [{ k: "status", v: "active" }] }),
				).toEqual(["Alpha"]);
				expect(
					await titles({
						vault,
						where: [
							{ k: "status", v: "active" },
							{ k: "n", v: "6" },
						],
					}),
				).toEqual(["Alpha"]);
				expect(
					await titles({
						vault,
						where: [
							{ k: "status", v: "active" },
							{ k: "n", v: "7" },
						],
					}),
				).toEqual([]);
				expect(await repo.countNotes({ vault })).toBe(3);
				expect(await repo.countNotes({ vault, terms: ["fox"] })).toBe(3);
				const scanned = await repo.scanNotes(vault);
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
				const stats = await repo.vaultStats();
				expect(stats.find((item) => item.vault === vault)).toEqual({
					vault,
					noteCount: 3,
					createdAt: "2026-11-01T00:00:00.000Z",
					updatedAt: "2026-11-03T00:00:00.000Z",
				});
			} finally {
				await repo.close();
			}
		});

		it("finds a day's notes", async () => {
			const repo = open();
			const vault = `agent-${randomUUID()}` as const;
			const range = {
				from: "2026-11-08T00:00:00.000Z",
				to: "2026-11-09T00:00:00.000Z",
			};
			try {
				await repo.insertNote(
					note(vault, "2026-11-08", { createdAt: "2026-11-09T01:00:00.000Z" }),
				);
				await repo.insertNote(
					note(vault, "2026-11-08 standup", {
						createdAt: "2026-11-09T01:00:00.000Z",
					}),
				);
				await repo.insertNote(
					note(vault, "Created", { createdAt: "2026-11-08T23:59:59.000Z" }),
				);
				await repo.insertNote(
					note(vault, "Edge", { createdAt: "2026-11-09T00:00:00.000Z" }),
				);
				await repo.insertNote(
					note(vault, "Dated", {
						createdAt: "2026-11-09T01:00:01.000Z",
						propertyKeys: [{ k: "published", v: "2026-11-08t09:00" }],
					}),
				);
				await repo.insertNote(
					note(vault, "Other property", {
						createdAt: "2026-11-09T01:00:00.000Z",
						propertyKeys: [{ k: "deadline", v: "2026-11-08" }],
					}),
				);
				await repo.insertNote(
					note(vault, "Linker", {
						createdAt: "2026-11-09T01:00:02.000Z",
						links: ["2026-11-08"],
						linkKeys: ["2026-11-08"],
					}),
				);
				const found = await repo.findDailyNotes(vault, "2026-11-08", range, 10);
				expect(found.map((item) => item.title)).toEqual([
					"Linker",
					"Dated",
					"2026-11-08 standup",
					"Created",
				]);
				expect(
					await repo.findDailyNotes(vault, "2026-11-08", range, 2),
				).toHaveLength(2);
			} finally {
				await repo.close();
			}
		});

		it("keeps vault records and proposals", async () => {
			const repo = open();
			const vault = `agent-${randomUUID()}` as const;
			try {
				await repo.upsertVaultRecord(
					vault,
					"2026-11-08T00:00:00.000Z",
					undefined,
					vault,
				);
				await repo.upsertVaultRecord(
					vault,
					"2026-11-08T01:00:00.000Z",
					"Agent A",
					vault,
				);
				await repo.upsertVaultRecord(
					vault,
					"2026-11-08T02:00:00.000Z",
					undefined,
					"ignored",
				);
				expect(
					(await repo.listVaultRecords()).find((record) => record.id === vault),
				).toEqual({
					id: vault,
					name: "Agent A",
					createdAt: "2026-11-08T00:00:00.000Z",
					updatedAt: "2026-11-08T02:00:00.000Z",
				});
				const author = randomUUID();
				const make = (title: string, createdAt: string): BrainProposal => ({
					id: randomUUID(),
					vault: "shared",
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
				expect(await repo.decideProposal(first.id, decision)).toBe(true);
				expect(await repo.decideProposal(first.id, decision)).toBe(false);
				expect(await repo.decideProposal(randomUUID(), decision)).toBe(false);
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
			} finally {
				await repo.close();
			}
		});
	});
}

contract("memory repository", () => new MemoryBrainRepository());
describe.skipIf(!available)("mongodb", () => {
	contract("mongodb repository", () => new MongoBrainRepository(mongoUrl));
	it("creates the documented indexes once and fails with 503 when MongoDB is down", async () => {
		const repo = new MongoBrainRepository(mongoUrl);
		try {
			await repo.countNotes({ vault: "shared" });
			const indexes = await cleanup.db().collection("brain_notes").indexes();
			expect(indexes.map((index) => index.name).sort()).toEqual([
				"_id_",
				"vault_categories",
				"vault_links",
				"vault_tags",
				"vault_title",
				"vault_updated",
			]);
			expect(
				indexes.find((index) => index.name === "vault_title")?.unique,
			).toBe(true);
		} finally {
			await repo.close();
		}
		const down = new MongoBrainRepository("mongodb://127.0.0.1:1/unavailable");
		try {
			await expect(down.countNotes({ vault: "shared" })).rejects.toMatchObject({
				statusCode: 503,
			});
		} finally {
			await down.close();
		}
	}, 15_000);
});
