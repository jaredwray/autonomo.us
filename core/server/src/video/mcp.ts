import {
	VIDEO_ASPECT_RATIOS,
	VIDEO_LIMITS,
	VIDEO_RESOLUTIONS,
	type VideoGenerateRequest,
	type VideoJob,
	type VideoJobList,
	type VideoModelList,
	videoDurationsText,
} from "@autonomo.us/common";
import {
	type McpAgent,
	type McpCallContext,
	type McpToolDefinition,
	type McpToolSet,
	requireGrant,
	schema,
} from "../mcp/server.js";
import { ServiceError } from "../service-error.js";
import type { VideoService } from "./service.js";

export const VIDEO_MCP_INSTRUCTIONS =
	"video_generate starts a video from a prompt on the workspace's video providers and returns a job id at once; a video takes from half a minute to several minutes. video_status says how the job is going and, when it is done, gives a link to the MP4. video_models lists what this workspace can make. Videos cost the workspace money, so make one only when asked to.";

/** How long an MCP agent's status call may wait. */
const MCP_WAIT_MS = 90_000;
const JOB_ID = {
	type: "string",
	description: "The job's id, vid_ followed by a UUID.",
	pattern: "^vid_[0-9a-f-]{36}$",
} as const;

export const VIDEO_MCP_TOOLS: McpToolDefinition[] = [
	{
		name: "video_models",
		description:
			"Lists the video providers and models this workspace can use, with the durations, aspect ratios, and resolutions each makes. Needs no grant beyond MCP: Call.",
		inputSchema: schema({}),
	},
	{
		name: "video_generate",
		description:
			"Starts one video from a prompt and returns its job at once. Check it with video_status. Leave provider and model out to use the workspace's default. Needs the video:generate grant.",
		inputSchema: schema(
			{
				prompt: {
					type: "string",
					description:
						"What the video shows: subject, action, setting, camera, and sound.",
					minLength: 1,
					maxLength: VIDEO_LIMITS.promptLength,
				},
				provider: {
					type: "string",
					description: "A video connection's name from video_models.",
					maxLength: 64,
				},
				model: {
					type: "string",
					description: "A model id from video_models.",
					maxLength: 100,
				},
				durationSeconds: {
					type: "integer",
					description: "Whole seconds. Each model allows its own range.",
					minimum: VIDEO_LIMITS.minDurationSeconds,
					maximum: VIDEO_LIMITS.maxDurationSeconds,
				},
				aspectRatio: {
					type: "string",
					description: "16:9 (landscape), 9:16 (portrait), or 1:1.",
					enum: VIDEO_ASPECT_RATIOS,
				},
				resolution: {
					type: "string",
					description: "The output resolution.",
					enum: VIDEO_RESOLUTIONS,
				},
				imageUrl: {
					type: "string",
					description:
						"An https image to start from, for models that take one. The provider downloads it.",
					maxLength: VIDEO_LIMITS.urlLength,
				},
			},
			["prompt"],
		),
	},
	{
		name: "video_status",
		description:
			"Says how one of your video jobs is going and, when it has finished, gives the link to the MP4. Pass waitSeconds to wait for it to finish. Needs the video:generate grant.",
		inputSchema: schema(
			{
				id: JOB_ID,
				waitSeconds: {
					type: "integer",
					description: `Wait up to this many seconds for the job to finish. Default 0, at most ${VIDEO_LIMITS.maxWaitSeconds}.`,
					minimum: 0,
					maximum: VIDEO_LIMITS.maxWaitSeconds,
				},
			},
			["id"],
		),
	},
	{
		name: "video_cancel",
		description:
			"Stops one of your video jobs. Its estimated cost stays counted. Needs the video:generate grant.",
		inputSchema: schema({ id: JOB_ID }, ["id"]),
	},
	{
		name: "video_list",
		description:
			"Lists your own video jobs, newest first. Needs the video:generate grant.",
		inputSchema: schema({
			limit: {
				type: "integer",
				description: `How many jobs to list. Default ${VIDEO_LIMITS.defaultListLimit}.`,
				minimum: 1,
				maximum: VIDEO_LIMITS.maxAgentListLimit,
			},
		}),
	},
];

const money = (usd: number) => `$${usd.toFixed(2)}`;

/** A job as one or two readable lines. */
export function videoJobText(job: VideoJob): string {
	const made = `${job.provider} (${job.model}): ${job.durationSeconds} s, ${job.resolution}, ${job.aspectRatio}`;
	const cost = `Estimated cost ${money(job.costUsd)}.`;
	switch (job.status) {
		case "queued":
		case "running":
			return `Video ${job.id} is ${job.status}${job.progress !== null ? ` (${job.progress}%)` : ""} on ${made}. ${cost} Check again with video_status; pass waitSeconds to wait.`;
		case "succeeded":
			return `Video ${job.id} is ready: ${job.video?.url ?? ""} (MP4, made by ${made}). The link works until ${job.video?.expiresAt ?? "the provider deletes it"}. ${cost}`;
		case "expired":
			return `Video ${job.id} was made by ${made}, but the provider no longer keeps it. ${cost}`;
		case "canceled":
			return `Video ${job.id} was canceled. ${cost}`;
		default: {
			const tried = job.attempts
				.map(
					(attempt) =>
						`${attempt.provider} ${attempt.model}: ${attempt.outcome}${attempt.detail ? ` (${attempt.detail})` : ""}`,
				)
				.join("; ");
			const reason = (job.error?.message ?? "no reason given").replace(
				/[.\s]+$/,
				"",
			);
			return `Video ${job.id} failed: ${reason}.${tried ? ` Tried: ${tried}.` : ""}`;
		}
	}
}

export function videoModelsText(list: VideoModelList): string {
	if (!list.available)
		return list.reason ?? "This workspace cannot make videos now.";
	const lines = list.providers.map(
		(provider) =>
			`${provider.name} (${provider.kind}, default ${provider.defaultModel}): ${provider.models
				.map(
					(model) =>
						`${model.id} — ${videoDurationsText(model)} s, ${model.aspectRatios.join("/")}, ${model.resolutions.join("/")}${model.inputs.includes("image") ? ", can start from an image" : ""}${model.audio ? ", with sound" : ""}`,
				)
				.join("; ")}`,
	);
	return [
		`This agent may make videos of up to ${list.limits.maxDurationSeconds} seconds${
			list.limits.modelMaxDurationSeconds
				? ` (${Object.entries(list.limits.modelMaxDurationSeconds)
						.map(([model, seconds]) => `${model}: up to ${seconds}`)
						.join("; ")})`
				: ""
		}.${list.canGenerate ? "" : " This agent lacks the video:generate grant, so it cannot start one."}`,
		...lines,
	].join("\n");
}

function videoListText(list: VideoJobList): string {
	if (!list.jobs.length) return "You have no video jobs.";
	return list.jobs.map(videoJobText).join("\n");
}

const callerOf = (agent: McpAgent) => ({
	id: `agent:${agent.token.id}`,
	name: agent.token.name,
	kind: "agent" as const,
});

function originOf(context?: McpCallContext): string {
	if (!context?.origin)
		throw new ServiceError("Video tools need the gateway's address.", 500);
	return context.origin;
}

/** The `video_*` tools for agents over MCP. Bots do not get them. */
export function videoToolSet(video: VideoService): McpToolSet {
	return {
		instructions: VIDEO_MCP_INSTRUCTIONS,
		tools: VIDEO_MCP_TOOLS,
		handlers: {
			video_models: async (agent) =>
				video.models(
					agent.workspace,
					agent.token.permissions.includes("video:generate"),
					callerOf(agent),
				),
			video_generate: async (agent, args, context) => {
				requireGrant(agent, "video:generate");
				const request: VideoGenerateRequest = {
					prompt: args.prompt as string,
					...(args.provider !== undefined
						? { provider: args.provider as string }
						: {}),
					...(args.model !== undefined ? { model: args.model as string } : {}),
					...(args.durationSeconds !== undefined
						? { durationSeconds: args.durationSeconds as number }
						: {}),
					...(args.aspectRatio !== undefined
						? {
								aspectRatio:
									args.aspectRatio as VideoGenerateRequest["aspectRatio"],
							}
						: {}),
					...(args.resolution !== undefined
						? {
								resolution:
									args.resolution as VideoGenerateRequest["resolution"],
							}
						: {}),
					...(args.imageUrl !== undefined
						? { imageUrl: args.imageUrl as string }
						: {}),
				};
				return video.generate(agent.workspace, callerOf(agent), request, {
					origin: originOf(context),
				});
			},
			video_status: async (agent, args, context) => {
				requireGrant(agent, "video:generate");
				return video.status(
					agent.workspace,
					{ ownOnly: callerOf(agent).id },
					args.id as string,
					{
						...(args.waitSeconds !== undefined
							? { waitSeconds: args.waitSeconds as number }
							: {}),
					},
					{
						origin: originOf(context),
						deadline: context?.deadline ?? Date.now() + MCP_WAIT_MS,
						...(context?.signal ? { signal: context.signal } : {}),
					},
				);
			},
			video_cancel: async (agent, args, context) => {
				requireGrant(agent, "video:generate");
				return video.cancel(
					agent.workspace,
					{ ownOnly: callerOf(agent).id },
					args.id as string,
					{ origin: originOf(context) },
				);
			},
			video_list: async (agent, args, context) => {
				requireGrant(agent, "video:generate");
				return video.list(
					agent.workspace,
					{ ownOnly: callerOf(agent).id },
					{
						limit: Math.min(
							(args.limit as number | undefined) ??
								VIDEO_LIMITS.defaultListLimit,
							VIDEO_LIMITS.maxAgentListLimit,
						),
					},
					{ origin: originOf(context) },
				);
			},
		},
		text: (name, result) => {
			switch (name) {
				case "video_models":
					return videoModelsText(result as VideoModelList);
				case "video_list":
					return videoListText(result as VideoJobList);
				case "video_generate":
				case "video_status":
				case "video_cancel":
					return videoJobText(result as VideoJob);
				default:
					return undefined;
			}
		},
	};
}
