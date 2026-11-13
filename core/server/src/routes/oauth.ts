import type { FastifyInstance, FastifyRequest } from "fastify";
import {
	mcpResource,
	OAUTH_SCOPES,
	OAuthError,
	type OAuthService,
} from "../oauth/oauth.js";
import { ServiceError } from "../service-error.js";

export type OAuthRouteOptions = {
	oauth: OAuthService;
	/** The address the request reached the gateway at, without a path. */
	origin(request: FastifyRequest): string;
	/** Where people approve a sign-in; the gateway's own address when unset. */
	dashboardUrl?: string;
};

/** Where an MCP app finds this metadata when a request lacks a valid token. */
export const resourceMetadataUrl = (origin: string) =>
	`${origin}/.well-known/oauth-protected-resource/mcp`;

/**
 * OAuth 2.1 for the MCP endpoint, as the MCP authorization spec asks:
 * protected-resource metadata (RFC 9728), authorization-server metadata
 * (RFC 8414), dynamic client registration (RFC 7591), the authorization code
 * flow with PKCE, refresh, and revocation (RFC 7009). These routes are public:
 * nothing is granted until a workspace admin approves in the dashboard.
 */
export async function oauthRoutes(
	server: FastifyInstance,
	{ oauth, origin, dashboardUrl }: OAuthRouteOptions,
) {
	// Token and revocation requests arrive as HTML form data.
	server.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string", bodyLimit: 16_384 },
		(_request, payload, done) =>
			done(null, Object.fromEntries(new URLSearchParams(String(payload)))),
	);
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.setErrorHandler((error: unknown, request, reply) => {
		if (error instanceof OAuthError)
			return reply
				.code(error.statusCode)
				.send({ error: error.error, error_description: error.message });
		const status = (error as { statusCode?: unknown }).statusCode;
		if (error instanceof ServiceError || typeof status !== "number") {
			if (!(error instanceof ServiceError)) request.log.error(error);
			return reply.code(503).send({
				error: "temporarily_unavailable",
				error_description: "OAuth sign-in is unavailable. Try again.",
			});
		}
		// A body Fastify could not read, or one that is too large.
		return reply.code(status >= 400 && status < 500 ? status : 400).send({
			error: "invalid_request",
			error_description: "The request could not be read.",
		});
	});

	const resource = (request: FastifyRequest) => {
		const base = origin(request);
		return {
			resource: mcpResource(base),
			authorization_servers: [base],
			scopes_supported: OAUTH_SCOPES,
			bearer_methods_supported: ["header"],
			resource_name: "autonomo.us",
		};
	};
	server.get("/.well-known/oauth-protected-resource", resource);
	server.get("/.well-known/oauth-protected-resource/mcp", resource);

	const metadata = (request: FastifyRequest) => {
		const base = origin(request);
		return {
			issuer: base,
			authorization_endpoint: `${base}/oauth/authorize`,
			token_endpoint: `${base}/oauth/token`,
			registration_endpoint: `${base}/oauth/register`,
			revocation_endpoint: `${base}/oauth/revoke`,
			scopes_supported: OAUTH_SCOPES,
			response_types_supported: ["code"],
			response_modes_supported: ["query"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			token_endpoint_auth_methods_supported: ["none"],
			revocation_endpoint_auth_methods_supported: ["none"],
			code_challenge_methods_supported: ["S256"],
		};
	};
	server.get("/.well-known/oauth-authorization-server", metadata);
	// Apps that follow an earlier MCP revision look beside the MCP endpoint.
	server.get("/.well-known/oauth-authorization-server/mcp", metadata);

	server.post("/oauth/register", async (request, reply) =>
		reply.code(201).send(await oauth.register(request.body)),
	);

	server.get<{ Querystring: Record<string, unknown> }>(
		"/oauth/authorize",
		async (request, reply) => {
			const base = origin(request);
			const result = await oauth.authorize(request.query, base);
			if ("page" in result)
				return reply
					.code(400)
					.header("content-type", "text/plain; charset=utf-8")
					.header("x-content-type-options", "nosniff")
					.send(result.page);
			return reply.redirect(
				"redirect" in result
					? result.redirect
					: // The dashboard holds the person's session; it shows the decision.
						`${dashboardUrl ?? base}/#/authorize/${result.request}`,
				302,
			);
		},
	);

	const form = (request: FastifyRequest) => {
		const body = request.body;
		if (body === null || typeof body !== "object" || Array.isArray(body))
			throw new OAuthError(
				"invalid_request",
				"Send the parameters as application/x-www-form-urlencoded.",
			);
		const input = { ...(body as Record<string, unknown>) };
		// A public client may name itself in HTTP Basic with an empty password.
		const basic = /^Basic (\S+)$/i.exec(request.headers.authorization ?? "");
		if (basic && input.client_id === undefined) {
			const [id] = Buffer.from(basic[1], "base64").toString().split(":");
			input.client_id = decodeURIComponent(id);
		}
		return input;
	};
	server.post("/oauth/token", async (request, reply) => {
		reply.header("pragma", "no-cache");
		return oauth.token(form(request), origin(request));
	});
	server.post("/oauth/revoke", async (request, reply) => {
		const token = form(request).token;
		if (typeof token === "string") await oauth.revoke(token);
		return reply.code(200).send({});
	});
}
