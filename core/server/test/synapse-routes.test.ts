import type { ApiTokenSecret } from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import {
	completeSetup,
	defaultWorkspaceId,
	inWorkspace,
	joinWithInvite,
} from "./auth-helpers.js";

type Call = (
	method: string,
	path: string,
	options?: {
		token?: string;
		body?: unknown;
		headers?: Record<string, string>;
	},
) => Promise<Response>;

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0)) await close();
});

/** A listening server with an owner, an admin, a member, and two API tokens. */
async function start() {
	const server = createServer({
		config: { providers: [], corsOrigins: ["*"], synapseTimeZone: "UTC" },
		logger: false,
	});
	cleanups.push(() => server.close());
	const origin = await server.listen({ port: 0, host: "127.0.0.1" });
	const owner = await completeSetup(server);
	// Token routes live under the default workspace; Synapse is gateway-wide.
	const workspaceId = await defaultWorkspaceId(server, owner.token);
	const admin = await joinWithInvite(
		server,
		owner.token,
		"admin@example.com",
		"admin",
	);
	const member = await joinWithInvite(
		server,
		owner.token,
		"member@example.com",
	);
	const call: Call = (
		method,
		path,
		{ token = owner.token, body, headers } = {},
	) =>
		fetch(`${origin}${inWorkspace(path, workspaceId)}`, {
			method,
			headers: {
				...(token ? { authorization: `Bearer ${token}` } : {}),
				...(body === undefined ? {} : { "content-type": "application/json" }),
				...headers,
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
	const apiToken = async (permissions: string[]) => {
		const response = await call("POST", "/v1/api-tokens", {
			body: {
				name: permissions.join(" ") || "none",
				description: "",
				ttlDays: 7,
				permissions,
			},
		});
		expect(response.status).toBe(201);
		return ((await response.json()) as ApiTokenSecret).secret;
	};
	return { server, origin, owner, admin, member, call, apiToken };
}

describe("Synapse REST routes", () => {
	it("manages notes with encoded titles and answers errors in the gateway shape", async () => {
		const { call } = await start();
		const spaces = await call("GET", "/v1/synapse/spaces");
		expect(spaces.status).toBe(200);
		expect(spaces.headers.get("cache-control")).toBe("no-store");
		expect(await spaces.json()).toEqual({
			spaces: [expect.objectContaining({ id: "shared", noteCount: 0 })],
			persistence: "memory",
			timeZone: "UTC",
		});
		const templates = await call("GET", "/v1/synapse/templates");
		expect(
			((await templates.json()) as { templates: unknown[] }).templates,
		).toHaveLength(13);

		const created = await call("POST", "/v1/synapse/spaces/shared/notes", {
			body: {
				title: "Ada & Charles / notes".replace(" / ", " — "),
				template: "People",
				body: "Worked with [[Charles Babbage]] on the [[Analytical Engine]]. #pioneers",
				properties: { role: "Mathematician", rating: 5 },
			},
		});
		expect(created.status).toBe(201);
		const note = (await created.json()) as {
			title: string;
			revision: number;
			createdBy: unknown;
		};
		expect(note).toMatchObject({
			title: "Ada & Charles — notes",
			revision: 1,
			createdBy: { kind: "user", name: "Founder" },
			categories: ["People"],
			tags: ["pioneers"],
		});
		const encoded = encodeURIComponent(note.title);
		const view = await call(
			"GET",
			`/v1/synapse/spaces/shared/notes/${encoded}`,
		);
		expect(view.status).toBe(200);
		const body = (await view.json()) as {
			note: { title: string };
			outgoing: unknown[];
			markdown: string;
		};
		expect(body.note.title).toBe(note.title);
		expect(body.outgoing).toEqual([
			{ title: "People", exists: true },
			{ title: "Charles Babbage", exists: false },
			{ title: "Analytical Engine", exists: false },
		]);
		expect(body.markdown).toContain("role: Mathematician");

		const duplicate = await call("POST", "/v1/synapse/spaces/shared/notes", {
			body: { title: "ADA & charles — NOTES" },
		});
		expect(duplicate.status).toBe(409);
		expect(await duplicate.json()).toEqual({
			error: { message: expect.stringMatching(/already exists/) },
		});
		const invalidSpace = await call("GET", "/v1/synapse/spaces/Shared/notes");
		expect(invalidSpace.status).toBe(400);
		expect(await invalidSpace.json()).toEqual({
			error: { message: expect.any(String) },
		});
		const invalidBody = await call("POST", "/v1/synapse/spaces/shared/notes", {
			body: { body: "no title" },
		});
		expect(invalidBody.status).toBe(400);
		expect(await invalidBody.json()).toEqual({
			error: { message: expect.stringMatching(/title/) },
		});
		const badTitle = await call("POST", "/v1/synapse/spaces/shared/notes", {
			body: { title: "a|b" },
		});
		expect(badTitle.status).toBe(400);

		const patched = await call(
			"PATCH",
			`/v1/synapse/spaces/shared/notes/${encoded}`,
			{
				body: { title: "Ada Lovelace", properties: { rating: 6 }, revision: 1 },
			},
		);
		expect(patched.status).toBe(200);
		expect(await patched.json()).toMatchObject({
			title: "Ada Lovelace",
			revision: 2,
			properties: expect.objectContaining({ rating: 6, role: "Mathematician" }),
		});
		const stale = await call(
			"PATCH",
			"/v1/synapse/spaces/shared/notes/Ada%20Lovelace",
			{
				body: { body: "x", revision: 1 },
			},
		);
		expect(stale.status).toBe(409);

		const appendedNew = await call(
			"POST",
			"/v1/synapse/spaces/shared/notes/Charles%20Babbage/append",
			{ body: { text: "Inventor.", template: "People" } },
		);
		expect(appendedNew.status).toBe(201);
		const appended = await call(
			"POST",
			"/v1/synapse/spaces/shared/notes/Charles%20Babbage/append",
			{ body: { text: "Friend of [[Ada Lovelace]]." } },
		);
		expect(appended.status).toBe(200);
		expect(((await appended.json()) as { body: string }).body).toBe(
			"Inventor.\nFriend of [[Ada Lovelace]].",
		);

		const query = await call(
			"GET",
			"/v1/synapse/spaces/shared/notes?text=engine&where.role=mathematician&limit=1",
		);
		expect(await query.json()).toEqual({
			total: 1,
			notes: [
				expect.objectContaining({
					title: "Ada Lovelace",
					snippet: expect.stringContaining("Engine"),
				}),
			],
		});
		const filtered = await call(
			"GET",
			"/v1/synapse/spaces/shared/notes?category=People&sort=title",
		);
		expect(
			(
				(await filtered.json()) as { notes: Array<{ title: string }> }
			).notes.map((n) => n.title),
		).toEqual(["Ada Lovelace", "Charles Babbage"]);
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/notes?limit=0")).status,
		).toBe(400);
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/notes?sort=random")).status,
		).toBe(400);

		const unresolved = await call(
			"GET",
			"/v1/synapse/spaces/shared/unresolved",
		);
		expect(await unresolved.json()).toEqual({
			links: [
				{ title: "Analytical Engine", count: 1, sources: ["Ada Lovelace"] },
			],
		});
		const categories = await call(
			"GET",
			"/v1/synapse/spaces/shared/categories",
		);
		expect(await categories.json()).toEqual({
			categories: [
				expect.objectContaining({ title: "People", count: 2, exists: true }),
			],
		});
		const today = new Date().toISOString().slice(0, 10);
		const daily = await call("GET", `/v1/synapse/spaces/shared/daily/${today}`);
		expect(await daily.json()).toMatchObject({
			date: today,
			note: null,
			entries: expect.arrayContaining([
				expect.objectContaining({ title: "Ada Lovelace" }),
			]),
		});
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/daily/today")).status,
		).toBe(400);
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/daily/2026-02-30")).status,
		).toBe(400);

		// Unknown agent space IDs are empty spaces; bad IDs are 400.
		expect(
			await (await call("GET", "/v1/synapse/spaces/agent-nobody/notes")).json(),
		).toEqual({
			notes: [],
			total: 0,
		});
		expect(
			(await call("GET", "/v1/synapse/spaces/agent-no%20body/notes")).status,
		).toBe(400);

		const current = (await (
			await call("GET", "/v1/synapse/spaces/shared/notes/Charles%20Babbage")
		).json()) as { note: { revision: number } };
		const staleDelete = await call(
			"DELETE",
			`/v1/synapse/spaces/shared/notes/Charles%20Babbage?revision=${current.note.revision + 1}`,
		);
		expect(staleDelete.status).toBe(409);
		expect(
			(
				await call(
					"DELETE",
					"/v1/synapse/spaces/shared/notes/Charles%20Babbage?revision=0",
				)
			).status,
		).toBe(400);
		const removed = await call(
			"DELETE",
			`/v1/synapse/spaces/shared/notes/Charles%20Babbage?revision=${current.note.revision}`,
		);
		expect(removed.status).toBe(204);
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/notes/Charles%20Babbage"))
				.status,
		).toBe(404);
		expect(
			(
				(await (
					await call("GET", "/v1/synapse/spaces/shared/unresolved")
				).json()) as { links: Array<{ title: string }> }
			).links.map((l) => l.title),
		).toEqual(["Analytical Engine", "Charles Babbage"]);
	});

	it("exports JSON and a zip, imports files, and caps the import body", async () => {
		const { call } = await start();
		await call("POST", "/v1/synapse/spaces/shared/notes", {
			body: { title: "Zürich office", template: "Places", body: "Office." },
		});
		const exported = await call("GET", "/v1/synapse/spaces/shared/export");
		expect(exported.status).toBe(200);
		const files = (await exported.json()) as {
			space: string;
			files: Array<{ path: string; content: string }>;
		};
		expect(files.space).toBe("shared");
		expect(files.files.map((f) => f.path)).toEqual(
			expect.arrayContaining([
				"References/Zürich office.md",
				"Categories/Places.md",
				"Templates/Places Template.md",
			]),
		);
		const zip = await call(
			"GET",
			"/v1/synapse/spaces/shared/export?format=zip",
		);
		expect(zip.status).toBe(200);
		expect(zip.headers.get("content-type")).toBe("application/zip");
		expect(zip.headers.get("content-disposition")).toBe(
			'attachment; filename="shared.zip"',
		);
		const bytes = new Uint8Array(await zip.arrayBuffer());
		expect([...bytes.slice(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
		const text = new TextDecoder().decode(bytes);
		for (const name of [
			"References/Zürich office.md",
			"Categories/Places.md",
			"Templates/Daily Template.md",
		])
			expect(text).toContain(name);
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/export?format=tar")).status,
		).toBe(400);

		const imported = await call("POST", "/v1/synapse/spaces/agent-abc/import", {
			body: {
				files: [
					...files.files,
					{ path: "Loose.md", content: "---\ntags: [x]\n---\nLoose body" },
					{ path: ".obsidian/workspace.json", content: "{}" },
				],
			},
		});
		expect(imported.status).toBe(200);
		const result = (await imported.json()) as {
			created: string[];
			updated: string[];
			skipped: Array<{ path: string }>;
		};
		expect(result.created.sort()).toEqual(["Loose", "Places", "Zürich office"]);
		expect(result.skipped.map((s) => s.path)).toEqual([
			...files.files
				.filter((f) => f.path.startsWith("Templates/"))
				.map((f) => f.path),
			".obsidian/workspace.json",
		]);
		expect(
			(
				(await (await call("GET", "/v1/synapse/spaces")).json()) as {
					spaces: Array<{ id: string; noteCount: number }>;
				}
			).spaces,
		).toEqual([
			expect.objectContaining({ id: "shared", noteCount: 2 }),
			expect.objectContaining({
				id: "agent-abc",
				name: "agent-abc",
				agentTokenId: "abc",
				noteCount: 3,
			}),
		]);
		const tooMany = await call("POST", "/v1/synapse/spaces/shared/import", {
			body: {
				files: Array.from({ length: 501 }, (_, i) => ({
					path: `${i}.md`,
					content: "",
				})),
			},
		});
		expect(tooMany.status).toBe(400);
		const huge = await call("POST", "/v1/synapse/spaces/shared/import", {
			body: {
				files: [
					{ path: "Huge.md", content: "x".repeat(5 * 1024 * 1024 + 1024) },
				],
			},
		});
		expect(huge.status).toBe(413);
		expect(await huge.json()).toEqual({
			error: { message: expect.any(String) },
		});
	}, 20_000);

	it("restricts proposal decisions to signed-in owners and admins", async () => {
		const { call, member, admin, apiToken } = await start();
		const id = "00000000-0000-0000-0000-000000000000";
		const decide = (token: string) =>
			call("POST", `/v1/synapse/proposals/${id}/decide`, {
				token,
				body: { decision: "approve" },
			});
		const asMember = await decide(member.token);
		expect(asMember.status).toBe(403);
		expect(await asMember.json()).toEqual({
			error: { message: expect.stringMatching(/owners and admins/) },
		});
		expect((await decide(await apiToken(["synapse:edit"]))).status).toBe(403);
		expect((await decide(admin.token)).status).toBe(404);
		const asOwner = await call("POST", `/v1/synapse/proposals/${id}/decide`, {
			body: { decision: "approve" },
		});
		expect(asOwner.status).toBe(404);
		expect(
			(
				await call("POST", `/v1/synapse/proposals/${id}/decide`, {
					body: { decision: "maybe" },
				})
			).status,
		).toBe(400);
		expect(
			(
				await call("POST", "/v1/synapse/proposals/not-a-uuid/decide", {
					body: { decision: "approve" },
				})
			).status,
		).toBe(400);
		const list = await call("GET", "/v1/synapse/proposals?status=pending", {
			token: member.token,
		});
		expect(await list.json()).toEqual({ proposals: [] });
		expect(
			(await call("GET", "/v1/synapse/proposals?status=maybe")).status,
		).toBe(400);
	});

	it("applies API token permissions: read for GETs, edit for writes and export, never decide", async () => {
		const { call, apiToken } = await start();
		const reader = await apiToken(["synapse:read"]);
		const editor = await apiToken(["synapse:edit"]);
		const other = await apiToken([
			"models:edit",
			"routing:edit",
			"inference:run",
			"telemetry:read",
		]);
		const none = await apiToken([]);
		const forbidden = async (response: Response) => {
			expect(response.status).toBe(403);
			expect(await response.json()).toEqual({
				error: { message: expect.stringMatching(/Synapse/) },
			});
		};
		for (const token of [other, none]) {
			await forbidden(await call("GET", "/v1/synapse/spaces", { token }));
			await forbidden(await call("GET", "/v1/synapse/proposals", { token }));
			await forbidden(
				await call("POST", "/v1/synapse/spaces/shared/notes", {
					token,
					body: { title: "x" },
				}),
			);
		}
		expect(
			(await call("GET", "/v1/synapse/spaces", { token: reader })).status,
		).toBe(200);
		expect(
			(await call("GET", "/v1/synapse/templates", { token: reader })).status,
		).toBe(200);
		expect(
			(await call("GET", "/v1/synapse/spaces/shared/notes", { token: reader }))
				.status,
		).toBe(200);
		expect(
			(
				await call("GET", "/v1/synapse/spaces/shared/categories", {
					token: reader,
				})
			).status,
		).toBe(200);
		expect(
			(await call("GET", "/v1/synapse/proposals", { token: reader })).status,
		).toBe(200);
		await forbidden(
			await call("GET", "/v1/synapse/spaces/shared/export", { token: reader }),
		);
		await forbidden(
			await call("POST", "/v1/synapse/spaces/shared/notes", {
				token: reader,
				body: { title: "x" },
			}),
		);
		await forbidden(
			await call("PATCH", "/v1/synapse/spaces/shared/notes/x", {
				token: reader,
				body: { body: "y" },
			}),
		);
		await forbidden(
			await call("DELETE", "/v1/synapse/spaces/shared/notes/x", {
				token: reader,
			}),
		);
		await forbidden(
			await call("POST", "/v1/synapse/spaces/shared/notes/x/append", {
				token: reader,
				body: { text: "y" },
			}),
		);
		await forbidden(
			await call("POST", "/v1/synapse/spaces/shared/import", {
				token: reader,
				body: { files: [] },
			}),
		);

		const created = await call("POST", "/v1/synapse/spaces/shared/notes", {
			token: editor,
			body: { title: "By token" },
		});
		expect(created.status).toBe(201);
		expect(await created.json()).toMatchObject({
			createdBy: { kind: "api-token", name: "synapse:edit" },
		});
		expect(
			(
				await call("GET", "/v1/synapse/spaces/shared/notes/By%20token", {
					token: editor,
				})
			).status,
		).toBe(200);
		expect(
			(
				await call("GET", "/v1/synapse/spaces/shared/export?format=zip", {
					token: editor,
				})
			).status,
		).toBe(200);
		expect(
			(
				await call("POST", "/v1/synapse/spaces/shared/import", {
					token: editor,
					body: { files: [] },
				})
			).status,
		).toBe(200);
		expect(
			(
				await call("DELETE", "/v1/synapse/spaces/shared/notes/By%20token", {
					token: editor,
				})
			).status,
		).toBe(204);
		const decide = await call(
			"POST",
			"/v1/synapse/proposals/00000000-0000-0000-0000-000000000000/decide",
			{ token: editor, body: { decision: "approve" } },
		);
		expect(decide.status).toBe(403);
		// Agent tokens never reach /v1.
		const agent = await call("POST", "/v1/agent-tokens", {
			body: {
				name: "Agent",
				description: "",
				ttlDays: 7,
				permissions: ["mcp:read", "mcp:call"],
			},
		});
		const secret = ((await agent.json()) as ApiTokenSecret).secret;
		expect(
			(await call("GET", "/v1/synapse/spaces", { token: secret })).status,
		).toBe(401);
		expect(
			(await call("GET", "/v1/synapse/spaces", { token: "" })).status,
		).toBe(401);
	});
});
