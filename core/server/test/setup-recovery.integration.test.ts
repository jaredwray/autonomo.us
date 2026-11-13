import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { GATEWAY_COLLECTIONS } from "../src/gateway-data.js";
import {
	authServer,
	bearer,
	completeSetup,
	defaultWorkspaceId,
	PASSWORD,
	signIn,
} from "./auth-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn(
		"MongoDB unavailable; skipping setup recovery integration tests.",
	);
const urls: string[] = [];
afterAll(async () => {
	for (const url of urls) {
		const client = new MongoClient(url, { serverSelectionTimeoutMS: 1500 });
		await client
			.db()
			.dropDatabase()
			.catch(() => {});
		await client.close();
	}
});

const NEW_PASSWORD = "a brand new passphrase";

describe.skipIf(!available)(
	"setup with a setup token on a set-up gateway",
	() => {
		it("recovers an account keeping the data, spends the token, then clears everything for a new token", async () => {
			const url = uniqueMongoUrl("setup");
			urls.push(url);
			const servers: Array<{ close(): Promise<unknown> }> = [];
			const start = (setupToken?: string) => {
				const server = authServer({ mongodbUrl: url, setupToken });
				servers.push(server);
				return server;
			};
			const client = new MongoClient(url);
			try {
				// A gateway set up without a token, with data in it.
				const original = start();
				const founder = await completeSetup(original);
				const workspaceId = await defaultWorkspaceId(original, founder.token);
				const apiToken = await original.inject({
					method: "POST",
					url: `/v1/${workspaceId}/api-tokens`,
					headers: bearer(founder.token),
					payload: { name: "Client", description: "", ttlDays: 30 },
				});
				expect(apiToken.statusCode).toBe(201);
				const apiSecret = apiToken.json().secret as string;
				const created = await original.inject({
					method: "POST",
					url: "/v1/workspaces",
					headers: bearer(founder.token),
					payload: { name: "Research" },
				});
				expect(created.statusCode).toBe(201);
				const db = client.db();
				await db
					.collection("synapse_notes")
					.insertOne({ title: "A note" } as never);
				// Another application's data in the same database.
				await db.collection("other_app").insertOne({ keep: true });

				// The operator sets SETUP_TOKEN: setup reopens, data stays usable.
				const recovering = start("recover-one");
				expect((await recovering.inject("/v1/auth/status")).json()).toEqual({
					setupComplete: false,
					setupTokenRequired: true,
					persistence: "mongodb",
				});
				expect((await recovering.inject("/v1/setup/token")).statusCode).toBe(
					401,
				);
				const check = await recovering.inject({
					url: "/v1/setup/token",
					headers: bearer("recover-one"),
				});
				expect(check.statusCode).toBe(200);
				expect(check.json()).toEqual({
					existing: {
						accounts: 1,
						invites: 0,
						connections: 0,
						tokens: 1,
						workspaces: 1,
						notes: 1,
						messages: 0,
						usageEvents: 0,
					},
					canClear: true,
				});
				expect(
					(
						await recovering.inject({
							url: `/v1/${workspaceId}/models`,
							headers: bearer(apiSecret),
						})
					).statusCode,
				).toBe(200);

				// Keep the data and take back the founder account.
				const kept = await recovering.inject({
					method: "POST",
					url: "/v1/setup",
					headers: bearer("recover-one"),
					payload: {
						email: "founder@example.com",
						name: "Founder",
						password: NEW_PASSWORD,
						data: "keep",
					},
				});
				expect(kept.statusCode).toBe(201);
				expect(kept.json().user).toMatchObject({
					id: founder.user.id,
					role: "owner",
				});
				expect(
					(
						await recovering.inject({
							url: "/v1/auth/session",
							headers: bearer(founder.token),
						})
					).statusCode,
				).toBe(401);
				await signIn(recovering, "founder@example.com", NEW_PASSWORD);
				const listed = await recovering.inject({
					url: "/v1/workspaces",
					headers: bearer(kept.json().token),
				});
				expect(listed.json().workspaces).toHaveLength(2);

				// Spent: the same token opens nothing, here or after a restart.
				for (const server of [recovering, start("recover-one")]) {
					expect((await server.inject("/v1/auth/status")).json()).toMatchObject(
						{ setupComplete: true, setupTokenRequired: false },
					);
					expect(
						(
							await server.inject({
								url: "/v1/setup/token",
								headers: bearer("recover-one"),
							})
						).statusCode,
					).toBe(409);
				}

				// A new token, and this time start fresh.
				const fresh = start("recover-two");
				const cleared = await fresh.inject({
					method: "POST",
					url: "/v1/setup",
					headers: bearer("recover-two"),
					payload: {
						email: "fresh@example.com",
						name: "Fresh",
						password: PASSWORD,
						data: "clear",
					},
				});
				expect(cleared.statusCode).toBe(201);
				const session = cleared.json().token as string;
				const workspaces = (
					await fresh.inject({
						url: "/v1/workspaces",
						headers: bearer(session),
					})
				).json().workspaces as Array<{ id: string; isDefault: boolean }>;
				expect(workspaces).toHaveLength(1);
				expect(workspaces[0]?.isDefault).toBe(true);
				expect(workspaces[0]?.id).not.toBe(workspaceId);
				const team = (
					await fresh.inject({ url: "/v1/team", headers: bearer(session) })
				).json();
				expect(
					team.members.map((member: { email: string }) => member.email),
				).toEqual(["fresh@example.com"]);
				await expect(
					signIn(fresh, "founder@example.com", NEW_PASSWORD),
				).rejects.toThrow();
				expect(
					(
						await fresh.inject({
							url: `/v1/${workspaceId}/models`,
							headers: bearer(apiSecret),
						})
					).statusCode,
				).toBe(401);
				expect(
					(
						await fresh.inject({
							url: "/v1/setup/token",
							headers: bearer("recover-two"),
						})
					).statusCode,
				).toBe(409);

				expect(await db.collection("synapse_notes").countDocuments()).toBe(0);
				expect(await db.collection("gateway_api_tokens").countDocuments()).toBe(
					0,
				);
				expect(await db.collection("gateway_users").countDocuments()).toBe(1);
				expect(await db.collection("other_app").countDocuments()).toBe(1);
				// Indexes survive, so emails stay unique.
				const indexes = await db.collection("gateway_users").indexes();
				expect(indexes.map((index) => index.name)).toContain("email_unique");
				expect(GATEWAY_COLLECTIONS).not.toContain("other_app");
			} finally {
				await client.close();
				for (const server of servers) await server.close();
			}
		});
	},
);
