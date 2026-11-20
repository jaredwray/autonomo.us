import {
	type CreateVideoConnectionRequest,
	type UpdateVideoConnectionRequest,
	type UpdateVideoPolicyRequest,
	VIDEO_ASPECT_RATIOS,
	VIDEO_KINDS,
	VIDEO_LIMITS,
	VIDEO_RESOLUTIONS,
	type VideoGenerateRequest,
	type VideoSettings,
} from "@autonomo.us/common";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { requestMay, requestWorkspace } from "../auth/access.js";
import { mongoErrorDetails } from "../mongo.js";
import { ServiceError } from "../service-error.js";
import {
	VIDEO_TOKEN_PATTERN,
	type VideoCaller,
	type VideoService,
} from "../video/service.js";
import type { VideoStore } from "../video/store.js";

/** How long a status call from the dashboard or a script may wait. */
const REST_WAIT_MS = 75_000;
const JOB_ID = { type: "string", pattern: "^vid_[0-9a-f-]{36}$" };
const name = { type: "string", minLength: 1, maxLength: 64 };
const nameParams = { type: "object", required: ["name"], properties: { name } };
const idParams = {
	type: "object",
	required: ["id"],
	properties: { id: JOB_ID },
};
const connectionFields = {
	apiKey: { type: "string", maxLength: VIDEO_LIMITS.keyLength },
	enabled: { type: "boolean" },
	defaultModel: { type: "string", maxLength: 100 },
	creditPriceUsd: {
		type: "number",
		minimum: 0,
		maximum: VIDEO_LIMITS.maxCreditPriceUsd,
	},
};
const policySchema = {
	type: "object",
	additionalProperties: false,
	required: ["order", "callerVideosPerDay", "maxDurationSeconds", "revision"],
	properties: {
		order: { type: "array", maxItems: VIDEO_LIMITS.connections, items: name },
		callerVideosPerDay: { type: "integer" },
		/** Moved to budgets; listed so it is refused, not silently dropped. */
		monthlyBudgetUsd: {},
		maxDurationSeconds: { type: "integer" },
		revision: { type: "integer", minimum: 0 },
	},
};
const generateSchema = {
	type: "object",
	additionalProperties: false,
	required: ["prompt"],
	properties: {
		prompt: {
			type: "string",
			minLength: 1,
			maxLength: VIDEO_LIMITS.promptLength,
		},
		provider: { type: "string", minLength: 1, maxLength: 64 },
		model: { type: "string", minLength: 1, maxLength: 100 },
		durationSeconds: {
			type: "integer",
			minimum: VIDEO_LIMITS.minDurationSeconds,
			maximum: VIDEO_LIMITS.maxDurationSeconds,
		},
		aspectRatio: { enum: VIDEO_ASPECT_RATIOS },
		resolution: { enum: VIDEO_RESOLUTIONS },
		imageUrl: {
			type: "string",
			minLength: 1,
			maxLength: VIDEO_LIMITS.urlLength,
		},
	},
};

/** Errors as `{ error: { message } }`, never a provider's words or a key on a 500. */
function errorHandler(server: FastifyInstance) {
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
				"Video request failed",
			);
		return reply.code(status).send({
			error: {
				message:
					status < 500 || error instanceof ServiceError
						? String(failure.message)
						: "Video hit an unexpected error.",
			},
		});
	});
}

/** Ends a wait when the client hangs up. */
function closeSignal(reply: FastifyReply) {
	const controller = new AbortController();
	reply.raw.once("close", () => {
		if (!reply.raw.writableFinished) controller.abort();
	});
	return controller.signal;
}

/**
 * Video connections, settings, and jobs under `/v1/:workspace`. Members read
 * the settings; workspace admins change them and start videos, since every
 * video spends the workspace's money. An API token or a person sees every
 * job in the workspace; agents use the MCP tools and see their own.
 */
export async function videoRoutes(
	server: FastifyInstance,
	{
		store,
		video,
		origin,
	}: {
		store: VideoStore;
		video: VideoService;
		/** The gateway's public address, for download links. */
		origin: (request: FastifyRequest) => string;
	},
) {
	server.addHook("onRequest", async (_request, reply) => {
		reply.header("cache-control", "no-store");
	});
	errorHandler(server);
	const caller = (request: FastifyRequest): VideoCaller =>
		request.telemetryCaller ?? {
			id: "unattributed",
			name: "Unattributed",
			kind: "unattributed",
		};
	/** Settings change only while video is on; reading them says whether it is. */
	const refuseWhenDisabled = () => {
		if (!video.available)
			throw new ServiceError(
				"Video generation is turned off on this gateway.",
				503,
			);
	};

	server.get(
		"/video",
		(request): Promise<VideoSettings> =>
			video.settings(requestWorkspace(request)),
	);
	server.get("/video/models", (request) =>
		video.models(
			requestWorkspace(request),
			requestMay(request, "video:generate"),
		),
	);
	server.post<{ Body: CreateVideoConnectionRequest }>(
		"/video/connections",
		{
			schema: {
				body: {
					type: "object",
					additionalProperties: false,
					required: ["name", "kind", "apiKey"],
					properties: {
						...connectionFields,
						name,
						kind: { enum: VIDEO_KINDS },
					},
				},
			},
		},
		async (request, reply) => {
			refuseWhenDisabled();
			const created = await store.create(
				requestWorkspace(request),
				request.body,
			);
			return reply.code(201).send(created);
		},
	);
	server.patch<{
		Params: { name: string };
		Body: UpdateVideoConnectionRequest;
	}>(
		"/video/connections/:name",
		{
			schema: {
				params: nameParams,
				body: {
					type: "object",
					additionalProperties: false,
					properties: connectionFields,
				},
			},
		},
		async (request) => {
			refuseWhenDisabled();
			const updated = await store.update(
				requestWorkspace(request),
				request.params.name,
				request.body ?? {},
			);
			return updated;
		},
	);
	server.delete<{ Params: { name: string } }>(
		"/video/connections/:name",
		{ schema: { params: nameParams } },
		async (request, reply) => {
			refuseWhenDisabled();
			await store.remove(requestWorkspace(request), request.params.name);
			return reply.code(204).send();
		},
	);
	server.put<{ Body: UpdateVideoPolicyRequest }>(
		"/video/policy",
		{ schema: { body: policySchema } },
		async (request) => {
			refuseWhenDisabled();
			if ("monthlyBudgetUsd" in (request.body as object))
				throw new ServiceError(
					"The monthly video budget is a budget now. Change it with PATCH /v1/<workspace>/budgets/<id>, or on the Models page under Budget.",
				);
			const policy = await store.updatePolicy(
				requestWorkspace(request),
				request.body,
			);
			return policy;
		},
	);
	server.post<{ Body: VideoGenerateRequest }>(
		"/video/jobs",
		{ schema: { body: generateSchema } },
		async (request, reply) => {
			const job = await video.generate(
				requestWorkspace(request),
				caller(request),
				request.body,
				{ origin: origin(request) },
			);
			return reply.code(202).send(job);
		},
	);
	server.get<{ Querystring: { limit?: number; before?: string } }>(
		"/video/jobs",
		{
			schema: {
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: {
						limit: {
							type: "integer",
							minimum: 1,
							maximum: VIDEO_LIMITS.maxListLimit,
						},
						before: JOB_ID,
					},
				},
			},
		},
		(request) =>
			video.list(
				requestWorkspace(request),
				{},
				{
					...(request.query.limit !== undefined
						? { limit: request.query.limit }
						: {}),
					...(request.query.before ? { before: request.query.before } : {}),
				},
				{ origin: origin(request) },
			),
	);
	server.get<{ Params: { id: string }; Querystring: { wait?: number } }>(
		"/video/jobs/:id",
		{
			schema: {
				params: idParams,
				querystring: {
					type: "object",
					additionalProperties: false,
					properties: {
						wait: {
							type: "integer",
							minimum: 0,
							maximum: VIDEO_LIMITS.maxWaitSeconds,
						},
					},
				},
			},
		},
		(request, reply) =>
			video.status(
				requestWorkspace(request),
				{},
				request.params.id,
				{
					...(request.query.wait !== undefined
						? { waitSeconds: request.query.wait }
						: {}),
				},
				{
					origin: origin(request),
					deadline: Date.now() + REST_WAIT_MS,
					signal: closeSignal(reply),
				},
			),
	);
	server.post<{ Params: { id: string } }>(
		"/video/jobs/:id/cancel",
		{ schema: { params: idParams } },
		(request) =>
			video.cancel(requestWorkspace(request), {}, request.params.id, {
				origin: origin(request),
			}),
	);
}

/** A request URL with a video link's token masked, for logs. */
export function redactDownloadUrl(url: string): string {
	return url.replace(/^(\/video\/downloads\/)[^/?#]+/, "$1[token]");
}

/**
 * `GET /video/downloads/:token`, outside `/v1`: the link in a finished job.
 * The token is the capability, so an agent, which cannot call `/v1`, can
 * still hand the link on. Nothing a provider returns may render as a page
 * on the gateway's origin, which also serves the dashboard.
 */
export async function videoDownloadRoutes(
	server: FastifyInstance,
	{ video }: { video: VideoService },
) {
	errorHandler(server);
	server.get<{ Params: { token: string } }>(
		"/video/downloads/:token",
		{
			schema: {
				params: {
					type: "object",
					required: ["token"],
					properties: { token: { type: "string", maxLength: 64 } },
				},
			},
		},
		async (request, reply) => {
			reply.header("cache-control", "private, no-store");
			reply.header("referrer-policy", "no-referrer");
			reply.header("x-content-type-options", "nosniff");
			const notFound = () =>
				reply.code(404).send({ error: { message: "Video not found." } });
			if (!VIDEO_TOKEN_PATTERN.test(request.params.token)) return notFound();
			const controller = new AbortController();
			reply.raw.once("close", () => {
				if (!reply.raw.writableFinished) controller.abort();
			});
			const result = await video.download(
				request.params.token,
				controller.signal,
			);
			if (!result) return notFound();
			switch (result.kind) {
				case "redirect":
					return reply.redirect(result.url, 302);
				case "gone":
					return reply
						.code(410)
						.send({ error: { message: "This video has expired." } });
				case "error":
					return reply.code(502).send({ error: { message: result.detail } });
				default:
					return reply
						.code(200)
						.header("content-type", "video/mp4")
						.header("content-security-policy", "default-src 'none'; sandbox")
						.header(
							"content-disposition",
							`attachment; filename="${result.filename}"`,
						)
						.header("content-length", String(result.bytes.byteLength))
						.send(
							Buffer.from(
								result.bytes.buffer,
								result.bytes.byteOffset,
								result.bytes.byteLength,
							),
						);
			}
		},
	);
}
