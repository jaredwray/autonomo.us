import { randomUUID } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import {
	mongoFailureDetails,
	type SynapseDiagnostic,
} from "../src/synapse/diagnostics.js";
import { MongoSynapseRepository } from "../src/synapse/mongo-repository.js";

const mock = vi.hoisted(() => ({
	ping: vi.fn(),
	notesIndexes: vi.fn(),
	proposalsIndexes: vi.fn(),
	read: vi.fn(),
	close: vi.fn(),
}));
vi.mock("mongodb", () => ({
	MongoClient: class {
		db() {
			return {
				command: mock.ping,
				collection: (name: string) => ({
					createIndexes:
						name === "synapse_notes"
							? mock.notesIndexes
							: mock.proposalsIndexes,
					findOne: (...args: unknown[]) => mock.read(name, ...args),
				}),
			};
		}
		close = mock.close;
		// Stores listen for the driver closing a client.
		once() {
			return this;
		}
	},
}));
beforeEach(() => {
	vi.resetAllMocks();
	mock.ping.mockResolvedValue({ ok: 1 });
	mock.notesIndexes.mockResolvedValue([]);
	mock.proposalsIndexes.mockResolvedValue([]);
	mock.read.mockResolvedValue(null);
});
const secret = "mongodb://user:credential@private.example/secret-database";
const failure = (code: string | number, name = "MongoServerError") =>
	Object.assign(new Error(`${secret} note body and title`), { name, code });
function fixture() {
	const logs: SynapseDiagnostic[] = [];
	const repo = new MongoSynapseRepository(
		`${secret}-${randomUUID()}`,
		(entry) => logs.push(entry),
	);
	return { repo, logs };
}
it.each([
	["connect", "ping", "ETIMEDOUT"],
	["indexes.notes", "notesIndexes", 85],
	["indexes.proposals", "proposalsIndexes", 13],
] as const)("identifies %s failures and permits initialization retry", async (stage, point, code) => {
	const { repo, logs } = fixture();
	mock[point].mockRejectedValueOnce(failure(code));
	await expect(
		repo.getNote("shared", "private-note-title"),
	).rejects.toMatchObject({
		statusCode: 503,
		message: "Synapse is unavailable. Check MongoDB and retry.",
	});
	expect(mock.read).not.toHaveBeenCalled();
	expect(
		logs.filter((entry) => entry.event === "synapse.storage_failed"),
	).toEqual([
		expect.objectContaining({
			operation: "initialize",
			stage,
			durationMs: expect.any(Number),
			errors: [{ errorType: "MongoServerError", code }],
		}),
	]);
	await expect(
		repo.getNote("shared", "private-note-title"),
	).resolves.toBeNull();
	expect(JSON.stringify(logs)).not.toMatch(
		/credential|private\.example|private-note-title|note body|secret-database/,
	);
	await repo.close();
});
it("logs query failures from repository callers including MCP without logging arguments", async () => {
	const { repo, logs } = fixture();
	await repo.getNote("shared", "private-note-title");
	mock.read.mockRejectedValueOnce(failure(50));
	await expect(repo.getProposal("private-proposal-id")).rejects.toMatchObject({
		statusCode: 503,
	});
	expect(logs.at(-1)).toMatchObject({
		event: "synapse.storage_failed",
		operation: "getProposal",
		stage: "operation",
		errors: [{ errorType: "MongoServerError", code: 50 }],
	});
	expect(JSON.stringify(logs)).not.toMatch(
		/credential|private-proposal-id|private-note-title/,
	);
	await repo.close();
});
it("checks all three collections using bounded projections without returning contents", async () => {
	const { repo } = fixture();
	await expect(repo.check()).resolves.toBeUndefined();
	for (const collection of [
		"synapse_notes",
		"synapse_spaces",
		"synapse_proposals",
	])
		expect(mock.read).toHaveBeenCalledWith(
			collection,
			{},
			{ projection: { _id: 1 }, maxTimeMS: 3000 },
		);
	await repo.close();
});
it("observes nested topology, DNS and TLS failures without hosts, messages or arbitrary strings", () => {
	const nested = failure("ENOTFOUND", "Error");
	const outer = Object.assign(failure(89, "MongoServerSelectionError"), {
		reason: {
			servers: new Map([["private.example:27017", { error: nested }]]),
		},
		cause: failure("ERR_TLS_CERT_ALTNAME_INVALID", "MongoNetworkError"),
	});
	Object.assign(nested, { cause: outer });
	expect(mongoFailureDetails(outer)).toEqual({
		errors: [
			{ errorType: "MongoServerSelectionError", code: 89 },
			{ errorType: "MongoNetworkError", code: "ERR_TLS_CERT_ALTNAME_INVALID" },
			{ errorType: "Error", code: "ENOTFOUND" },
		],
	});
	expect(
		mongoFailureDetails(failure("SECRETCREDENTIAL", "PrivateDatabase")),
	).toEqual({ errors: [{ errorType: "Error" }] });
	expect(mongoFailureDetails(secret)).toEqual({
		errors: [{ errorType: "UnknownError" }],
	});
	expect(JSON.stringify(mongoFailureDetails(outer))).not.toMatch(
		/credential|private\.example|note body/,
	);
});
it("a broken logger cannot fail successful storage operations", async () => {
	const repo = new MongoSynapseRepository(`${secret}-${randomUUID()}`, () => {
		throw new Error("log unavailable");
	});
	await expect(repo.getNote("shared", "title")).resolves.toBeNull();
	await repo.close();
});

it.each([
	"notes",
	"spaces",
	"proposals",
] as const)("identifies the failing %s health read and settles the other reads", async (name) => {
	const { repo, logs } = fixture();
	mock.read.mockImplementation(async (collection: string) => {
		if (collection === `synapse_${name}`) throw failure(13);
		return null;
	});
	await expect(repo.check()).rejects.toMatchObject({ statusCode: 503 });
	expect(mock.read).toHaveBeenCalledTimes(3);
	expect(
		logs.filter((entry) => entry.event === "synapse.storage_failed"),
	).toEqual([
		expect.objectContaining({
			operation: "check",
			stage: `read.${name}`,
			errors: [{ errorType: "MongoServerError", code: 13 }],
		}),
	]);
	await repo.close();
});
