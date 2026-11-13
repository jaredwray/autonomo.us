import { createHash, randomBytes } from "node:crypto";
import type {
	AgentConnectionList,
	OAuthSignInDecision,
} from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_COLLECTIONS } from "../src/gateway-data.js";
import {
	MongoOAuthRepository,
	OAUTH_CLIENTS_COLLECTION,
	OAUTH_GRANTS_COLLECTION,
	OAUTH_REQUESTS_COLLECTION,
	type StoredClient,
	type StoredGrant,
} from "../src/oauth/repository.js";
import { startChannels } from "./channel-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanups.splice(0).reverse()) await close();
});
const database = (prefix: string) => {
	const url = uniqueMongoUrl(prefix);
	const client = new MongoClient(url);
	cleanups.push(async () => {
		await client.db().dropDatabase();
		await client.close();
	});
	return { url, client };
};

describe.skipIf(!available)("OAuth sign-in with MongoDB", () => {
	it("keeps a sign-in across servers and clears it with the gateway's data", async () => {
		const { url, client } = database("oauth");
		const first = await startChannels(cleanups, { mongodbUrl: url });
		const second = await startChannels(cleanups, { mongodbUrl: url });
		const verifier = randomBytes(32).toString("base64url");
		const redirect = "https://app.example/callback";
		const registered = (await (
			await fetch(`${first.origin}/oauth/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ client_name: "App", redirect_uris: [redirect] }),
			})
		).json()) as { client_id: string };
		// The app is sent to one server and the dashboard talks to another.
		const started = await fetch(
			`${second.origin}/oauth/authorize?${new URLSearchParams({
				response_type: "code",
				client_id: registered.client_id,
				redirect_uri: redirect,
				code_challenge: createHash("sha256")
					.update(verifier)
					.digest("base64url"),
				code_challenge_method: "S256",
			})}`,
			{ redirect: "manual" },
		);
		const request = (started.headers.get("location") as string)
			.split("/")
			.pop();
		const decision = await first.ok<OAuthSignInDecision>(
			"POST",
			`/v1/oauth/sign-ins/${request}/approve`,
			{ body: { agent: { name: "App agent", description: "" } } },
		);
		const token = (body: Record<string, string>) =>
			fetch(`${second.origin}/oauth/token`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ client_id: registered.client_id, ...body }),
			});
		const code = new URL(decision.redirectTo).searchParams.get(
			"code",
		) as string;
		const exchange = () =>
			token({
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
			});
		// Two exchanges of one code at once: one app gets tokens, and the code
		// arriving twice ends what it started.
		const results = await Promise.all([exchange(), exchange()]);
		expect(results.map((result) => result.status).sort()).toEqual([200, 400]);
		const issued = (await results
			.find((result) => result.status === 200)
			?.json()) as { access_token: string; refresh_token: string };
		expect(issued.access_token).toMatch(/^oat_/);

		const again = await second.ok<OAuthSignInDecision>(
			"POST",
			`/v1/oauth/sign-ins/${
				(
					(
						await fetch(
							`${first.origin}/oauth/authorize?${new URLSearchParams({
								response_type: "code",
								client_id: registered.client_id,
								redirect_uri: redirect,
								code_challenge: createHash("sha256")
									.update(verifier)
									.digest("base64url"),
								code_challenge_method: "S256",
							})}`,
							{ redirect: "manual" },
						)
					).headers.get("location") as string
				)
					.split("/")
					.pop() as string
			}/approve`,
			{ body: { agent: { name: "Second agent", description: "" } } },
		);
		const tokens = (await (
			await token({
				grant_type: "authorization_code",
				code: new URL(again.redirectTo).searchParams.get("code") as string,
				code_verifier: verifier,
			})
		).json()) as { access_token: string; refresh_token: string };
		expect((await first.rpc(tokens.access_token, "ping")).result).toEqual({});
		// Two refreshes with one token at once: exactly one is answered.
		const refreshed = await Promise.all(
			[first, second].map(() =>
				token({
					grant_type: "refresh_token",
					refresh_token: tokens.refresh_token,
				}),
			),
		);
		expect(refreshed.map((result) => result.status).sort()).toEqual([200, 400]);

		// An approved registration is kept; MongoDB expires the rest by itself.
		const stored = await client
			.db()
			.collection(OAUTH_CLIENTS_COLLECTION)
			.findOne({});
		expect(stored).toMatchObject({ name: "App", expiresAt: null });
		expect(typeof stored?.approvedAt).toBe("string");
		for (const name of [
			OAUTH_CLIENTS_COLLECTION,
			OAUTH_REQUESTS_COLLECTION,
			OAUTH_GRANTS_COLLECTION,
		]) {
			expect(GATEWAY_COLLECTIONS).toContain(name);
			const indexes = await client.db().collection(name).indexes();
			expect(
				indexes.find((index) => index.key.expiresAt === 1)?.expireAfterSeconds,
			).toBe(0);
		}
		const agents = await client
			.db()
			.collection("gateway_agent_tokens")
			.find({})
			.toArray();
		expect(agents.map((agent) => agent.auth)).toEqual(["oauth", "oauth"]);
		expect(
			JSON.stringify(
				await client
					.db()
					.collection(OAUTH_GRANTS_COLLECTION)
					.find({})
					.toArray(),
			),
		).not.toContain(tokens.access_token);
		const second_agent = agents.find((agent) => agent.name === "Second agent");
		expect(
			(
				await first.ok<AgentConnectionList>(
					"GET",
					`/v1/agents/${second_agent?._id}/connections`,
				)
			).connections,
		).toHaveLength(1);
	});

	it("stores clients, requests, and grants under one contract", async () => {
		const { url } = database("oauthrepo");
		const repository = new MongoOAuthRepository(url);
		cleanups.push(() => repository.close());
		const now = new Date();
		const later = new Date(now.getTime() + 60_000);
		const client = (id: string, createdAt: string): StoredClient => ({
			id,
			name: id,
			uri: null,
			redirectUris: ["https://app.example/cb"],
			createdAt,
			approvedAt: null,
			expiresAt: later,
		});
		await repository.insertClient(client("old", "2026-01-01T00:00:00.000Z"));
		await repository.insertClient(client("new", "2026-01-02T00:00:00.000Z"));
		await repository.insertClient(client("kept", "2025-01-01T00:00:00.000Z"));
		await repository.approveClient("kept", "2026-02-01T00:00:00.000Z");
		await repository.approveClient("kept", "2026-03-01T00:00:00.000Z");
		expect(await repository.getClient("kept")).toMatchObject({
			approvedAt: "2026-02-01T00:00:00.000Z",
			expiresAt: null,
		});
		expect(await repository.countPendingClients(now)).toBe(2);
		expect(await repository.countPendingClients(later)).toBe(0);
		await repository.removeOldestPendingClient();
		expect(await repository.getClient("old")).toBeNull();
		expect(await repository.getClient("new")).not.toBeNull();
		expect(await repository.getClient("kept")).not.toBeNull();
		// An id is data, never a query.
		expect(
			await repository.getClient({ $ne: "" } as unknown as string),
		).toBeNull();

		const request = (id: string, clientId = "new") => ({
			id,
			clientId,
			redirectUri: "https://app.example/cb",
			state: null,
			codeChallenge: "c",
			createdAt: now.toISOString(),
			expiresAt: later,
		});
		expect(await repository.insertRequest(request("request"), 3, now)).toBe(
			true,
		);
		expect(await repository.getRequest("request")).toMatchObject({
			expiresAt: later,
			slot: 0,
		});
		// Ten sign-ins of one app arrive together: the limit of three holds.
		const together = await Promise.all(
			Array.from({ length: 10 }, (_, index) =>
				repository.insertRequest(request(`burst-${index}`), 3, now),
			),
		);
		expect(together.filter(Boolean)).toHaveLength(2);
		// Another app has places of its own, and expired sign-ins give theirs up.
		expect(
			await repository.insertRequest(request("other", "kept"), 3, now),
		).toBe(true);
		expect(await repository.insertRequest(request("full"), 3, now)).toBe(false);
		expect(
			await repository.insertRequest(request("second", "kept"), 1, now),
		).toBe(false);
		expect(
			await repository.insertRequest(
				{
					...request("after", "kept"),
					expiresAt: new Date(later.getTime() + 60_000),
				},
				1,
				later,
			),
		).toBe(true);
		expect(await repository.getRequest("other")).toBeNull();
		const taken = await Promise.all(
			Array.from({ length: 5 }, () => repository.takeRequest("request")),
		);
		expect(taken.filter(Boolean)).toHaveLength(1);

		const grant = (id: string, agentId: string): StoredGrant => ({
			id,
			workspaceId: "w",
			agentId,
			clientId: "new",
			clientName: "new",
			redirectUri: "https://app.example/cb",
			approvedBy: "Ada",
			createdAt: now.toISOString(),
			code: {
				hash: "h",
				expiresAt: later.toISOString(),
				challenge: "c",
				usedAt: null,
			},
			access: [],
			refresh: null,
			previousRefresh: null,
			refreshFamily: null,
			lastUsedAt: null,
			expiresAt: later,
			revision: 0,
		});
		await repository.insertGrant(grant("g1", "a"));
		await repository.insertGrant(grant("g2", "a"));
		await repository.insertGrant(grant("g3", "b"));
		const stored = (await repository.getGrant("g1")) as StoredGrant;
		expect(stored).toEqual(grant("g1", "a"));
		const swaps = await Promise.all(
			[1, 2, 3].map((n) =>
				repository.replaceGrant(
					{ ...stored, revision: 1, approvedBy: `writer ${n}` },
					0,
				),
			),
		);
		expect(swaps.filter(Boolean)).toHaveLength(1);
		expect(
			(await repository.listGrants("w")).map((item) => item.id).sort(),
		).toEqual(["g1", "g2", "g3"]);
		expect(await repository.listGrants("other")).toEqual([]);
		expect(await repository.removeGrant("g3")).toBe(true);
		expect(await repository.removeGrant("g3")).toBe(false);
		expect(await repository.removeGrants("w", "a")).toBe(2);
		expect(await repository.listGrants("w")).toEqual([]);
	});
});
