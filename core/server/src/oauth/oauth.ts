import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
	type AgentConnection,
	isLoopbackUrl,
	OAUTH_LIMITS,
	type OAuthSignIn,
	redirectHost,
	redirectUriProblem,
} from "@autonomo.us/common";
import { secretMatches, tokenHash } from "../auth/token-store.js";
import { ServiceError } from "../service-error.js";
import type {
	OAuthRepository,
	StoredClient,
	StoredGrant,
} from "./repository.js";

/** An OAuth protocol error, sent as `{ error, error_description }` (RFC 6749 §5.2). */
export class OAuthError extends Error {
	constructor(
		readonly error: string,
		message: string,
		readonly statusCode = 400,
	) {
		super(message);
	}
}

/** A sign-in the dashboard asked about that cannot be decided any more. */
export class SignInError extends ServiceError {}

/** What the sign-in flow needs to know about agents. */
export type OAuthAgents = {
	/**
	 * The MCP grants of an agent that signs in with OAuth, or null when there
	 * is no such agent or it is revoked.
	 */
	permissions(workspaceId: string, agentId: string): Promise<string[] | null>;
	/** Writes a sign-in or sign-out into the agent's history. */
	record(
		workspaceId: string,
		agentId: string,
		action: "connected" | "disconnected",
		detail: string,
		actorName?: string,
	): Promise<void>;
};

export type OAuthIdentity = {
	grantId: string;
	workspaceId: string;
	agentId: string;
};

export type TokenResponse = {
	access_token: string;
	token_type: "Bearer";
	expires_in: number;
	refresh_token: string;
	scope?: string;
};

const SECRET = /^(oac|oat|ort)_([0-9a-f-]{36})_[A-Za-z0-9_-]{43}$/;
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
const VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
/** A refresh token seen again this soon after it was replaced is a retry. */
const REUSE_GRACE_MS = 60_000;
export const OAUTH_SCOPES = ["mcp:read", "mcp:call", "channels:manage"];

const text = (value: unknown) => (typeof value === "string" ? value : "");
function secret(kind: "oac" | "oat" | "ort", grantId: string) {
	return `${kind}_${grantId}_${randomBytes(32).toString("base64url")}`;
}
function parseSecret(kind: "oac" | "oat" | "ort", value: string) {
	const match = SECRET.exec(value);
	return match && match[1] === kind ? match[2] : null;
}
const s256 = (verifier: string) =>
	createHash("sha256").update(verifier).digest("base64url");

/** Whether `requested` is the address an app registered. */
export function redirectMatches(registered: string, requested: string) {
	if (registered === requested) return true;
	// An app on this computer listens on whichever port is free (RFC 8252 §7.3).
	try {
		const a = new URL(registered);
		const b = new URL(requested);
		return (
			isLoopbackUrl(a) &&
			isLoopbackUrl(b) &&
			a.hostname === b.hostname &&
			a.pathname === b.pathname &&
			a.search === b.search
		);
	} catch {
		return false;
	}
}

/** The MCP endpoint's address, which a sign-in must be for (RFC 8707). */
export const mcpResource = (origin: string) => `${origin}/mcp`;
function resourceMatches(resource: string, origin: string) {
	try {
		const url = new URL(resource);
		return (
			url.origin === origin &&
			["/mcp", "/mcp/", "/"].includes(url.pathname) &&
			!url.search
		);
	} catch {
		return false;
	}
}

/**
 * The gateway as an OAuth 2.1 authorization server for its own MCP endpoint.
 * Apps register themselves, a workspace admin approves each sign-in in the
 * dashboard and chooses the agent, and the app receives a short-lived access
 * token and a refresh token that changes on every use. Only hashes are stored.
 */
export class OAuthService {
	constructor(
		private readonly repository: OAuthRepository,
		private readonly agents: OAuthAgents,
		private readonly now = Date.now,
	) {}

	get persistence() {
		return this.repository.persistence;
	}
	private iso(offsetMs = 0) {
		return new Date(this.now() + offsetMs).toISOString();
	}
	private date(offsetMs = 0) {
		return new Date(this.now() + offsetMs);
	}
	private expired(at: string | Date) {
		return new Date(at).getTime() <= this.now();
	}

	/** Dynamic Client Registration (RFC 7591), for public clients only. */
	async register(body: unknown) {
		if (body === null || typeof body !== "object" || Array.isArray(body))
			throw new OAuthError(
				"invalid_client_metadata",
				"Send the client metadata as a JSON object.",
			);
		const input = body as Record<string, unknown>;
		const uris = input.redirect_uris;
		if (
			!Array.isArray(uris) ||
			!uris.length ||
			uris.length > OAUTH_LIMITS.redirectUris
		)
			throw new OAuthError(
				"invalid_redirect_uri",
				`Provide between 1 and ${OAUTH_LIMITS.redirectUris} redirect_uris.`,
			);
		for (const uri of uris) {
			const problem = redirectUriProblem(uri);
			if (problem)
				throw new OAuthError(
					"invalid_redirect_uri",
					`A redirect URI ${problem}.`,
				);
		}
		const name =
			text(input.client_name)
				.replace(/\p{Cc}/gu, " ")
				.trim()
				.slice(0, OAUTH_LIMITS.clientNameLength) || "MCP app";
		let uri: string | null = null;
		try {
			const parsed = new URL(text(input.client_uri));
			if (parsed.protocol === "https:" && parsed.href.length <= 500)
				uri = parsed.href;
		} catch {}
		if (
			(await this.repository.countPendingClients(this.date())) >=
			OAUTH_LIMITS.pendingClients
		)
			await this.repository.removeOldestPendingClient();
		const client: StoredClient = {
			id: randomUUID(),
			name,
			uri,
			redirectUris: [...new Set(uris as string[])],
			createdAt: this.iso(),
			approvedAt: null,
			expiresAt: this.date(OAUTH_LIMITS.pendingClientDays * 86_400_000),
		};
		await this.repository.insertClient(client);
		return {
			client_id: client.id,
			client_id_issued_at: Math.floor(this.now() / 1000),
			client_name: client.name,
			...(client.uri ? { client_uri: client.uri } : {}),
			redirect_uris: client.redirectUris,
			grant_types: ["authorization_code", "refresh_token"],
			response_types: ["code"],
			token_endpoint_auth_method: "none",
		};
	}

	private async client(id: string) {
		if (!/^[0-9a-f-]{36}$/.test(id)) return null;
		const client = await this.repository.getClient(id);
		return client && !(client.expiresAt && this.expired(client.expiresAt))
			? client
			: null;
	}

	/**
	 * The start of a sign-in. A problem with the app or its redirect address
	 * is shown to the person (`page`); any other problem goes back to the app.
	 * Otherwise the request is saved and `request` is the id to decide it by.
	 */
	async authorize(
		query: Record<string, unknown>,
		origin: string,
	): Promise<{ page: string } | { redirect: string } | { request: string }> {
		const client = await this.client(text(query.client_id));
		if (!client)
			return {
				page: "This app is not registered with the gateway, or its registration has expired. Start the sign-in again from the app.",
			};
		const requested = text(query.redirect_uri);
		const redirectUri =
			requested ||
			(client.redirectUris.length === 1 ? client.redirectUris[0] : "");
		if (
			!redirectUri ||
			redirectUriProblem(redirectUri) ||
			!client.redirectUris.some((uri) => redirectMatches(uri, redirectUri))
		)
			return {
				page: "The address this app asked to return to is not one it registered. Nothing was approved.",
			};
		const state = typeof query.state === "string" ? query.state : null;
		const refuse = (error: string, description: string) => ({
			redirect: redirectWith(redirectUri, {
				error,
				error_description: description,
				state: state?.slice(0, OAUTH_LIMITS.stateLength) ?? null,
			}),
		});
		if (query.response_type !== "code")
			return refuse(
				"unsupported_response_type",
				'Only response_type "code" is supported.',
			);
		if (state && state.length > OAUTH_LIMITS.stateLength)
			return refuse("invalid_request", "state is too long.");
		const challenge = text(query.code_challenge);
		if (query.code_challenge_method !== "S256" || !CHALLENGE.test(challenge))
			return refuse(
				"invalid_request",
				"PKCE is required: send code_challenge with code_challenge_method S256.",
			);
		if (
			query.resource !== undefined &&
			!resourceMatches(text(query.resource), origin)
		)
			return refuse(
				"invalid_target",
				`This server signs apps in to ${mcpResource(origin)} only.`,
			);
		const id = randomBytes(32).toString("base64url");
		await this.repository.insertRequest({
			id: tokenHash(id),
			clientId: client.id,
			redirectUri,
			state,
			codeChallenge: challenge,
			createdAt: this.iso(),
			expiresAt: this.date(OAUTH_LIMITS.requestMinutes * 60_000),
		});
		return { request: id };
	}

	private async pending(id: string, take: boolean) {
		const key = /^[A-Za-z0-9_-]{43}$/.test(id) ? tokenHash(id) : "";
		const request = key
			? await (take
					? this.repository.takeRequest(key)
					: this.repository.getRequest(key))
			: null;
		const client =
			request && !this.expired(request.expiresAt)
				? await this.client(request.clientId)
				: null;
		if (!request || !client)
			throw new SignInError(
				"This sign-in has expired or was already decided. Start it again from the app.",
				410,
			);
		return { request, client };
	}

	/** What a person needs to see before deciding a sign-in. */
	async signIn(id: string): Promise<OAuthSignIn> {
		const { request, client } = await this.pending(id, false);
		return {
			id,
			clientName: client.name,
			clientUri: client.uri,
			redirectUri: request.redirectUri,
			redirectHost: redirectHost(request.redirectUri),
			knownClient: client.approvedAt !== null,
			expiresAt: request.expiresAt.toISOString(),
		};
	}

	/** Checks a sign-in can still be approved for this agent, before anything is created. */
	async approvable(id: string, workspaceId: string, agentId?: string) {
		await this.pending(id, false);
		if (
			agentId &&
			(await this.connections(workspaceId, agentId)).length >=
				OAUTH_LIMITS.connectionsPerAgent
		)
			throw new SignInError(
				`This agent already has ${OAUTH_LIMITS.connectionsPerAgent} apps signed in. Disconnect one first.`,
				409,
			);
	}

	/**
	 * A person approved: the app may sign in as `agentId`. Returns where to
	 * send the browser. The request is used up, so a second approval fails.
	 */
	async approve(
		id: string,
		target: { workspaceId: string; agentId: string },
		approver: string,
	): Promise<string> {
		const { request, client } = await this.pending(id, true);
		const grantId = randomUUID();
		const code = secret("oac", grantId);
		const expiresAt = this.date(OAUTH_LIMITS.codeSeconds * 1000);
		await this.repository.insertGrant({
			id: grantId,
			workspaceId: target.workspaceId,
			agentId: target.agentId,
			clientId: client.id,
			clientName: client.name,
			redirectUri: request.redirectUri,
			approvedBy: approver,
			createdAt: this.iso(),
			code: {
				hash: tokenHash(code),
				expiresAt: expiresAt.toISOString(),
				challenge: request.codeChallenge,
				usedAt: null,
			},
			access: [],
			refresh: null,
			previousRefresh: null,
			lastUsedAt: null,
			expiresAt,
			revision: 0,
		});
		await this.repository.approveClient(client.id, this.iso());
		return redirectWith(request.redirectUri, { code, state: request.state });
	}

	/** A person refused. Returns where to send the browser. */
	async deny(id: string): Promise<string> {
		const { request } = await this.pending(id, true);
		return redirectWith(request.redirectUri, {
			error: "access_denied",
			error_description: "The sign-in was not approved.",
			state: request.state,
		});
	}

	/** The token endpoint: a code for tokens, or a refresh token for new ones. */
	async token(
		form: Record<string, unknown>,
		origin: string,
	): Promise<TokenResponse> {
		if (
			form.resource !== undefined &&
			!resourceMatches(text(form.resource), origin)
		)
			throw new OAuthError(
				"invalid_target",
				`This server issues tokens for ${mcpResource(origin)} only.`,
			);
		if (form.grant_type === "authorization_code") return this.exchange(form);
		if (form.grant_type === "refresh_token") return this.refresh(form);
		throw new OAuthError(
			"unsupported_grant_type",
			"Use grant_type authorization_code or refresh_token.",
		);
	}

	/** Refuses unless the grant's agent may still be used; removes the grant then. */
	private async scope(grant: StoredGrant) {
		const permissions = await this.agents.permissions(
			grant.workspaceId,
			grant.agentId,
		);
		if (!permissions) {
			await this.repository.removeGrant(grant.id);
			throw new OAuthError("invalid_grant", "This agent has been revoked.");
		}
		return permissions.join(" ");
	}

	/** New tokens on `grant`; the caller saves it. */
	private issue(grant: StoredGrant, scope: string): TokenResponse {
		const access = secret("oat", grant.id);
		const refresh = secret("ort", grant.id);
		const refreshMs = OAUTH_LIMITS.refreshTokenDays * 86_400_000;
		grant.access = [
			{
				hash: tokenHash(access),
				expiresAt: this.iso(OAUTH_LIMITS.accessTokenSeconds * 1000),
			},
			// A request already on its way keeps working until its token expires.
			...grant.access.filter((item) => !this.expired(item.expiresAt)),
		].slice(0, 3);
		grant.refresh = {
			hash: tokenHash(refresh),
			expiresAt: this.iso(refreshMs),
		};
		grant.expiresAt = this.date(refreshMs);
		grant.revision++;
		return {
			access_token: access,
			token_type: "Bearer",
			expires_in: OAUTH_LIMITS.accessTokenSeconds,
			refresh_token: refresh,
			...(scope ? { scope } : {}),
		};
	}

	private async exchange(form: Record<string, unknown>) {
		const bad = () =>
			new OAuthError(
				"invalid_grant",
				"The authorization code is invalid, expired, or already used.",
			);
		const code = text(form.code);
		const grantId = parseSecret("oac", code);
		const grant = grantId ? await this.repository.getGrant(grantId) : null;
		if (!grant || !secretMatches(code, grant.code.hash)) throw bad();
		if (grant.code.usedAt) {
			// A code presented twice may have been stolen: end what it started.
			await this.remove(grant, "Its sign-in code was used twice.");
			throw bad();
		}
		if (
			this.expired(grant.code.expiresAt) ||
			text(form.client_id) !== grant.clientId ||
			(form.redirect_uri !== undefined &&
				text(form.redirect_uri) !== grant.redirectUri)
		)
			throw bad();
		const verifier = text(form.code_verifier);
		if (!VERIFIER.test(verifier) || s256(verifier) !== grant.code.challenge)
			throw new OAuthError("invalid_grant", "The PKCE code_verifier is wrong.");
		const scope = await this.scope(grant);
		const revision = grant.revision;
		grant.code.usedAt = this.iso();
		grant.lastUsedAt = grant.code.usedAt;
		const response = this.issue(grant, scope);
		if (!(await this.repository.replaceGrant(grant, revision))) throw bad();
		await this.agents.record(
			grant.workspaceId,
			grant.agentId,
			"connected",
			`${grant.clientName} signed in at ${redirectHost(grant.redirectUri)}.`,
			grant.approvedBy,
		);
		return response;
	}

	private async refresh(form: Record<string, unknown>) {
		const bad = () =>
			new OAuthError(
				"invalid_grant",
				"The refresh token is invalid or expired. Sign in again.",
			);
		const token = text(form.refresh_token);
		const grantId = parseSecret("ort", token);
		const grant = grantId ? await this.repository.getGrant(grantId) : null;
		if (!grant || text(form.client_id) !== grant.clientId) throw bad();
		if (!grant.refresh || !secretMatches(token, grant.refresh.hash)) {
			const previous = grant.previousRefresh;
			// A replaced token that turns up later was copied: end the connection.
			if (
				previous &&
				secretMatches(token, previous.hash) &&
				this.now() - Date.parse(previous.rotatedAt) > REUSE_GRACE_MS
			)
				await this.remove(grant, "A replaced refresh token was used again.");
			throw bad();
		}
		if (this.expired(grant.refresh.expiresAt)) throw bad();
		const scope = await this.scope(grant);
		const revision = grant.revision;
		grant.previousRefresh = { hash: grant.refresh.hash, rotatedAt: this.iso() };
		grant.lastUsedAt = this.iso();
		const response = this.issue(grant, scope);
		// Two refreshes at once: one wins, the other signs in again.
		if (!(await this.repository.replaceGrant(grant, revision))) throw bad();
		return response;
	}

	/** RFC 7009: an app hands a token back. Unknown tokens are not an error. */
	async revoke(token: string) {
		const grantId = parseSecret("ort", token) ?? parseSecret("oat", token);
		const grant = grantId ? await this.repository.getGrant(grantId) : null;
		if (!grant) return;
		const held = [grant.refresh, ...grant.access].some(
			(item) => item && secretMatches(token, item.hash),
		);
		if (held) await this.remove(grant, "The app signed out.");
	}

	private async remove(grant: StoredGrant, reason: string, actor?: string) {
		if (!(await this.repository.removeGrant(grant.id)) || !grant.refresh)
			return;
		await this.agents
			.record(
				grant.workspaceId,
				grant.agentId,
				"disconnected",
				`${grant.clientName} disconnected. ${reason}`,
				actor,
			)
			.catch(() => {});
	}

	/** Who an access token speaks for, or null. */
	async authenticate(token: string): Promise<OAuthIdentity | null> {
		const grantId = parseSecret("oat", token);
		const grant = grantId ? await this.repository.getGrant(grantId) : null;
		if (
			!grant?.access.some(
				(item) =>
					!this.expired(item.expiresAt) && secretMatches(token, item.hash),
			)
		)
			return null;
		return {
			grantId: grant.id,
			workspaceId: grant.workspaceId,
			agentId: grant.agentId,
		};
	}

	private live(grant: StoredGrant) {
		return grant.refresh !== null && !this.expired(grant.refresh.expiresAt);
	}

	/** Apps signed in to a workspace's agents, or to one of them. */
	async connections(
		workspaceId: string,
		agentId?: string,
	): Promise<AgentConnection[]> {
		return (await this.repository.listGrants(workspaceId, agentId))
			.filter((grant) => this.live(grant))
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map((grant) => ({
				id: grant.id,
				agentId: grant.agentId,
				clientName: grant.clientName,
				redirectHost: redirectHost(grant.redirectUri),
				approvedBy: grant.approvedBy,
				createdAt: grant.createdAt,
				lastUsedAt: grant.lastUsedAt,
				expiresAt: (grant.refresh as { expiresAt: string }).expiresAt,
			}));
	}

	async disconnect(
		workspaceId: string,
		agentId: string,
		id: string,
		actor: string,
	) {
		const grant = /^[0-9a-f-]{36}$/.test(id)
			? await this.repository.getGrant(id)
			: null;
		if (
			!grant ||
			grant.workspaceId !== workspaceId ||
			grant.agentId !== agentId ||
			!this.live(grant)
		)
			throw new SignInError("Connection not found.", 404);
		await this.remove(grant, "Disconnected in the dashboard.", actor);
	}

	/** Ends every connection of an agent, when it is revoked. */
	disconnectAll(workspaceId: string, agentId: string) {
		return this.repository.removeGrants(workspaceId, agentId);
	}

	close() {
		return this.repository.close();
	}
}

/** `uri` with the given query parameters added; null values are left out. */
function redirectWith(uri: string, params: Record<string, string | null>) {
	const url = new URL(uri);
	for (const [key, value] of Object.entries(params))
		if (value !== null) url.searchParams.set(key, value);
	return url.href;
}
