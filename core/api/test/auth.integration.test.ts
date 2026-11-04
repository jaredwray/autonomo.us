import type { TeamMember } from "@autonomo.us/common";
import { MongoClient } from "mongodb";
import { afterAll, describe, expect, it } from "vitest";
import { AccountStore } from "../src/auth/accounts.js";
import { tokenHash } from "../src/auth/tokens.js";
import {
	authServer,
	bearer,
	completeSetup,
	joinWithInvite,
	PASSWORD,
	signIn,
} from "./auth-helpers.js";
import { mongoAvailable, uniqueMongoUrl } from "./mongo-env.js";

const available = await mongoAvailable();
if (!available)
	console.warn("MongoDB unavailable; skipping team account integration tests.");
const urls: string[] = [];
function database() {
	const url = uniqueMongoUrl("accounts");
	urls.push(url);
	return url;
}
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

describe.skipIf(!available)("durable team accounts", () => {
	it("marks setup in MongoDB and shares sessions, invites, and removals across replicas", async () => {
		const url = database();
		const first = authServer({ mongodbUrl: url });
		const replica = authServer({ mongodbUrl: url });
		try {
			expect((await replica.inject("/v1/auth/status")).json()).toMatchObject({
				setupComplete: false,
				persistence: "mongodb",
			});
			const owner = await completeSetup(first);
			expect(
				(await replica.inject("/v1/auth/status")).json().setupComplete,
			).toBe(true);
			expect((await replica.inject("/v1/models")).statusCode).toBe(401);

			// An invite created on one replica is redeemed on the other.
			const invite = await first.inject({
				method: "POST",
				url: "/v1/team/invites",
				headers: bearer(owner.token),
				payload: { role: "member", ttlDays: 7 },
			});
			const { token } = invite.json();
			const joined = await replica.inject({
				method: "POST",
				url: "/v1/invites/accept",
				payload: {
					token,
					email: "teammate@example.com",
					name: "Teammate",
					password: PASSWORD,
				},
			});
			expect(joined.statusCode).toBe(201);
			const teammate = joined.json();
			const again = await signIn(first, "teammate@example.com");

			const client = new MongoClient(url);
			try {
				const setup = await client
					.db()
					.collection("gateway_setup")
					.findOne({ _id: "default" as never });
				expect(setup).toMatchObject({ ownerId: owner.user.id });
				expect(typeof setup?.completedAt).toBe("string");
				const raw = JSON.stringify(
					await client.db().collection("gateway_users").find().toArray(),
				);
				expect(raw).not.toContain(PASSWORD);
				expect(raw).toMatch(/scrypt\$16384\$8\$5\$/);
				for (const session of [owner.token, teammate.token, again.token]) {
					expect(raw).not.toContain(session);
					expect(raw).toContain(tokenHash(session));
				}
				const invites = JSON.stringify(
					await client.db().collection("gateway_invites").find().toArray(),
				);
				expect(invites).not.toContain(token);
				expect(invites).toContain(tokenHash(token));
				expect(
					await client.db().collection("gateway_users").indexes(),
				).toContainEqual(
					expect.objectContaining({ name: "email_unique", unique: true }),
				);
			} finally {
				await client.close();
			}

			await first.inject({
				method: "DELETE",
				url: `/v1/team/${teammate.user.id}`,
				headers: bearer(owner.token),
			});
			for (const session of [teammate.token, again.token])
				expect(
					(
						await replica.inject({
							url: "/v1/models",
							headers: bearer(session),
						})
					).statusCode,
				).toBe(401);
		} finally {
			await first.close();
			await replica.close();
		}
	});

	it("completes a setup whose owner was committed but never copied", async () => {
		const url = database();
		const client = new MongoClient(url);
		const writer = new AccountStore({ mongodbUrl: url });
		try {
			// Commit setup normally, then simulate a crash before the owner copy
			// by deleting the account and restoring its embedded copy.
			const { user } = await writer.completeSetup({
				email: "owner@example.com",
				name: "Owner",
				password: PASSWORD,
			});
			const users = client.db().collection("gateway_users");
			const owner = await users.findOne({ _id: user.id as never });
			expect(
				(
					await client
						.db()
						.collection("gateway_setup")
						.findOne({ _id: "default" as never })
				)?.owner,
			).toBeNull();
			await users.deleteOne({ _id: user.id as never });
			await client
				.db()
				.collection("gateway_setup")
				.updateOne({ _id: "default" as never }, { $set: { owner } });

			const app = authServer({ mongodbUrl: url });
			try {
				expect((await app.inject("/v1/auth/status")).json().setupComplete).toBe(
					true,
				);
				await signIn(app, "owner@example.com");
				expect(
					(
						await app.inject({
							method: "POST",
							url: "/v1/setup",
							payload: {
								email: "second@example.com",
								name: "Second",
								password: PASSWORD,
							},
						})
					).statusCode,
				).toBe(409);
				expect(await users.countDocuments()).toBe(1);
			} finally {
				await app.close();
			}
		} finally {
			await writer.close();
			await client.close();
		}
	});

	it("stays set up after the first owner is removed", async () => {
		const url = database();
		const first = authServer({ mongodbUrl: url });
		try {
			const founder = await completeSetup(first);
			const second = await joinWithInvite(
				first,
				founder.token,
				"second@example.com",
				"owner",
			);
			expect(
				(
					await first.inject({
						method: "DELETE",
						url: `/v1/team/${founder.user.id}`,
						headers: bearer(second.token),
					})
				).statusCode,
			).toBe(200);
		} finally {
			await first.close();
		}
		// A freshly started instance has no cached state to lean on.
		const fresh = authServer({ mongodbUrl: url });
		try {
			expect((await fresh.inject("/v1/auth/status")).json().setupComplete).toBe(
				true,
			);
			const takeover = await fresh.inject({
				method: "POST",
				url: "/v1/setup",
				payload: {
					email: "mallory@example.com",
					name: "Mallory",
					password: PASSWORD,
				},
			});
			expect(takeover.statusCode).toBe(409);
		} finally {
			await fresh.close();
		}
	});

	it("lets setup run again over a marker with no owner", async () => {
		const url = database();
		const client = new MongoClient(url);
		const app = authServer({ mongodbUrl: url });
		try {
			await client
				.db()
				.collection("gateway_setup")
				.insertOne({
					_id: "default" as never,
					revision: 1,
					completedAt: new Date().toISOString(),
					ownerId: "00000000-0000-4000-8000-000000000000",
				});
			expect((await app.inject("/v1/auth/status")).json().setupComplete).toBe(
				false,
			);
			await completeSetup(app);
			expect((await app.inject("/v1/auth/status")).json().setupComplete).toBe(
				true,
			);
		} finally {
			await app.close();
			await client.close();
		}
	});

	it("lets exactly one concurrent setup win", async () => {
		const url = database();
		const stores = [
			new AccountStore({ mongodbUrl: url }),
			new AccountStore({ mongodbUrl: url }),
		];
		try {
			const results = await Promise.allSettled(
				stores.map((store, index) =>
					store.completeSetup({
						email: `owner${index}@example.com`,
						name: `Owner ${index}`,
						password: PASSWORD,
					}),
				),
			);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			expect(
				(results.find((r) => r.status === "rejected") as PromiseRejectedResult)
					.reason.statusCode,
			).toBe(409);
			const winner = results.find((r) => r.status === "fulfilled");
			expect(
				(
					await stores[1].team(
						(winner as PromiseFulfilledResult<{ user: TeamMember }>).value.user,
					)
				).members,
			).toHaveLength(1);
		} finally {
			for (const store of stores) await store.close();
		}
	});

	it("keeps an owner when two owners remove each other concurrently", async () => {
		const url = database();
		const stores = [
			new AccountStore({ mongodbUrl: url }),
			new AccountStore({ mongodbUrl: url }),
		];
		try {
			const { user: first } = await stores[0].completeSetup({
				email: "first@example.com",
				name: "First",
				password: PASSWORD,
			});
			const second = await stores[0].addMember(
				{
					email: "second@example.com",
					name: "Second",
					role: "owner",
					password: PASSWORD,
				},
				first,
			);
			const results = await Promise.allSettled([
				stores[0].removeMember(second.id, first),
				stores[1].removeMember(first.id, second),
			]);
			expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
			const survivor = results[0].status === "fulfilled" ? first : second;
			const team = await stores[1].team(survivor);
			expect(team.members.map((member) => member.role)).toEqual(["owner"]);
		} finally {
			for (const store of stores) await store.close();
		}
	});

	it("redeems an invite link only once under concurrency", async () => {
		const url = database();
		const app = authServer({ mongodbUrl: url });
		try {
			const owner = await completeSetup(app);
			const { token } = (
				await app.inject({
					method: "POST",
					url: "/v1/team/invites",
					headers: bearer(owner.token),
					payload: { role: "member", ttlDays: 1 },
				})
			).json();
			const codes = (
				await Promise.all(
					[1, 2, 3].map((index) =>
						app.inject({
							method: "POST",
							url: "/v1/invites/accept",
							payload: {
								token,
								email: `racer${index}@example.com`,
								name: "",
								password: PASSWORD,
							},
						}),
					),
				)
			).map((response) => response.statusCode);
			expect(codes.filter((code) => code === 201)).toHaveLength(1);
			expect(
				(
					await app.inject({ url: "/v1/team", headers: bearer(owner.token) })
				).json().members,
			).toHaveLength(2);
		} finally {
			await app.close();
		}
	});

	it("reports MongoDB outages as unavailable and never opens the gateway", async () => {
		const url = new URL(uniqueMongoUrl("accounts_down"));
		url.host = "127.0.0.1:9";
		const server = authServer({ mongodbUrl: url.toString() });
		try {
			expect((await server.inject("/v1/auth/status")).statusCode).toBe(503);
			expect((await server.inject("/v1/models")).statusCode).toBe(401);
			const session = `ses_${"0".repeat(8)}-0000-4000-8000-${"0".repeat(12)}_${"A".repeat(43)}`;
			const models = await server.inject({
				url: "/v1/models",
				headers: bearer(session),
			});
			expect(models.statusCode).toBe(503);
			expect(models.json().message).toMatch(/Team accounts are unavailable/);
		} finally {
			await server.close();
		}
		// Startup and each request wait out server selection against a closed port.
	}, 30_000);
});
