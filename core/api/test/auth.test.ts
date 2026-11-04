import { afterEach, describe, expect, it } from "vitest";
import {
	AccountStore,
	SESSION_TTL_MS,
	SIGN_IN_MAX_FAILURES,
	SIGN_IN_WINDOW_MS,
} from "../src/auth/accounts.js";
import { hashPassword, verifyPassword } from "../src/auth/passwords.js";
import { createServer } from "../src/server.js";
import {
	authServer,
	bearer,
	completeSetup,
	joinWithInvite,
	PASSWORD,
	signIn,
} from "./auth-helpers.js";
import { startStubProvider } from "./helpers.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
	for (const close of cleanup.splice(0)) await close();
});
function start(...args: Parameters<typeof authServer>) {
	const server = authServer(...args);
	cleanup.push(() => server.close());
	return server;
}

describe("passwords", () => {
	it("stores salted scrypt hashes with their parameters", async () => {
		const first = await hashPassword(PASSWORD);
		const second = await hashPassword(PASSWORD);
		expect(first).toMatch(/^scrypt\$16384\$8\$5\$[\w-]{22}\$[\w-]{43}$/);
		expect(first).not.toBe(second);
		expect(first).not.toContain(PASSWORD);
		expect(await verifyPassword(PASSWORD, first)).toBe(true);
		expect(await verifyPassword(`${PASSWORD}!`, first)).toBe(false);
		expect(await verifyPassword(PASSWORD, "plain$text")).toBe(false);
	});
});

describe("first-run setup", () => {
	it("requires sign-in for every gateway route before and after setup", async () => {
		const server = start();
		const status = await server.inject("/v1/auth/status");
		expect(status.headers["cache-control"]).toBe("no-store");
		expect(status.json()).toEqual({
			setupComplete: false,
			setupTokenRequired: false,
			persistence: "memory",
		});
		// There is no unauthenticated mode, even on a fresh gateway.
		expect((await server.inject("/v1/models")).statusCode).toBe(401);

		const done = await server.inject({
			method: "POST",
			url: "/v1/setup",
			payload: {
				email: "Ada@Example.com",
				name: "Ada Lovelace",
				password: PASSWORD,
			},
		});
		expect(done.statusCode).toBe(201);
		const session = done.json();
		expect(session.token).toMatch(/^ses_[0-9a-f-]{36}_[\w-]{43}$/);
		expect(session.user).toMatchObject({
			email: "ada@example.com",
			name: "Ada Lovelace",
			role: "owner",
			joinedVia: "setup",
			addedBy: null,
		});
		expect(JSON.stringify(session)).not.toContain("passwordHash");
		expect(Date.parse(session.expiresAt) - Date.now()).toBeGreaterThan(
			SESSION_TTL_MS - 60_000,
		);
		expect((await server.inject("/v1/auth/status")).json().setupComplete).toBe(
			true,
		);

		const locked = await server.inject("/v1/models");
		expect(locked.statusCode).toBe(401);
		expect(locked.headers["www-authenticate"]).toBe("Bearer");
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: bearer(session.token),
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await server.inject({
					url: "/v1/auth/session",
					headers: bearer(session.token),
				})
			).json(),
		).toMatchObject({ user: { role: "owner" } });

		// Setup runs once, with or without a session.
		const payload = {
			email: "mallory@example.com",
			name: "Mallory",
			password: PASSWORD,
		};
		for (const headers of [{}, bearer(session.token)])
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/setup",
						headers,
						payload,
					})
				).statusCode,
			).toBe(409);
	});

	it("requires SETUP_TOKEN for setup and accepts it nowhere else", async () => {
		const server = start({ setupToken: "setup-secret" });
		expect((await server.inject("/v1/auth/status")).json()).toMatchObject({
			setupComplete: false,
			setupTokenRequired: true,
		});
		const payload = {
			email: "mallory@example.com",
			name: "Mallory",
			password: PASSWORD,
		};
		for (const headers of [{}, bearer("wrong")]) {
			expect(
				(
					await server.inject({
						method: "POST",
						url: "/v1/setup",
						headers,
						payload,
					})
				).statusCode,
			).toBe(401);
			expect(
				(await server.inject({ url: "/v1/setup/token", headers })).statusCode,
			).toBe(401);
		}
		expect(
			(
				await server.inject({
					url: "/v1/setup/token",
					headers: bearer("setup-secret"),
				})
			).statusCode,
		).toBe(204);
		// The setup token is not a login: it opens no other route.
		for (const url of ["/v1/models", "/v1/team", "/v1/api-tokens"])
			expect(
				(await server.inject({ url, headers: bearer("setup-secret") }))
					.statusCode,
			).toBe(403);

		const { token } = await completeSetup(server, {
			headers: bearer("setup-secret"),
		});
		expect((await server.inject("/v1/auth/status")).json()).toMatchObject({
			setupComplete: true,
			setupTokenRequired: false,
		});
		expect(
			(
				await server.inject({
					url: "/v1/setup/token",
					headers: bearer("setup-secret"),
				})
			).statusCode,
		).toBe(409);
		expect(
			(await server.inject({ url: "/v1/team", headers: bearer(token) }))
				.statusCode,
		).toBe(200);
		expect(
			(
				await server.inject({
					url: "/v1/team",
					headers: bearer("setup-secret"),
				})
			).statusCode,
		).toBe(403);
	});

	it("rejects malformed setup input and short passwords", async () => {
		const server = start();
		for (const payload of [
			{ email: "not-an-email", name: "Ada", password: PASSWORD },
			{ email: "ada@example.com", name: " ", password: PASSWORD },
			{ email: "ada@example.com", name: "Ada", password: "short" },
			{ email: "ada@example.com", name: "Ada", password: "x".repeat(129) },
			{ email: "ada@example.com", password: PASSWORD },
		])
			expect(
				(await server.inject({ method: "POST", url: "/v1/setup", payload }))
					.statusCode,
			).toBe(400);
		expect((await server.inject("/v1/auth/status")).json().setupComplete).toBe(
			false,
		);
	});
});

describe("email and password sign-in", () => {
	it("signs in, rejects wrong passwords and unknown emails alike, and signs out one session", async () => {
		const server = start();
		const owner = await completeSetup(server);
		const wrong = await server.inject({
			method: "POST",
			url: "/v1/auth/session",
			payload: { email: "founder@example.com", password: "not the password" },
		});
		const unknown = await server.inject({
			method: "POST",
			url: "/v1/auth/session",
			payload: { email: "stranger@example.com", password: PASSWORD },
		});
		expect([wrong.statusCode, unknown.statusCode]).toEqual([401, 401]);
		expect(wrong.json().message).toBe(unknown.json().message);

		const second = await signIn(server, "FOUNDER@example.com");
		expect(second.token).not.toBe(owner.token);
		expect(
			(
				await server.inject({
					method: "DELETE",
					url: "/v1/auth/session",
					headers: bearer(second.token),
				})
			).statusCode,
		).toBe(204);
		expect(
			(await server.inject({ url: "/v1/team", headers: bearer(second.token) }))
				.statusCode,
		).toBe(401);
		expect(
			(await server.inject({ url: "/v1/team", headers: bearer(owner.token) }))
				.statusCode,
		).toBe(200);
		// A forged session for a real member is rejected.
		const forged = owner.token.replace(/_[\w-]{43}$/, `_${"A".repeat(43)}`);
		expect(
			(await server.inject({ url: "/v1/team", headers: bearer(forged) }))
				.statusCode,
		).toBe(401);
	});

	it("throttles repeated failures and expires sessions", async () => {
		let now = Date.parse("2026-11-04T12:00:00Z");
		const store = new AccountStore({ now: () => now });
		const setup = await store.completeSetup({
			email: "ada@example.com",
			name: "Ada",
			password: PASSWORD,
		});
		for (let attempt = 0; attempt < SIGN_IN_MAX_FAILURES; attempt++)
			await expect(
				store.signIn({ email: "ada@example.com", password: "wrong password" }),
			).rejects.toMatchObject({ statusCode: 401 });
		// Even the right password waits out the window.
		await expect(
			store.signIn({ email: "ada@example.com", password: PASSWORD }),
		).rejects.toMatchObject({
			statusCode: 429,
			message: expect.stringMatching(/Try again in 15 minutes/),
		});
		now += SIGN_IN_WINDOW_MS;
		await expect(
			store.signIn({ email: "ada@example.com", password: PASSWORD }),
		).resolves.toMatchObject({ user: { email: "ada@example.com" } });

		expect(await store.authenticate(setup.token)).not.toBeNull();
		now = Date.parse(setup.expiresAt);
		expect(await store.authenticate(setup.token)).toBeNull();
	});

	it("holds the throttle under concurrent guesses", async () => {
		const store = new AccountStore();
		await store.completeSetup({
			email: "ada@example.com",
			name: "Ada",
			password: PASSWORD,
		});
		const guesses = await Promise.allSettled(
			Array.from({ length: SIGN_IN_MAX_FAILURES + 5 }, () =>
				store.signIn({ email: "ada@example.com", password: "a wrong guess" }),
			),
		);
		const codes = guesses.map(
			(guess) => (guess as PromiseRejectedResult).reason.statusCode,
		);
		expect(codes.filter((code) => code === 401)).toHaveLength(
			SIGN_IN_MAX_FAILURES,
		);
		expect(codes.filter((code) => code === 429)).toHaveLength(5);
		await expect(
			store.signIn({ email: "ada@example.com", password: PASSWORD }),
		).rejects.toMatchObject({ statusCode: 429 });
	});

	it("changes a password with the current one and signs out other sessions", async () => {
		const server = start();
		const owner = await completeSetup(server);
		const other = await signIn(server, "founder@example.com");
		const change = (currentPassword: string, newPassword: string) =>
			server.inject({
				method: "PUT",
				url: "/v1/auth/password",
				headers: bearer(owner.token),
				payload: { currentPassword, newPassword },
			});
		expect(
			(await change("wrong password", "a brand new passphrase")).statusCode,
		).toBe(403);
		expect((await change(PASSWORD, "short")).statusCode).toBe(400);
		expect((await change(PASSWORD, "a brand new passphrase")).statusCode).toBe(
			204,
		);
		expect(
			(await server.inject({ url: "/v1/team", headers: bearer(owner.token) }))
				.statusCode,
		).toBe(200);
		expect(
			(await server.inject({ url: "/v1/team", headers: bearer(other.token) }))
				.statusCode,
		).toBe(401);
		await expect(signIn(server, "founder@example.com")).rejects.toThrow();
		await signIn(server, "founder@example.com", "a brand new passphrase");
	});
});

describe("invite links", () => {
	it("creates a single-use link that joins with the invited role", async () => {
		const server = start();
		const owner = await completeSetup(server, { name: "Founder" });
		const created = await server.inject({
			method: "POST",
			url: "/v1/team/invites",
			headers: bearer(owner.token),
			payload: { role: "admin", ttlDays: 7 },
		});
		expect(created.statusCode).toBe(201);
		const { token, invite } = created.json();
		expect(token).toMatch(/^inv_[0-9a-f-]{36}_[\w-]{43}$/);
		expect(invite).toMatchObject({
			role: "admin",
			status: "pending",
			createdBy: "Founder",
			acceptedBy: null,
		});
		expect(invite.prefix).not.toBe(token);

		const preview = await server.inject({
			method: "POST",
			url: "/v1/invites/preview",
			payload: { token },
		});
		expect(preview.json()).toEqual({
			role: "admin",
			invitedBy: "Founder",
			expiresAt: invite.expiresAt,
		});
		const taken = await server.inject({
			method: "POST",
			url: "/v1/invites/accept",
			payload: {
				token,
				email: "founder@example.com",
				name: "Dup",
				password: PASSWORD,
			},
		});
		expect(taken.statusCode).toBe(409);

		const accepted = await server.inject({
			method: "POST",
			url: "/v1/invites/accept",
			payload: {
				token,
				email: "Grace@Example.com",
				name: "Grace",
				password: PASSWORD,
			},
		});
		expect(accepted.statusCode).toBe(201);
		expect(accepted.json().user).toMatchObject({
			email: "grace@example.com",
			role: "admin",
			joinedVia: "invite",
			addedBy: "Founder",
		});
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: bearer(accepted.json().token),
				})
			).statusCode,
		).toBe(200);

		// A used link neither previews nor joins again.
		for (const [url, payload] of [
			["/v1/invites/preview", { token }],
			[
				"/v1/invites/accept",
				{ token, email: "again@example.com", name: "", password: PASSWORD },
			],
		] as const)
			expect(
				(await server.inject({ method: "POST", url, payload })).statusCode,
			).toBe(404);
		const team = await server.inject({
			url: "/v1/team",
			headers: bearer(owner.token),
		});
		expect(team.json().invites[0]).toMatchObject({
			status: "accepted",
			acceptedBy: "grace@example.com",
		});
		expect(JSON.stringify(team.json())).not.toContain(token);
	});

	it("rejects revoked, expired, and forged links", async () => {
		let now = Date.parse("2026-11-04T12:00:00Z");
		const store = new AccountStore({ now: () => now });
		const { user: actor } = await store.completeSetup({
			email: "ada@example.com",
			name: "Ada",
			password: PASSWORD,
		});
		const revoked = await store.createInvite(
			{ role: "member", ttlDays: 1 },
			actor,
		);
		await store.revokeInvite(revoked.invite.id, actor);
		const expiring = await store.createInvite(
			{ role: "member", ttlDays: 1 },
			actor,
		);
		const accept = (token: string) =>
			store.acceptInvite({
				token,
				email: "new@example.com",
				name: "New",
				password: PASSWORD,
			});
		await expect(accept(revoked.token)).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(
			accept(expiring.token.replace(/_[\w-]{43}$/, `_${"A".repeat(43)}`)),
		).rejects.toMatchObject({ statusCode: 404 });
		now += 86_400_000;
		await expect(accept(expiring.token)).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(
			(await store.team(actor)).invites.map((invite) => invite.status).sort(),
		).toEqual(["expired", "revoked"]);
	});
});

describe("team management", () => {
	it("adds, edits, resets, and removes members with role checks", async () => {
		const server = start();
		const owner = await completeSetup(server, { name: "Founder" });
		const add = (token: string, payload: object) =>
			server.inject({
				method: "POST",
				url: "/v1/team",
				headers: bearer(token),
				payload,
			});

		const added = await add(owner.token, {
			email: "Member@Example.com",
			name: "",
			role: "member",
			password: PASSWORD,
		});
		expect(added.statusCode).toBe(201);
		expect(added.json()).toMatchObject({
			email: "member@example.com",
			joinedVia: "added",
			addedBy: "Founder",
			lastSignInAt: null,
		});
		expect(
			(
				await add(owner.token, {
					email: "member@example.com",
					name: "Again",
					role: "member",
					password: PASSWORD,
				})
			).statusCode,
		).toBe(409);
		expect(
			(
				await add(owner.token, {
					email: "weak@example.com",
					name: "",
					role: "member",
					password: "short",
				})
			).statusCode,
		).toBe(400);

		const admin = await joinWithInvite(
			server,
			owner.token,
			"admin@example.com",
			"admin",
		);
		const member = await signIn(server, "member@example.com");
		const team = await server.inject({
			url: "/v1/team",
			headers: bearer(member.token),
		});
		expect(team.json()).toMatchObject({
			currentUserId: member.user.id,
			canManage: false,
		});
		expect(team.json().members).toHaveLength(3);

		// Members read the team; only owners and admins change it.
		expect(
			(
				await add(member.token, {
					email: "x@example.com",
					name: "",
					role: "member",
					password: PASSWORD,
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/team/invites",
					headers: bearer(member.token),
					payload: { role: "member", ttlDays: 1 },
				})
			).statusCode,
		).toBe(403);
		// Admins cannot invite, create, edit, or remove owners.
		expect(
			(
				await server.inject({
					method: "POST",
					url: "/v1/team/invites",
					headers: bearer(admin.token),
					payload: { role: "owner", ttlDays: 1 },
				})
			).statusCode,
		).toBe(403);
		expect(
			(
				await server.inject({
					method: "PATCH",
					url: `/v1/team/${owner.user.id}`,
					headers: bearer(admin.token),
					payload: { name: "Founder", role: "member" },
				})
			).statusCode,
		).toBe(403);
		const renamed = await server.inject({
			method: "PATCH",
			url: `/v1/team/${member.user.id}`,
			headers: bearer(admin.token),
			payload: { name: "Teammate", role: "member" },
		});
		expect(renamed.json()).toMatchObject({ name: "Teammate" });

		// The last owner can be neither demoted nor removed, and nobody removes themselves.
		expect(
			(
				await server.inject({
					method: "PATCH",
					url: `/v1/team/${owner.user.id}`,
					headers: bearer(owner.token),
					payload: { name: "Founder", role: "admin" },
				})
			).statusCode,
		).toBe(409);
		expect(
			(
				await server.inject({
					method: "DELETE",
					url: `/v1/team/${admin.user.id}`,
					headers: bearer(admin.token),
				})
			).statusCode,
		).toBe(409);

		// A reset signs the member out everywhere; their own reset uses Change password.
		const reset = (token: string, id: string) =>
			server.inject({
				method: "PUT",
				url: `/v1/team/${id}/password`,
				headers: bearer(token),
				payload: { password: "reset by an admin" },
			});
		expect((await reset(admin.token, admin.user.id)).statusCode).toBe(409);
		expect((await reset(admin.token, member.user.id)).statusCode).toBe(200);
		expect(
			(
				await server.inject({
					url: "/v1/models",
					headers: bearer(member.token),
				})
			).statusCode,
		).toBe(401);
		const again = await signIn(
			server,
			"member@example.com",
			"reset by an admin",
		);

		// Removing a member signs them out everywhere.
		expect(
			(
				await server.inject({
					method: "DELETE",
					url: `/v1/team/${member.user.id}`,
					headers: bearer(admin.token),
				})
			).statusCode,
		).toBe(200);
		expect(
			(await server.inject({ url: "/v1/models", headers: bearer(again.token) }))
				.statusCode,
		).toBe(401);
		expect(
			(
				await server.inject({ url: "/v1/team", headers: bearer(owner.token) })
			).json().members,
		).toHaveLength(2);
	});

	it("blocks team changes without a member session, including from API tokens", async () => {
		const server = start();
		const early = await server.inject({
			method: "POST",
			url: "/v1/team/invites",
			payload: { role: "owner", ttlDays: 1 },
		});
		expect(early.statusCode).toBe(401);
		const owner = await completeSetup(server);
		const created = await server.inject({
			method: "POST",
			url: "/v1/api-tokens",
			headers: bearer(owner.token),
			payload: {
				name: "Everything",
				description: "",
				ttlDays: 1,
				permissions: [
					"models:edit",
					"routing:edit",
					"inference:run",
					"telemetry:read",
				],
			},
		});
		const { secret } = created.json();
		for (const [method, url] of [
			["GET", "/v1/team"],
			["POST", "/v1/team/invites"],
			["PUT", "/v1/auth/password"],
		] as const)
			expect(
				(await server.inject({ method, url, headers: bearer(secret) }))
					.statusCode,
			).toBe(403);
		const tokens = await server.inject({
			url: "/v1/api-tokens",
			headers: bearer(owner.token),
		});
		expect(tokens.json()).toMatchObject({ authenticationRequired: true });
		expect(tokens.json().actions[0]).toMatchObject({
			actor: "user",
			actorName: "Founder",
		});
	});

	it("never lets concurrent changes remove the last owner", async () => {
		const store = new AccountStore();
		const { user: first } = await store.completeSetup({
			email: "first@example.com",
			name: "First",
			password: PASSWORD,
		});
		const second = await store.addMember(
			{
				email: "second@example.com",
				name: "Second",
				role: "owner",
				password: PASSWORD,
			},
			first,
		);
		const owners = async () =>
			(await store.team(first)).members.filter(
				(member) => member.role === "owner",
			);
		// Two owners demote each other at the same moment.
		const demotions = await Promise.allSettled([
			store.updateMember(second.id, { name: "Second", role: "admin" }, first),
			store.updateMember(first.id, { name: "First", role: "admin" }, second),
		]);
		expect(demotions.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(
			(demotions.find((r) => r.status === "rejected") as PromiseRejectedResult)
				.reason.statusCode,
		).toBe(409);
		expect(await owners()).toHaveLength(1);

		// And two owners remove each other.
		const [remaining] = await owners();
		const third = await store.addMember(
			{
				email: "third@example.com",
				name: "Third",
				role: "owner",
				password: PASSWORD,
			},
			remaining,
		);
		const removals = await Promise.allSettled([
			store.removeMember(third.id, remaining),
			store.removeMember(remaining.id, third),
		]);
		expect(removals.filter((r) => r.status === "fulfilled")).toHaveLength(1);
		expect(await owners()).toHaveLength(1);
	});

	it("limits API and agent token management to owners and admins", async () => {
		const server = start();
		const owner = await completeSetup(server);
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
		for (const path of ["/v1/api-tokens", "/v1/agent-tokens"]) {
			const create = (token: string) =>
				server.inject({
					method: "POST",
					url: path,
					headers: bearer(token),
					payload: { name: "Client", description: "", ttlDays: 1 },
				});
			expect((await create(member.token)).statusCode).toBe(403);
			expect(
				(await server.inject({ url: path, headers: bearer(member.token) }))
					.statusCode,
			).toBe(403);
			expect((await create(admin.token)).statusCode).toBe(201);
			expect(
				(await server.inject({ url: path, headers: bearer(admin.token) }))
					.statusCode,
			).toBe(200);
		}
	});

	it("re-checks authorization when a reset races a promotion to owner", async () => {
		const store = new AccountStore();
		const { user: owner } = await store.completeSetup({
			email: "owner@example.com",
			name: "Owner",
			password: PASSWORD,
		});
		const admin = await store.addMember(
			{
				email: "admin@example.com",
				name: "",
				role: "admin",
				password: PASSWORD,
			},
			owner,
		);
		const target = await store.addMember(
			{ email: "t@example.com", name: "", role: "member", password: PASSWORD },
			owner,
		);
		// The reset hashes its password first, so the promotion commits before it.
		const [reset, promotion] = await Promise.allSettled([
			store.resetPassword(target.id, "an admin chosen password", admin),
			store.updateMember(target.id, { name: "", role: "owner" }, owner),
		]);
		expect(promotion.status).toBe("fulfilled");
		expect(reset).toMatchObject({
			status: "rejected",
			reason: { statusCode: 403 },
		});
		await expect(
			store.signIn({
				email: "t@example.com",
				password: "an admin chosen password",
			}),
		).rejects.toMatchObject({ statusCode: 401 });
	});

	it("lets an admin reset win over a concurrent self-service change", async () => {
		const store = new AccountStore();
		const { user: owner } = await store.completeSetup({
			email: "owner@example.com",
			name: "Owner",
			password: PASSWORD,
		});
		const member = await store.addMember(
			{ email: "m@example.com", name: "", role: "member", password: PASSWORD },
			owner,
		);
		const session = await store.signIn({
			email: "m@example.com",
			password: PASSWORD,
		});
		// The change verifies and hashes (two scrypt runs); the reset commits first.
		const [change, reset] = await Promise.allSettled([
			store.changePassword(member, session.token, {
				currentPassword: PASSWORD,
				newPassword: "member chosen password",
			}),
			store.resetPassword(member.id, "the reset password", owner),
		]);
		expect(reset.status).toBe("fulfilled");
		expect(change).toMatchObject({
			status: "rejected",
			reason: { statusCode: 409 },
		});
		await store.signIn({
			email: "m@example.com",
			password: "the reset password",
		});
		await expect(
			store.signIn({
				email: "m@example.com",
				password: "member chosen password",
			}),
		).rejects.toMatchObject({ statusCode: 401 });
	});

	it("attributes gateway usage to the signed-in member", async () => {
		const provider = await startStubProvider();
		cleanup.push(provider.close);
		const server = createServer({
			config: { providers: [], corsOrigins: ["*"] },
			registry: provider.registry,
			logger: false,
		});
		cleanup.push(() => server.close());
		const owner = await completeSetup(server, { name: "Ada" });
		const chat = await server.inject({
			method: "POST",
			url: "/v1/chat",
			headers: bearer(owner.token),
			payload: {
				model: "stub/chat-model",
				messages: [{ role: "user", content: "hi" }],
			},
		});
		expect(chat.statusCode).toBe(200);
		const to = new Date(Date.now() + 60_000).toISOString();
		const from = new Date(Date.now() - 3_600_000).toISOString();
		const analytics = await server.inject({
			url: `/v1/telemetry/analytics?from=${from}&to=${to}`,
			headers: bearer(owner.token),
		});
		expect(analytics.json()).toMatchObject({
			activeCallers: 1,
			unattributedRequests: 0,
			byCaller: [{ id: `user:${owner.user.id}`, name: "Ada", kind: "user" }],
		});
	});
});
