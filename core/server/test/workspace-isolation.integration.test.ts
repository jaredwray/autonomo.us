import { MongoClient } from "mongodb";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProviderConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import {
	bearer,
	completeSetup,
	defaultWorkspaceId,
	PASSWORD,
	signIn,
} from "./auth-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";
import { startOpenAIStub } from "./openai-stub.js";

const available = await mongoAvailable();
if (!available)
	console.warn(
		"⚠️  MongoDB is not reachable: skipping the workspace isolation suite. Run `docker compose up -d mongo`.",
	);

type Server = ReturnType<typeof createServer>;
const messages = [{ role: "user", content: "Hello" }];
const RANDOM_WORKSPACE = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";

/**
 * The isolation matrix from the workspaces plan (section 12), against a real
 * MongoDB and three real OpenAI-compatible servers: one per workspace and one
 * behind an environment provider. Workspaces A and B each hold a connection
 * named `shared` that points at a different server.
 */
describe.skipIf(!available)("workspace isolation", () => {
	let url: string;
	let client: MongoClient;
	let server: Server;
	let owner: string;
	let defaultId: string;
	let a: string;
	let b: string;
	const hits = { a: 0, b: 0, env: 0 };
	const closers: Array<() => Promise<unknown>> = [];

	const inject = (
		method: string,
		path: string,
		token: string,
		payload?: unknown,
	) =>
		server.inject({
			method: method as "GET",
			url: path,
			headers: bearer(token),
			...(payload === undefined ? {} : { payload: payload as object }),
		});
	const connection = async (workspace: string, config: ProviderConfig) => {
		// Connections pointing at a custom base URL can only be configured
		// server-side, so the suite writes them the way the store does.
		await client
			.db()
			.collection<{ _id: string }>("gateway_providers")
			.insertOne({
				_id: `${workspace}:${config.name}`,
				workspaceId: workspace,
				config,
			});
	};
	const member = async (
		email: string,
		workspace?: { workspaceId: string; role: "admin" | "member" },
	) => {
		const created = await inject("POST", "/v1/team", owner, {
			email,
			name: email.split("@")[0],
			role: "member",
			password: PASSWORD,
			...(workspace ? { workspace } : {}),
		});
		expect(created.statusCode, created.body).toBe(201);
		return (await signIn(server, email)).token;
	};

	beforeEach(async () => {
		hits.a = hits.b = hits.env = 0;
		const stubA = await startOpenAIStub({ onRequest: () => hits.a++ });
		const stubB = await startOpenAIStub({ onRequest: () => hits.b++ });
		const stubEnv = await startOpenAIStub({ onRequest: () => hits.env++ });
		closers.push(stubA.close, stubB.close, stubEnv.close);
		url = uniqueMongoUrl("ws");
		client = new MongoClient(url);
		closers.push(async () => {
			await client.db().dropDatabase();
			await client.close();
		});
		server = createServer({
			config: {
				corsOrigins: ["*"],
				mongodbUrl: url,
				providers: [
					{
						name: "envstub",
						kind: "openai-compatible",
						baseURL: stubEnv.url,
						models: ["chat-model"],
					},
				],
			},
			logger: false,
		});
		closers.push(() => server.close());
		owner = (await completeSetup(server)).token;
		defaultId = await defaultWorkspaceId(server, owner);
		const create = async (name: string) => {
			const created = await inject("POST", "/v1/workspaces", owner, { name });
			expect(created.statusCode, created.body).toBe(201);
			return created.json().id as string;
		};
		a = await create("Alpha");
		b = await create("Beta");
		for (const [workspace, stub] of [
			[a, stubA],
			[b, stubB],
		] as const)
			await connection(workspace, {
				name: "shared",
				kind: "openai-compatible",
				baseURL: stub.url,
				models: ["chat-model"],
			});
		await connection(b, {
			name: "onlyb",
			kind: "openai-compatible",
			baseURL: stubB.url,
			models: ["chat-model"],
		});
	});
	afterEach(async () => {
		for (const close of closers.splice(0).reverse()) await close();
	});
	afterAll(() => {});

	it("serves each workspace only from its own connections", async () => {
		const chatA = await inject("POST", `/v1/${a}/chat`, owner, {
			model: "shared/chat-model",
			messages,
		});
		expect(chatA.statusCode, chatA.body).toBe(200);
		expect(hits).toEqual({ a: 1, b: 0, env: 0 });
		const chatB = await inject("POST", `/v1/${b}/chat`, owner, {
			model: "shared/chat-model",
			messages,
		});
		expect(chatB.statusCode, chatB.body).toBe(200);
		expect(hits).toEqual({ a: 1, b: 1, env: 0 });

		const ids = async (workspace: string) =>
			(await inject("GET", `/v1/${workspace}/models`, owner))
				.json()
				.models.map((model: { id: string }) => model.id)
				.sort();
		expect(await ids(a)).toEqual(["shared/chat-model"]);
		expect(await ids(b)).toEqual(["onlyb/chat-model", "shared/chat-model"]);
		// Environment providers belong to the default workspace only.
		expect(await ids(defaultId)).toEqual(["envstub/chat-model"]);
		const envFromA = await inject("POST", `/v1/${a}/chat`, owner, {
			model: "envstub/chat-model",
			messages,
		});
		expect(envFromA.statusCode).toBe(404);
		expect(hits.env).toBe(0);
	});

	it("binds API tokens to their workspace, including by-id operations", async () => {
		const mint = async (workspace: string) => {
			const created = await inject(
				"POST",
				`/v1/${workspace}/api-tokens`,
				owner,
				{
					name: "Client",
					description: "",
					ttlDays: 1,
					permissions: ["inference:run", "models:read"],
				},
			);
			expect(created.statusCode, created.body).toBe(201);
			expect(created.json().token.workspaceId).toBe(workspace);
			return created.json() as { token: { id: string }; secret: string };
		};
		const tokenA = await mint(a);
		const tokenB = await mint(b);
		const ok = await inject("POST", `/v1/${a}/chat`, tokenA.secret, {
			model: "shared/chat-model",
			messages,
		});
		expect(ok.statusCode, ok.body).toBe(200);
		const crossed = await inject("POST", `/v1/${b}/chat`, tokenA.secret, {
			model: "shared/chat-model",
			messages,
		});
		expect(crossed.statusCode).toBe(403);
		expect(crossed.json().error.message).toBe(
			"This token belongs to another workspace.",
		);
		expect(hits.b).toBe(0);
		// Tokens cannot list or manage workspaces or tokens.
		expect(
			(await inject("GET", "/v1/workspaces", tokenA.secret)).statusCode,
		).toBe(403);
		// A's path never reaches B's token, even naming its id.
		for (const [method, suffix, payload] of [
			["PATCH", "", { name: "Taken", description: "" }],
			["POST", "/roll", { ttlDays: 1, previousTokenTtlSeconds: 0 }],
			["DELETE", "", undefined],
		] as const) {
			const response = await inject(
				method,
				`/v1/${a}/api-tokens/${tokenB.token.id}${suffix}`,
				owner,
				payload,
			);
			expect(response.statusCode, `${method} ${suffix}`).toBe(404);
		}
		const listedA = (await inject("GET", `/v1/${a}/api-tokens`, owner)).json();
		expect(listedA.tokens.map((token: { id: string }) => token.id)).toEqual([
			tokenA.token.id,
		]);
		// B's token is untouched and still works in B.
		expect(
			(
				await inject("POST", `/v1/${b}/chat`, tokenB.secret, {
					model: "shared/chat-model",
					messages,
				})
			).statusCode,
		).toBe(200);
	});

	it("resolves workspaces only from the path and hides inaccessible ones", async () => {
		const memberA = await member("member-a@example.com", {
			workspaceId: a,
			role: "member",
		});
		expect((await inject("GET", `/v1/${a}/models`, memberA)).statusCode).toBe(
			200,
		);
		const hidden = await inject("GET", `/v1/${b}/models`, memberA);
		const unknown = await inject(
			"GET",
			`/v1/${RANDOM_WORKSPACE}/models`,
			memberA,
		);
		// No access and no workspace look the same: no oracle for ids.
		expect(hidden.statusCode).toBe(404);
		expect(unknown.statusCode).toBe(404);
		expect(hidden.json()).toEqual(unknown.json());
		expect(
			(await inject("GET", "/v1/not-a-uuid/models", owner)).statusCode,
		).toBe(404);
		// The pre-workspace paths are gone.
		expect((await inject("GET", "/v1/models", owner)).statusCode).toBe(404);
		expect((await inject("POST", "/v1/chat", owner, {})).statusCode).toBe(404);
		// The session lists only accessible workspaces.
		const session = (await inject("GET", "/v1/auth/session", memberA)).json();
		expect(
			session.workspaces.map((workspace: { id: string }) => workspace.id),
		).toEqual([a]);
		const listed = (await inject("GET", "/v1/workspaces", memberA)).json();
		expect(listed.canCreate).toBe(false);
		expect(listed.workspaces).toHaveLength(1);
	});

	it("enforces the workspace role matrix", async () => {
		const memberA = await member("member@example.com", {
			workspaceId: a,
			role: "member",
		});
		const adminA = await member("admin@example.com", {
			workspaceId: a,
			role: "admin",
		});
		const add = (token: string) =>
			inject("POST", `/v1/${a}/models`, token, {
				provider: "openai",
				connectionId: "work",
				model: "gpt-test",
				apiKey: "test-key",
			});
		// D4: members read connections, workspace admins change them.
		expect((await add(memberA)).statusCode).toBe(403);
		expect((await add(adminA)).statusCode).toBe(200);
		expect(
			(await inject("GET", `/v1/${a}/providers`, memberA)).statusCode,
		).toBe(200);
		// Members may edit routing, as org Members could before workspaces.
		const routing = (await inject("GET", `/v1/${a}/routing`, memberA)).json();
		expect(
			(await inject("PUT", `/v1/${a}/routing`, memberA, routing.config))
				.statusCode,
		).toBe(200);
		// D3: tokens stay with org owners and admins.
		for (const token of [memberA, adminA])
			expect(
				(await inject("GET", `/v1/${a}/api-tokens`, token)).statusCode,
			).toBe(403);
		// Workspace admins rename and manage members of their own workspace only.
		expect(
			(
				await inject("PATCH", `/v1/workspaces/${a}`, adminA, {
					name: "Alpha Prime",
					description: "",
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await inject("PATCH", `/v1/workspaces/${b}`, adminA, {
					name: "Taken",
					description: "",
				})
			).statusCode,
		).toBe(404);
		expect((await inject("GET", `/v1/${b}/members`, adminA)).statusCode).toBe(
			404,
		);
		expect((await inject("GET", `/v1/${a}/members`, memberA)).statusCode).toBe(
			403,
		);
		// Archiving is for org owners and admins.
		expect(
			(await inject("POST", `/v1/workspaces/${a}/archive`, adminA)).statusCode,
		).toBe(403);
		// A workspace admin grants access to an existing account.
		const outsider = await member("outsider@example.com");
		expect((await inject("GET", `/v1/${a}/models`, outsider)).statusCode).toBe(
			404,
		);
		const team = (await inject("GET", "/v1/team", owner)).json();
		const outsiderId = team.members.find(
			(item: { email: string }) => item.email === "outsider@example.com",
		).id;
		const granted = await inject(
			"PUT",
			`/v1/${a}/members/${outsiderId}`,
			adminA,
			{ role: "member" },
		);
		expect(granted.statusCode, granted.body).toBe(200);
		expect(granted.json().actions[0]).toMatchObject({
			action: "granted",
			userEmail: "outsider@example.com",
			after: "member",
		});
		expect((await inject("GET", `/v1/${a}/models`, outsider)).statusCode).toBe(
			200,
		);
		const removed = await inject(
			"DELETE",
			`/v1/${a}/members/${outsiderId}`,
			adminA,
		);
		expect(removed.statusCode).toBe(200);
		expect((await inject("GET", `/v1/${a}/models`, outsider)).statusCode).toBe(
			404,
		);
		// Owners and admins are implicit admins and cannot be managed per workspace.
		const ownerId = team.members.find(
			(item: { role: string }) => item.role === "owner",
		).id;
		expect(
			(
				await inject("PUT", `/v1/${a}/members/${ownerId}`, adminA, {
					role: "member",
				})
			).statusCode,
		).toBe(409);
	});

	it("keeps telemetry and routing targets inside the workspace", async () => {
		for (const workspace of [a, b])
			await inject("POST", `/v1/${workspace}/chat`, owner, {
				model: "shared/chat-model",
				messages,
			});
		await inject("POST", `/v1/${b}/chat`, owner, {
			model: "onlyb/chat-model",
			messages,
		});
		const events = (
			await inject("GET", `/v1/${a}/telemetry/events`, owner)
		).json().events;
		expect(events).toHaveLength(1);
		expect(events[0].workspaceId).toBe(a);
		const range = `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 60_000).toISOString()}`;
		const analytics = (
			await inject("GET", `/v1/${a}/telemetry/analytics?${range}`, owner)
		).json();
		expect(analytics.totals.requests).toBe(1);
		expect(analytics.options.providers).toEqual(["shared"]);
		expect(JSON.stringify(analytics)).not.toContain("onlyb");
		const summary = (
			await inject("GET", `/v1/${b}/telemetry/summary`, owner)
		).json();
		expect(summary.totalRequests).toBe(2);
		// A routing pool cannot name a model that exists only in another workspace.
		const config = (await inject("GET", `/v1/${a}/routing`, owner)).json()
			.config;
		const rejected = await inject("PUT", `/v1/${a}/routing`, owner, {
			...config,
			pools: [
				{
					id: "mixed",
					strategy: "weighted-round-robin",
					failover: false,
					members: [{ model: "onlyb/chat-model", weight: 1 }],
				},
			],
		});
		expect(rejected.statusCode).toBe(400);
		expect(rejected.json().message).toContain("onlyb/chat-model");
	});

	it("blocks every request to an archived workspace until it is unarchived", async () => {
		const token = (
			await inject("POST", `/v1/${b}/api-tokens`, owner, {
				name: "Client",
				description: "",
				ttlDays: 1,
				permissions: ["models:read"],
			})
		).json().secret as string;
		const archived = await inject("POST", `/v1/workspaces/${b}/archive`, owner);
		expect(archived.statusCode, archived.body).toBe(200);
		expect(archived.json().archivedAt).not.toBeNull();
		expect((await inject("GET", `/v1/${b}/models`, token)).statusCode).toBe(
			409,
		);
		expect((await inject("GET", `/v1/${b}/models`, owner)).statusCode).toBe(
			409,
		);
		// The default workspace cannot be archived.
		expect(
			(await inject("POST", `/v1/workspaces/${defaultId}/archive`, owner))
				.statusCode,
		).toBe(409);
		const restored = await inject(
			"POST",
			`/v1/workspaces/${b}/unarchive`,
			owner,
		);
		expect(restored.statusCode).toBe(200);
		expect((await inject("GET", `/v1/${b}/models`, token)).statusCode).toBe(
			200,
		);
		const history = (await inject("GET", `/v1/workspaces/${b}`, owner)).json()
			.actions;
		expect(history.map((action: { action: string }) => action.action)).toEqual([
			"unarchived",
			"archived",
			"created",
		]);
	});

	it("agrees on one default workspace across servers and sees each other's changes", async () => {
		const second = createServer({
			config: { corsOrigins: ["*"], mongodbUrl: url, providers: [] },
			logger: false,
		});
		closers.push(() => second.close());
		const session = (await signIn(second, "founder@example.com")).token;
		expect(await defaultWorkspaceId(second, session)).toBe(defaultId);
		const added = await inject("POST", `/v1/${a}/models`, owner, {
			provider: "google",
			connectionId: "gemini",
			model: "gemini-test",
			apiKey: "test-key",
		});
		expect(added.statusCode, added.body).toBe(200);
		// The second server serves the change on its next request, no restart.
		const models = await second.inject({
			url: `/v1/${a}/models`,
			headers: bearer(session),
		});
		expect(
			models.json().models.map((model: { id: string }) => model.id),
		).toContain("gemini/gemini-test");
	});
});

describe.skipIf(!available)("upgrading data saved before workspaces", () => {
	const closers: Array<() => Promise<unknown>> = [];
	afterEach(async () => {
		for (const close of closers.splice(0).reverse()) await close();
	});

	it("keeps pre-workspace connections, tokens, members, and routing in the default workspace", async () => {
		const url = uniqueMongoUrl("upgrade");
		const client = new MongoClient(url);
		closers.push(async () => {
			await client.db().dropDatabase();
			await client.close();
		});
		const db = client.db();
		// Shapes written by the gateway before workspaces existed.
		await db.collection<{ _id: string }>("gateway_providers").insertOne({
			_id: "legacy",
			config: {
				kind: "google",
				name: "legacy",
				apiKey: "legacy-key",
				models: ["old-model"],
			},
		});
		await db.collection<{ _id: string }>("gateway_routing").insertOne({
			_id: "default",
			config: {
				auto: {
					enabled: false,
					decisionModel: "",
					targets: [],
					fallbackTarget: "",
					timeoutMs: 10_000,
				},
				pools: [],
				failover: { enabled: false, targets: [], timeoutMs: 30_000 },
				rules: [],
			},
		});
		const server = createServer({
			config: { corsOrigins: ["*"], mongodbUrl: url, providers: [] },
			logger: false,
		});
		closers.push(() => server.close());
		const owner = (await completeSetup(server)).token;
		const defaultId = await defaultWorkspaceId(server, owner);
		const get = (path: string, token = owner) =>
			server.inject({ url: path, headers: bearer(token) });
		const send = (method: string, path: string, payload: object) =>
			server.inject({
				method: method as "POST",
				url: path,
				headers: bearer(owner),
				payload,
			});
		expect(
			(await get(`/v1/${defaultId}/models`))
				.json()
				.models.map((model: { id: string }) => model.id),
		).toEqual(["legacy/old-model"]);
		// Booting rewrote nothing: the legacy connection keeps its shape.
		expect(
			await db
				.collection<{ _id: string }>("gateway_providers")
				.findOne({ _id: "legacy" }),
		).not.toHaveProperty("workspaceId");

		// A token and a member from before workspaces carry no workspace fields.
		const token = (
			await send("POST", `/v1/${defaultId}/api-tokens`, {
				name: "Old client",
				description: "",
				ttlDays: 1,
				permissions: ["models:read"],
			})
		).json();
		await db
			.collection<{ _id: string }>("gateway_api_tokens")
			.updateOne({ _id: token.token.id }, { $unset: { workspaceId: "" } });
		expect(
			(await get(`/v1/${defaultId}/models`, token.secret)).statusCode,
		).toBe(200);
		expect(
			(await get(`/v1/${defaultId}/api-tokens`)).json().tokens[0].workspaceId,
		).toBe(defaultId);
		const added = await send("POST", "/v1/team", {
			email: "old@example.com",
			name: "Old",
			role: "member",
			password: PASSWORD,
		});
		await db
			.collection<{ _id: string }>("gateway_users")
			.updateOne({ _id: added.json().id }, { $unset: { workspaces: "" } });
		const oldMember = (await signIn(server, "old@example.com")).token;
		expect((await get(`/v1/${defaultId}/models`, oldMember)).statusCode).toBe(
			200,
		);

		// An invite created before workspaces still grants what a member had
		// then, the default workspace, when it is redeemed.
		const invite = (
			await send("POST", "/v1/team/invites", { role: "member", ttlDays: 1 })
		).json();
		await db
			.collection<{ _id: string }>("gateway_invites")
			.updateOne({ _id: invite.invite.id }, { $unset: { workspace: "" } });
		const joined = await server.inject({
			method: "POST",
			url: "/v1/invites/accept",
			payload: {
				token: invite.token,
				email: "invited@example.com",
				name: "Invited",
				password: PASSWORD,
			},
		});
		expect(joined.statusCode, joined.body).toBe(201);
		expect(joined.json().user.workspaces).toEqual([
			{ workspaceId: defaultId, role: "member" },
		]);
		expect(
			(await get(`/v1/${defaultId}/models`, joined.json().token)).statusCode,
		).toBe(200);

		// The first routing write after upgrade is not a false conflict.
		const config = (await get(`/v1/${defaultId}/routing`)).json().config;
		expect(
			(await send("PUT", `/v1/${defaultId}/routing`, config)).statusCode,
		).toBe(200);

		// An older replica's whole-document write drops workspaceId; the
		// connection still belongs to the default workspace, and a later
		// field-level update persists.
		await db.collection<{ _id: string }>("gateway_providers").replaceOne(
			{ _id: "legacy" },
			{
				config: {
					kind: "google",
					name: "legacy",
					apiKey: "legacy-key",
					models: ["old-model"],
				},
			},
		);
		const update = await send("POST", `/v1/${defaultId}/models`, {
			provider: "google",
			connectionId: "legacy",
			model: "new-model",
			apiKey: "rotated-key",
		});
		expect(update.statusCode, update.body).toBe(200);
		const saved = await db
			.collection<{
				_id: string;
				workspaceId?: string;
				config: ProviderConfig;
			}>("gateway_providers")
			.findOne({ _id: "legacy" });
		expect(saved?.workspaceId).toBe(defaultId);
		expect(saved?.config.models).toEqual(["old-model", "new-model"]);
		expect(saved?.config.apiKey).toBe("rotated-key");
	});
});
