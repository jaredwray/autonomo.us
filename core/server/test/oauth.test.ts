import { createHash, randomBytes } from "node:crypto";
import type {
	AgentConnectionList,
	AgentList,
	AgentToken,
	AgentTokenSettings,
	OAuthSignIn,
	OAuthSignInDecision,
} from "@autonomo.us/common";
import { afterEach, describe, expect, it } from "vitest";
import { type OAuthAgents, OAuthService } from "../src/oauth/oauth.js";
import { MemoryOAuthRepository } from "../src/oauth/repository.js";
import { createServer } from "../src/server.js";
import { startChannels } from "./channel-helpers.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});

const REDIRECT = "http://127.0.0.1:7777/callback";
const pkce = () => {
	const verifier = randomBytes(32).toString("base64url");
	return {
		verifier,
		challenge: createHash("sha256").update(verifier).digest("base64url"),
	};
};
type Tokens = {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
	scope?: string;
};

/** A gateway plus an MCP app that follows the sign-in flow by hand. */
async function start(config: Parameters<typeof startChannels>[1] = {}) {
	const api = await startChannels(cleanups, config);
	const { origin } = api;
	const json = async (response: Response) => ({
		status: response.status,
		headers: response.headers,
		body: (await response.json().catch(() => null)) as Record<string, unknown>,
	});
	const register = (metadata: Record<string, unknown> = {}) =>
		fetch(`${origin}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				client_name: "Claude",
				redirect_uris: [REDIRECT],
				...metadata,
			}),
		}).then(json);
	const authorize = (params: Record<string, string>) =>
		fetch(`${origin}/oauth/authorize?${new URLSearchParams(params)}`, {
			redirect: "manual",
		});
	const form = (path: string, params: Record<string, string>) =>
		fetch(`${origin}${path}`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams(params),
		}).then(json);
	/** Registers an app and starts a sign-in; returns what the dashboard is sent. */
	const begin = async (extra: Record<string, string> = {}) => {
		const client = (await register()).body.client_id as string;
		const proof = pkce();
		const response = await authorize({
			response_type: "code",
			client_id: client,
			redirect_uri: REDIRECT,
			code_challenge: proof.challenge,
			code_challenge_method: "S256",
			state: "abc 123",
			resource: `${origin}/mcp`,
			...extra,
		});
		expect(response.status).toBe(302);
		const location = response.headers.get("location") as string;
		return {
			client,
			...proof,
			location,
			request: /#\/authorize\/([\w-]{43})$/.exec(location)?.[1] ?? "",
		};
	};
	const approve = async (
		request: string,
		body: unknown,
		token?: string,
	): Promise<URL> =>
		new URL(
			(
				await api.ok<OAuthSignInDecision>(
					"POST",
					`/v1/oauth/sign-ins/${request}/approve`,
					{ body, token },
				)
			).redirectTo,
		);
	const exchange = (
		started: { client: string; verifier: string },
		code: string,
		extra: Record<string, string> = {},
	) =>
		form("/oauth/token", {
			grant_type: "authorization_code",
			code,
			client_id: started.client,
			redirect_uri: REDIRECT,
			code_verifier: started.verifier,
			...extra,
		});
	/** The whole flow: a new agent, approved by the owner, and its tokens. */
	const connect = async (name = "Claude agent") => {
		const started = await begin();
		const back = await approve(started.request, {
			agent: {
				name,
				description: "",
				permissions: ["mcp:read", "mcp:call"],
			},
		});
		const tokens = await exchange(
			started,
			back.searchParams.get("code") as string,
		);
		expect(tokens.status).toBe(200);
		const agents = await api.ok<AgentList>("GET", "/v1/agents");
		const agent = agents.agents.find((item) => item.name === name);
		return {
			...started,
			tokens: tokens.body as unknown as Tokens,
			agentId: agent?.id as string,
		};
	};
	return {
		...api,
		json,
		register,
		authorize,
		form,
		begin,
		approve,
		exchange,
		connect,
	};
}

describe("OAuth sign-in to the MCP endpoint", () => {
	it("tells apps where to sign in", async () => {
		const { origin } = await start();
		const response = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe(
			`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:read mcp:call"`,
		);
		for (const path of [
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-protected-resource/mcp",
		])
			expect(await (await fetch(`${origin}${path}`)).json()).toMatchObject({
				resource: `${origin}/mcp`,
				authorization_servers: [origin],
				bearer_methods_supported: ["header"],
			});
		for (const path of [
			"/.well-known/oauth-authorization-server",
			"/.well-known/oauth-authorization-server/mcp",
		])
			expect(await (await fetch(`${origin}${path}`)).json()).toMatchObject({
				issuer: origin,
				authorization_endpoint: `${origin}/oauth/authorize`,
				token_endpoint: `${origin}/oauth/token`,
				registration_endpoint: `${origin}/oauth/register`,
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["none"],
			});
		// A token that is not one says so, and still points at the metadata.
		const wrong = await fetch(`${origin}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization: `Bearer oat_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}_${"a".repeat(43)}`,
			},
			body: "{}",
		});
		expect(wrong.status).toBe(401);
		expect(wrong.headers.get("www-authenticate")).toContain(
			'error="invalid_token"',
		);
	});

	it("names PUBLIC_URL and DASHBOARD_URL when they are set", async () => {
		const { origin, begin } = await start({
			publicUrl: "https://gateway.example.com",
			dashboardUrl: "https://dash.example.com",
		});
		expect(
			await (
				await fetch(`${origin}/.well-known/oauth-authorization-server`)
			).json(),
		).toMatchObject({
			issuer: "https://gateway.example.com",
			token_endpoint: "https://gateway.example.com/oauth/token",
		});
		const started = await begin({
			resource: "https://gateway.example.com/mcp",
		});
		expect(started.location).toMatch(
			/^https:\/\/dash\.example\.com\/#\/authorize\/[\w-]{43}$/,
		);
	});

	it("takes its address from the request when PUBLIC_URL is unset", async () => {
		const issuer = async (
			options: { assumeHttps?: boolean },
			headers: Record<string, string>,
		) => {
			const server = createServer({
				config: { providers: [], corsOrigins: [] },
				logger: false,
				...options,
			});
			cleanups.push(() => server.close());
			return (
				await server.inject({
					url: "/.well-known/oauth-authorization-server",
					headers,
				})
			).json().issuer as string;
		};
		const host = "gateway.example.com";
		// A proxy that ends TLS says so; a Worker's runtime does not.
		expect(await issuer({}, { host })).toBe(`http://${host}`);
		expect(await issuer({}, { host, "x-forwarded-proto": "https" })).toBe(
			`https://${host}`,
		);
		expect(await issuer({ assumeHttps: true }, { host })).toBe(
			`https://${host}`,
		);
		expect(
			await issuer({ assumeHttps: true }, { host: "localhost:8787" }),
		).toBe("http://localhost:8787");
		expect(await issuer({}, { host: "[::1]:3000" })).toBe("http://[::1]:3000");
		// A Host header that is not a host name is not repeated back.
		expect(await issuer({}, { host: 'evil"example.com' })).toBe(
			"http://localhost",
		);
	});

	it("registers public clients and refuses unsafe redirect addresses", async () => {
		const { register } = await start();
		const created = await register({
			client_uri: "https://claude.ai",
			token_endpoint_auth_method: "client_secret_post",
			redirect_uris: [
				"https://claude.ai/api/mcp/auth_callback",
				"http://localhost/callback",
				"cursor://anysphere.cursor-mcp/oauth/callback",
			],
		});
		expect(created.status).toBe(201);
		expect(created.headers.get("cache-control")).toBe("no-store");
		expect(created.body).toMatchObject({
			client_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
			client_name: "Claude",
			client_uri: "https://claude.ai/",
			token_endpoint_auth_method: "none",
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
		});
		expect(created.body).not.toHaveProperty("client_secret");
		for (const redirect_uris of [
			undefined,
			[],
			"https://one.example/cb",
			["javascript:alert(1)"],
			["data:text/html,hi"],
			["http://example.com/cb"],
			["https://example.com/cb#fragment"],
			["https://user:pass@example.com/cb"],
			["/relative"],
			["https://example.com/a b"],
			Array.from({ length: 11 }, (_, i) => `https://example.com/${i}`),
		]) {
			const refused = await register({ redirect_uris });
			expect(refused.status, JSON.stringify(redirect_uris)).toBe(400);
			expect(refused.body.error).toBe("invalid_redirect_uri");
		}
		const named = await register({ client_name: `  ${"x".repeat(300)}\n` });
		expect((named.body.client_name as string).length).toBe(100);
		expect((await register({ client_name: 7 })).body.client_name).toBe(
			"MCP app",
		);
	});

	it("shows a problem with the app to the person and any other to the app", async () => {
		const { register, authorize, begin, approve } = await start();
		const client = (await register()).body.client_id as string;
		const base = {
			response_type: "code",
			client_id: client,
			redirect_uri: REDIRECT,
			code_challenge: pkce().challenge,
			code_challenge_method: "S256",
			state: "s",
		};
		for (const params of [
			{ ...base, client_id: "nobody" },
			{ ...base, client_id: "00000000-0000-4000-8000-000000000000" },
			{ ...base, redirect_uri: "https://evil.example/callback" },
			{ ...base, redirect_uri: "http://127.0.0.1:7777/other" },
		]) {
			const response = await authorize(params);
			expect(response.status).toBe(400);
			expect(response.headers.get("content-type")).toContain("text/plain");
			expect(response.headers.get("location")).toBeNull();
		}
		const refusals: Array<[Record<string, string>, string]> = [
			[{ ...base, response_type: "token" }, "unsupported_response_type"],
			[{ ...base, code_challenge: "" }, "invalid_request"],
			[{ ...base, code_challenge_method: "plain" }, "invalid_request"],
			[{ ...base, resource: "https://other.example/mcp" }, "invalid_target"],
		];
		// Nobody has approved this app yet, so the gateway sends no browser to
		// the address it registered, not even to report a mistake.
		for (const [params] of refusals) {
			const response = await authorize(params);
			expect(response.status).toBe(400);
			expect(response.headers.get("location")).toBeNull();
		}
		const known = await begin();
		await approve(known.request, {
			agent: { name: "Known", description: "" },
		});
		for (const [params, error] of refusals) {
			const response = await authorize({ ...params, client_id: known.client });
			expect(response.status).toBe(302);
			const back = new URL(response.headers.get("location") as string);
			expect(back.origin + back.pathname).toBe(REDIRECT);
			expect(back.searchParams.get("error")).toBe(error);
			expect(back.searchParams.get("state")).toBe("s");
		}
		// One app can keep only so many sign-ins waiting.
		for (let index = 0; index < 20; index++)
			expect((await authorize(base)).status).toBe(302);
		const full = await authorize(base);
		expect(full.status).toBe(400);
		expect(await full.text()).toMatch(/Too many sign-ins/);
		// An app on this computer may listen on another port than it registered.
		const moved = await begin({
			redirect_uri: "http://127.0.0.1:50123/callback",
		});
		expect(moved.request).toHaveLength(43);
	});

	it("signs an app in to a new agent that a workspace admin approves", async () => {
		const { origin, ok, refused, begin, approve, exchange, form, rpc, join } =
			await start();
		const member = await join("member@example.com");
		const admin = await join("wsadmin@example.com");
		await ok("PUT", `/v1/members/${admin.user.id}`, {
			body: { role: "admin" },
		});
		const started = await begin();
		expect(started.location).toBe(`${origin}/#/authorize/${started.request}`);

		// Anyone signed in may look; only a person may, and nobody else.
		const shown = await ok<OAuthSignIn>(
			"GET",
			`/v1/oauth/sign-ins/${started.request}`,
			{ token: member.token },
		);
		expect(shown).toMatchObject({
			id: started.request,
			clientName: "Claude",
			redirectUri: REDIRECT,
			redirectHost: "127.0.0.1:7777",
			knownClient: false,
		});
		expect(
			(
				await refused("GET", `/v1/oauth/sign-ins/${started.request}`, {
					token: "",
				})
			).status,
		).toBe(401);
		expect(
			(await refused("GET", `/v1/oauth/sign-ins/${"x".repeat(43)}`)).status,
		).toBe(410);

		const agent = { name: "Claude agent", description: "From Claude" };
		// A member may not approve; a workspace admin may.
		expect(
			(
				await refused("POST", `/v1/oauth/sign-ins/${started.request}/approve`, {
					token: member.token,
					body: { agent },
				})
			).status,
		).toBe(403);
		for (const body of [
			{},
			{ agentId: "nope" },
			{ agent: { name: "", description: "" } },
			{ agent: { ...agent, permissions: ["synapse:edit"] } },
			{ agent, agentId: "00000000-0000-4000-8000-000000000000" },
		])
			expect(
				(
					await refused(
						"POST",
						`/v1/oauth/sign-ins/${started.request}/approve`,
						{
							body,
						},
					)
				).status,
			).toBe(400);
		const back = await approve(
			started.request,
			{ agent: { ...agent, permissions: ["mcp:read", "mcp:call"] } },
			admin.token,
		);
		expect(back.origin + back.pathname).toBe(REDIRECT);
		expect(back.searchParams.get("state")).toBe("abc 123");
		const code = back.searchParams.get("code") as string;
		expect(code).toMatch(/^oac_/);
		// The decision is made once.
		expect(
			(
				await refused("POST", `/v1/oauth/sign-ins/${started.request}/approve`, {
					body: { agent },
				})
			).status,
		).toBe(410);

		// The code needs the app's own proof, client, and redirect address.
		expect(
			(await exchange({ ...started, verifier: pkce().verifier }, code)).body,
		).toMatchObject({ error: "invalid_grant" });
		expect(
			(await exchange({ ...started, client: "someone-else" }, code)).status,
		).toBe(400);
		expect(
			(await exchange(started, code, { redirect_uri: "http://127.0.0.1:1/x" }))
				.status,
		).toBe(400);
		expect(
			(await exchange(started, code, { resource: "https://other.example/mcp" }))
				.body.error,
		).toBe("invalid_target");
		expect(
			(await form("/oauth/token", { grant_type: "password" })).body.error,
		).toBe("unsupported_grant_type");
		const issued = await exchange(started, code, { resource: `${origin}/mcp` });
		expect(issued.status).toBe(200);
		expect(issued.headers.get("cache-control")).toBe("no-store");
		const tokens = issued.body as unknown as Tokens;
		expect(tokens).toMatchObject({
			access_token: expect.stringMatching(/^oat_/),
			refresh_token: expect.stringMatching(/^ort_/),
			token_type: "Bearer",
			expires_in: 3600,
			scope: "mcp:read mcp:call",
		});

		// The access token is the agent, in the workspace that approved it.
		const tools = (await rpc(tokens.access_token, "tools/list")).result as {
			tools: unknown[];
		};
		expect(tools.tools.length).toBeGreaterThan(5);
		// A refresh token is not an access token.
		expect((await rpc(tokens.refresh_token, "ping")).result).toBeUndefined();
		const settings = await ok<AgentTokenSettings>("GET", "/v1/agent-tokens", {
			token: admin.token,
		});
		expect(settings.tokens).toMatchObject([
			{
				name: "Claude agent",
				auth: "oauth",
				status: "active",
				prefix: "",
				permissions: ["mcp:read", "mcp:call"],
			},
		]);
		expect(settings.actions.map((action) => action.action)).toEqual([
			"connected",
			"created",
		]);
		expect(settings.actions[0]).toMatchObject({
			actorName: "wsadmin",
			detail: "Claude signed in at 127.0.0.1:7777.",
		});
		const id = settings.tokens[0].id;
		expect(
			(await ok<AgentConnectionList>("GET", `/v1/agents/${id}/connections`))
				.connections,
		).toMatchObject([
			{
				agentId: id,
				clientName: "Claude",
				redirectHost: "127.0.0.1:7777",
				approvedBy: "wsadmin",
			},
		]);
		// Grants change with the agent, not with the token.
		await ok("PATCH", `/v1/agent-tokens/${id}`, {
			body: { ...agent, permissions: ["mcp:read"] },
		});
		expect(
			(await rpc(tokens.access_token, "tools/call", { name: "channels_list" }))
				.error?.code,
		).toBe(-32001);
		expect(
			(
				await refused("POST", `/v1/agent-tokens/${id}/roll`, {
					body: { ttlDays: 7, previousTokenTtlSeconds: 0 },
				})
			).status,
		).toBe(409);
	});

	it("uses a code once and ends the connection when it comes back", async () => {
		const { begin, approve, exchange, rpc } = await start();
		const started = await begin();
		const back = await approve(started.request, {
			agent: { name: "Once", description: "", permissions: ["mcp:read"] },
		});
		const code = back.searchParams.get("code") as string;
		const first = await exchange(started, code);
		expect(first.status).toBe(200);
		const access = first.body.access_token as string;
		expect((await rpc(access, "ping")).result).toEqual({});
		expect((await exchange(started, code)).body.error).toBe("invalid_grant");
		expect((await rpc(access, "ping")).result).toBeUndefined();
	});

	it("lets a person refuse, and sends the app the refusal", async () => {
		const { ok, refused, begin, join } = await start();
		const member = await join("member@example.com");
		const started = await begin();
		const denied = await ok<OAuthSignInDecision>(
			"POST",
			`/v1/oauth/sign-ins/${started.request}/deny`,
			{ token: member.token },
		);
		const back = new URL(denied.redirectTo);
		expect(back.origin + back.pathname).toBe(REDIRECT);
		expect(back.searchParams.get("error")).toBe("access_denied");
		expect(back.searchParams.get("state")).toBe("abc 123");
		expect(back.searchParams.get("code")).toBeNull();
		expect(
			(await refused("GET", `/v1/oauth/sign-ins/${started.request}`)).status,
		).toBe(410);
	});

	it("signs apps in to an existing OAuth agent, up to a limit, and lists it with the others", async () => {
		const { ok, refused, begin, approve, exchange, agent, rpc } = await start();
		const created = await ok<AgentToken>(
			"POST",
			"/v1/agents/oauth",
			{
				body: {
					name: "Shared agent",
					description: "Two apps",
					permissions: ["mcp:read", "mcp:call", "channels:manage"],
				},
			},
			201,
		);
		expect(created).toMatchObject({
			auth: "oauth",
			status: "active",
			ttlDays: "never",
			expiresAt: null,
		});
		const withToken = await agent("Token agent");
		await ok(
			"POST",
			"/v1/bots",
			{ body: { name: "Helper", instructions: "", model: "stub/model" } },
			201,
		);

		// Only an agent that signs in with OAuth can be chosen.
		const first = await begin();
		for (const agentId of [
			withToken.id,
			"00000000-0000-4000-8000-000000000000",
		])
			expect(
				(
					await refused("POST", `/v1/oauth/sign-ins/${first.request}/approve`, {
						body: { agentId },
					})
				).status,
			).toBeGreaterThanOrEqual(404);
		const tokens: string[] = [];
		for (const started of [first, await begin()]) {
			const back = await approve(started.request, { agentId: created.id });
			const issued = await exchange(
				started,
				back.searchParams.get("code") as string,
			);
			expect(issued.body.scope).toBe("mcp:read mcp:call channels:manage");
			tokens.push(issued.body.access_token as string);
		}
		const listed = await ok<AgentList>("GET", "/v1/agents");
		expect(
			listed.agents.map(({ name, kind, status, connections, model }) => ({
				name,
				kind,
				status,
				connections,
				model,
			})),
		).toEqual([
			{
				name: "Helper",
				kind: "instructions",
				status: "active",
				connections: 0,
				model: "stub/model",
			},
			{
				name: "Shared agent",
				kind: "oauth",
				status: "active",
				connections: 2,
				model: null,
			},
			{
				name: "Token agent",
				kind: "token",
				status: "active",
				connections: 0,
				model: null,
			},
		]);

		// One app is disconnected; the other keeps working.
		const { connections } = await ok<AgentConnectionList>(
			"GET",
			`/v1/agents/${created.id}/connections`,
		);
		expect(connections).toHaveLength(2);
		expect(
			(await refused("GET", `/v1/agents/${withToken.id}/connections`)).status,
		).toBe(409);
		await ok(
			"DELETE",
			`/v1/agents/${created.id}/connections/${connections[0].id}`,
			{},
			204,
		);
		expect(
			(
				await refused(
					"DELETE",
					`/v1/agents/${created.id}/connections/${connections[0].id}`,
				)
			).status,
		).toBe(404);
		// The newest connection is listed first: that was the second app.
		expect((await rpc(tokens[1], "ping")).result).toBeUndefined();
		expect((await rpc(tokens[0], "ping")).result).toEqual({});

		// Revoking the agent signs every app out and refuses new sign-ins.
		await ok("DELETE", `/v1/agent-tokens/${created.id}`);
		expect((await rpc(tokens[0], "ping")).result).toBeUndefined();
		const late = await begin();
		expect(
			(
				await refused("POST", `/v1/oauth/sign-ins/${late.request}/approve`, {
					body: { agentId: created.id },
				})
			).status,
		).toBe(409);
		const history = (
			await ok<AgentTokenSettings>("GET", "/v1/agent-tokens")
		).actions
			.filter((action) => action.tokenId === created.id)
			.map((action) => action.action);
		expect(history).toEqual([
			"revoked",
			"disconnected",
			"connected",
			"connected",
			"created",
		]);
	});

	it("replaces the refresh token on every use and lets the app sign out", async () => {
		const { connect, form, rpc, ok } = await start();
		const { client, tokens, agentId } = await connect();
		const refresh = (token: string, client_id = client) =>
			form("/oauth/token", {
				grant_type: "refresh_token",
				refresh_token: token,
				client_id,
			});
		expect((await refresh(tokens.refresh_token, "other")).body.error).toBe(
			"invalid_grant",
		);
		const renewed = await refresh(tokens.refresh_token);
		expect(renewed.status).toBe(200);
		const next = renewed.body as unknown as Tokens;
		expect(next.refresh_token).not.toBe(tokens.refresh_token);
		expect(next.access_token).not.toBe(tokens.access_token);
		// A request already on its way with the earlier access token still works.
		expect((await rpc(tokens.access_token, "ping")).result).toEqual({});
		expect((await rpc(next.access_token, "ping")).result).toEqual({});
		// The replaced refresh token is refused; so soon after, it is a retry.
		expect((await refresh(tokens.refresh_token)).body.error).toBe(
			"invalid_grant",
		);
		expect((await rpc(next.access_token, "ping")).result).toEqual({});

		// Signing out hands a token back; unknown tokens are not an error.
		expect((await form("/oauth/revoke", { token: "not-a-token" })).status).toBe(
			200,
		);
		expect(
			(await form("/oauth/revoke", { token: next.refresh_token })).status,
		).toBe(200);
		expect((await rpc(next.access_token, "ping")).result).toBeUndefined();
		expect((await refresh(next.refresh_token)).body.error).toBe(
			"invalid_grant",
		);
		expect(
			(
				await ok<AgentConnectionList>(
					"GET",
					`/v1/agents/${agentId}/connections`,
				)
			).connections,
		).toEqual([]);
	});

	it("gives workspace admins every kind of agent and keeps API tokens with the org", async () => {
		const { ok, refused, join, apiToken } = await start();
		const admin = await join("wsadmin@example.com");
		const member = await join("member@example.com");
		await ok("PUT", `/v1/members/${admin.user.id}`, {
			body: { role: "admin" },
		});
		const token = { name: "Agent", description: "", ttlDays: 7 };
		const made = await ok<{ token: AgentToken; secret: string }>(
			"POST",
			"/v1/agent-tokens",
			{ token: admin.token, body: token },
			201,
		);
		expect(made.token.auth).toBe("token");
		await ok(
			"POST",
			"/v1/agents/oauth",
			{ token: admin.token, body: { name: "OAuth", description: "" } },
			201,
		);
		await ok(
			"POST",
			"/v1/bots",
			{ token: admin.token, body: { name: "Bot", model: "stub/model" } },
			201,
		);
		expect(
			(
				await refused("POST", "/v1/api-tokens", {
					token: admin.token,
					body: token,
				})
			).status,
		).toBe(403);
		// Members see who the agents are and nothing about their credentials.
		expect(
			(await ok<AgentList>("GET", "/v1/agents", { token: member.token }))
				.agents,
		).toHaveLength(3);
		for (const [method, path, body] of [
			["GET", "/v1/agent-tokens", undefined],
			["POST", "/v1/agent-tokens", token],
			["POST", "/v1/agents/oauth", { name: "X", description: "" }],
			["GET", `/v1/agents/${made.token.id}/connections`, undefined],
			["DELETE", `/v1/agent-tokens/${made.token.id}`, undefined],
		] as const)
			expect(
				(await refused(method, path, { token: member.token, body })).status,
			).toBe(403);
		// No token of either kind reaches these routes.
		const api = await apiToken(["channels:edit", "synapse:edit"]);
		for (const path of ["/v1/agents", "/v1/agent-tokens"])
			expect((await refused("GET", path, { token: api })).status).toBe(403);
		expect(
			(await refused("GET", "/v1/agents", { token: made.secret })).status,
		).toBe(401);
	});
});

describe("OAuth sign-in over time", () => {
	const setup = () => {
		let now = Date.parse("2026-01-01T00:00:00Z");
		const history: string[] = [];
		let permissions: string[] | null = ["mcp:read"];
		const agents: OAuthAgents = {
			permissions: async () => permissions,
			record: async (_w, _a, action, detail) => {
				history.push(`${action}: ${detail}`);
			},
		};
		const repository = new MemoryOAuthRepository(() => now);
		const oauth = new OAuthService(repository, agents, () => now);
		const origin = "https://gateway.example.com";
		const target = { workspaceId: "w", agentId: "a" };
		const begin = async () => {
			const client = (await oauth.register({ redirect_uris: [REDIRECT] }))
				.client_id;
			const proof = pkce();
			const result = await oauth.authorize(
				{
					response_type: "code",
					client_id: client,
					redirect_uri: REDIRECT,
					code_challenge: proof.challenge,
					code_challenge_method: "S256",
				},
				origin,
			);
			if (!("request" in result)) throw new Error("not started");
			return { client, ...proof, request: result.request };
		};
		const connect = async () => {
			const started = await begin();
			const back = new URL(await oauth.approve(started.request, target, "Ada"));
			const tokens = await oauth.token(
				{
					grant_type: "authorization_code",
					code: back.searchParams.get("code"),
					client_id: started.client,
					code_verifier: started.verifier,
				},
				origin,
			);
			return { ...started, tokens };
		};
		return {
			oauth,
			repository,
			origin,
			target,
			history,
			begin,
			connect,
			advance: (ms: number) => {
				now += ms;
			},
			revokeAgent: () => {
				permissions = null;
			},
		};
	};
	const MINUTE = 60_000;
	const DAY = 86_400_000;
	const refused = async (run: Promise<unknown>, error: string) =>
		expect(await run.catch((cause: unknown) => cause)).toMatchObject({
			error,
		});

	it("expires sign-ins, codes, access tokens, and idle connections", async () => {
		const { oauth, origin, target, begin, connect, advance } = setup();
		const waiting = await begin();
		advance(16 * MINUTE);
		await expect(oauth.signIn(waiting.request)).rejects.toMatchObject({
			statusCode: 410,
		});
		await expect(
			oauth.approve(waiting.request, target, "Ada"),
		).rejects.toMatchObject({ statusCode: 410 });

		const slow = await begin();
		const back = new URL(await oauth.approve(slow.request, target, "Ada"));
		advance(3 * MINUTE);
		await refused(
			oauth.token(
				{
					grant_type: "authorization_code",
					code: back.searchParams.get("code"),
					client_id: slow.client,
					code_verifier: slow.verifier,
				},
				origin,
			),
			"invalid_grant",
		);
		// A code that was never exchanged is not a connection.
		expect(await oauth.connections("w")).toEqual([]);

		const { client, tokens } = await connect();
		expect(await oauth.authenticate(tokens.access_token)).toMatchObject(target);
		advance(61 * MINUTE);
		expect(await oauth.authenticate(tokens.access_token)).toBeNull();
		const renewed = await oauth.token(
			{
				grant_type: "refresh_token",
				refresh_token: tokens.refresh_token,
				client_id: client,
			},
			origin,
		);
		expect(await oauth.authenticate(renewed.access_token)).toMatchObject(
			target,
		);
		expect((await oauth.connections("w", "a"))[0].lastUsedAt).toBe(
			"2026-01-01T01:20:00.000Z",
		);
		advance(31 * DAY);
		await refused(
			oauth.token(
				{
					grant_type: "refresh_token",
					refresh_token: renewed.refresh_token,
					client_id: client,
				},
				origin,
			),
			"invalid_grant",
		);
		expect(await oauth.connections("w")).toEqual([]);
	});

	it("ends a connection when a replaced refresh token is used later", async () => {
		const { oauth, origin, history, connect, advance } = setup();
		const { client, tokens } = await connect();
		const refresh = (refresh_token: string) =>
			oauth.token(
				{ grant_type: "refresh_token", refresh_token, client_id: client },
				origin,
			);
		const renewed = await refresh(tokens.refresh_token);
		advance(2 * MINUTE);
		await refused(refresh(tokens.refresh_token), "invalid_grant");
		expect(await oauth.authenticate(renewed.access_token)).toBeNull();
		await refused(refresh(renewed.refresh_token), "invalid_grant");
		expect(history).toEqual([
			"connected: MCP app signed in at 127.0.0.1:7777.",
			"disconnected: MCP app disconnected. A replaced refresh token was used again.",
		]);
	});

	it("refuses to renew for an agent that is gone", async () => {
		const { oauth, origin, connect, revokeAgent } = setup();
		const { client, tokens } = await connect();
		revokeAgent();
		await refused(
			oauth.token(
				{
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token,
					client_id: client,
				},
				origin,
			),
			"invalid_grant",
		);
		expect(await oauth.authenticate(tokens.access_token)).toBeNull();
	});

	it("keeps a cap on registrations nobody approved and on apps per agent", async () => {
		const { oauth, repository, target, begin, connect, advance } = setup();
		const first = await begin();
		const approved = await connect();
		for (let index = 0; index < 1000; index++)
			await oauth.register({ redirect_uris: [REDIRECT] });
		expect(await repository.countPendingClients(new Date(0))).toBe(1000);
		// The oldest unapproved registration made room; the approved one stays.
		expect(await repository.getClient(first.client)).toBeNull();
		expect(await repository.getClient(approved.client)).not.toBeNull();
		advance(8 * DAY);
		const late = await oauth.authorize(
			{ client_id: (await begin()).client, response_type: "code" },
			"https://gateway.example.com",
		);
		expect(late).toHaveProperty("page");
		expect(
			await repository.countPendingClients(
				new Date(Date.parse("2026-01-09T00:00:01Z")),
			),
		).toBe(1);

		for (let index = 0; index < 9; index++) await connect();
		const extra = await begin();
		await expect(
			oauth.approvable(extra.request, target.workspaceId, target.agentId),
		).rejects.toMatchObject({ statusCode: 409 });
	});
});
