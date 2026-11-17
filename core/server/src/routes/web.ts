import {
	type AgentWakeActor,
	type CreateProxyRequest,
	PROXY_KINDS,
	type ProxyList,
	type ProxyTestRequest,
	type UpdateProxyRequest,
	type UpdateWebPolicyRequest,
	WEB_LIMITS,
	type WebFetchRequest,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestActor, requestWorkspace } from "../auth/access.js";
import { mongoErrorDetails } from "../mongo.js";
import { ServiceError } from "../service-error.js";
import type { WebCaller, WebService } from "../web/service.js";
import type { ProxyStore } from "../web/store.js";

const LEVELS = [
	"auto",
	"basic",
	"render",
	"premium",
	"render-premium",
	"unlock",
];
/** How long a fetch from the dashboard or a script may take. */
const REST_FETCH_MS = 120_000;

const name = { type: "string", minLength: 1, maxLength: 64 };
const nameParams = {
	type: "object",
	required: ["name"],
	properties: { name },
};
const optionalString = (maxLength: number) => ({ type: "string", maxLength });
const proxyFields = {
	apiKey: optionalString(WEB_LIMITS.keyLength),
	accountId: optionalString(64),
	zone: optionalString(64),
	country: optionalString(2),
	pricePer1000Usd: { type: "number", minimum: 0, maximum: 1000 },
	monthlyRequestCap: {
		type: ["integer", "null"],
		minimum: 0,
		maximum: WEB_LIMITS.maxMonthlyRequestCap,
	},
	enabled: { type: "boolean" },
};
const step = {
	type: "object",
	required: ["kind"],
	additionalProperties: false,
	properties: {
		kind: { enum: ["direct", "proxy"] },
		connection: name,
		level: { enum: LEVELS },
	},
};
const policySchema = {
	type: "object",
	additionalProperties: false,
	required: [
		"ladder",
		"domains",
		"allowOnly",
		"callerProxyRequestsPerDay",
		"monthlyBudgetUsd",
		"revision",
	],
	properties: {
		ladder: { type: "array", maxItems: WEB_LIMITS.ladderSteps, items: step },
		domains: {
			type: "array",
			maxItems: WEB_LIMITS.domainRules,
			items: {
				type: "object",
				additionalProperties: false,
				required: ["match", "rule"],
				properties: {
					match: { type: "string", minLength: 1, maxLength: 253 },
					rule: { enum: ["deny", "start-at-proxy", "direct-only", "allow"] },
				},
			},
		},
		allowOnly: { type: "boolean" },
		callerProxyRequestsPerDay: { type: "integer" },
		monthlyBudgetUsd: { type: "number" },
		revision: { type: "integer", minimum: 0 },
	},
};
const fetchSchema = {
	type: "object",
	additionalProperties: false,
	required: ["url"],
	properties: {
		url: { type: "string", minLength: 1, maxLength: WEB_LIMITS.urlLength },
		format: { enum: ["markdown", "html"] },
		maxChars: {
			type: "integer",
			minimum: WEB_LIMITS.minChars,
			maximum: WEB_LIMITS.maxChars,
		},
		skipDirect: { type: "boolean" },
		render: { type: "boolean" },
	},
};

/**
 * Proxy connections and web settings under `/v1/:workspace`. Members read
 * them; workspace admins add proxies, change keys and the policy, and run
 * fetches, since every proxied fetch spends the workspace's money.
 */
export async function webRoutes(
	server: FastifyInstance,
	{
		store,
		web,
		onChanged,
	}: {
		store: ProxyStore;
		web: WebService;
		/**
		 * Called once the policy or a proxy is saved or removed; the change
		 * stands whatever this does.
		 */
		onChanged?: (
			workspaceId: string,
			change: "policy" | "proxies",
			by: AgentWakeActor,
		) => Promise<unknown>;
	},
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	server.setErrorHandler((error: unknown, request, reply) => {
		const failure = error as { statusCode?: unknown; message?: unknown };
		const status =
			typeof failure.statusCode === "number" && failure.statusCode >= 400
				? failure.statusCode
				: 500;
		if (status >= 500)
			request.log.error(
				error instanceof ServiceError
					? { ...mongoErrorDetails(error), message: error.message }
					: error,
				"Proxies request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof ServiceError
						? String(failure.message)
						: "Proxies hit an unexpected error.",
			},
		});
	});

	const changed = async (
		request: FastifyRequest,
		change: "policy" | "proxies",
	) => {
		await onChanged?.(
			requestWorkspace(request).id,
			change,
			requestActor(request),
		).catch(() => {});
	};
	const caller = (request: FastifyRequest): WebCaller =>
		request.telemetryCaller ?? {
			id: "unattributed",
			name: "Unattributed",
			kind: "unattributed",
		};
	/** Ends the fetch when the client hangs up. */
	const closeSignal = (reply: FastifyReply) => {
		const controller = new AbortController();
		reply.raw.once("close", () => {
			if (!reply.raw.writableFinished) controller.abort();
		});
		return controller.signal;
	};

	server.get("/proxies", async (request): Promise<ProxyList> => {
		const workspace = requestWorkspace(request);
		const policy = await store.policy(workspace);
		const [connections, budget] = await Promise.all([
			store.list(workspace),
			store.budget(workspace, policy),
		]);
		return {
			connections,
			policy,
			budget,
			persistence: store.persistence,
			available: web.available,
		};
	});
	server.post<{ Body: CreateProxyRequest }>(
		"/proxies",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "kind", "apiKey"],
					properties: { ...proxyFields, name, kind: { enum: PROXY_KINDS } },
				},
			},
		},
		async (request, reply) => {
			const created = await store.create(
				requestWorkspace(request),
				request.body,
			);
			await changed(request, "proxies");
			return reply.code(201).send(created);
		},
	);
	server.patch<{ Params: { name: string }; Body: UpdateProxyRequest }>(
		"/proxies/:name",
		{
			schema: {
				params: nameParams,
				body: {
					type: "object",
					additionalProperties: false,
					properties: proxyFields,
				},
			},
		},
		async (request) => {
			const updated = await store.update(
				requestWorkspace(request),
				request.params.name,
				request.body,
			);
			await changed(request, "proxies");
			return updated;
		},
	);
	server.delete<{ Params: { name: string } }>(
		"/proxies/:name",
		{ schema: { params: nameParams } },
		async (request, reply) => {
			await store.remove(requestWorkspace(request), request.params.name);
			await changed(request, "proxies");
			return reply.code(204).send();
		},
	);
	server.post<{ Params: { name: string }; Body: ProxyTestRequest }>(
		"/proxies/:name/test",
		{
			schema: {
				params: nameParams,
				body: {
					type: "object",
					additionalProperties: false,
					properties: {
						url: { type: "string", maxLength: WEB_LIMITS.urlLength },
						level: { enum: LEVELS },
					},
				},
			},
		},
		(request, reply) =>
			web.test(
				requestWorkspace(request),
				caller(request),
				request.params.name,
				request.body ?? {},
				{ deadline: Date.now() + REST_FETCH_MS, signal: closeSignal(reply) },
			),
	);
	server.get("/web/policy", (request) =>
		store.policy(requestWorkspace(request)),
	);
	server.put<{ Body: UpdateWebPolicyRequest }>(
		"/web/policy",
		{ schema: { body: policySchema } },
		async (request) => {
			const policy = await store.updatePolicy(
				requestWorkspace(request),
				request.body,
			);
			await changed(request, "policy");
			return policy;
		},
	);
	server.post<{ Body: WebFetchRequest }>(
		"/web/fetch",
		{ schema: { body: fetchSchema } },
		(request, reply) =>
			web.fetch(requestWorkspace(request), caller(request), request.body, {
				deadline: Date.now() + REST_FETCH_MS,
				signal: closeSignal(reply),
			}),
	);
}
