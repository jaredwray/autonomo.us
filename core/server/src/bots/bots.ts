import { randomUUID } from "node:crypto";
import {
	BOT_LIMITS,
	type Bot,
	type BotActivity,
	type BotDetails,
	type BotLimits,
	type BotList,
	type BotSummary,
	type CreateBotRequest,
	DEFAULT_BOT_LIMITS,
	type UpdateBotRequest,
} from "@autonomo.us/common";
import { BotError } from "./errors.js";
import type { BotRepository } from "./repository.js";

const HOUR_MS = 3_600_000;
const RUNS_SHOWN = 50;
const PENDING_SHOWN_MS = 120_000;
const MAX_MODEL_LENGTH = 200;

/** The start of the current UTC day: token budgets reset there. */
export const startOfDay = (now: number) =>
	new Date(new Date(now).setUTCHours(0, 0, 0, 0)).toISOString();

const whole = (
	value: unknown,
	minimum: number,
	maximum: number,
	name: string,
) => {
	if (
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < minimum ||
		value > maximum
	)
		throw new BotError(
			`${name} must be a whole number from ${minimum} to ${maximum}.`,
		);
	return value;
};

/**
 * The bots of a workspace: who they are and how they are limited. Running
 * them is the runner's job (runner.ts).
 */
export class BotService {
	constructor(
		private readonly repository: BotRepository,
		private readonly now: () => number = Date.now,
	) {}
	get persistence() {
		return this.repository.persistence;
	}
	private at() {
		return new Date(this.now()).toISOString();
	}

	private limits(input: Partial<BotLimits> | undefined, base: BotLimits) {
		const merged = { ...base, ...input };
		return {
			repliesPerHour: whole(
				merged.repliesPerHour,
				1,
				BOT_LIMITS.maxRepliesPerHour,
				"Replies an hour",
			),
			tokensPerDay: whole(
				merged.tokensPerDay,
				1,
				1_000_000_000,
				"Tokens a day",
			),
			maxOutputTokens: whole(
				merged.maxOutputTokens,
				1,
				BOT_LIMITS.maxOutputTokens,
				"Output tokens",
			),
			contextMessages: whole(
				merged.contextMessages,
				1,
				BOT_LIMITS.maxContextMessages,
				"Context messages",
			),
		};
	}
	/** Applies the fields of `input` that are present to `bot`, validated. */
	private apply(bot: Bot, input: UpdateBotRequest) {
		if (input.name !== undefined) {
			const name = typeof input.name === "string" ? input.name.trim() : "";
			if (!name || name.length > BOT_LIMITS.nameLength)
				throw new BotError(
					`A bot's name is 1–${BOT_LIMITS.nameLength} characters.`,
				);
			bot.name = name;
		}
		if (input.instructions !== undefined) {
			if (
				typeof input.instructions !== "string" ||
				input.instructions.length > BOT_LIMITS.instructionsLength
			)
				throw new BotError(
					`Instructions are at most ${BOT_LIMITS.instructionsLength} characters.`,
				);
			bot.instructions = input.instructions;
		}
		if (input.model !== undefined) {
			const model = typeof input.model === "string" ? input.model.trim() : "";
			if (!model || model.length > MAX_MODEL_LENGTH)
				throw new BotError("Choose the model this bot answers with.");
			bot.model = model;
		}
		if (input.enabled !== undefined) bot.enabled = input.enabled === true;
		if (input.tools !== undefined) bot.tools = input.tools === true;
		if (input.agentHops !== undefined)
			bot.agentHops = whole(
				input.agentHops,
				0,
				BOT_LIMITS.maxAgentHops,
				"Bot-to-bot replies",
			);
		if (input.limits !== undefined)
			bot.limits = this.limits(input.limits, bot.limits);
	}

	private async summary(bot: Bot): Promise<BotSummary> {
		const [repliesLastHour, tokensToday] = await Promise.all([
			this.repository.countRunsSince(
				bot.id,
				new Date(this.now() - HOUR_MS).toISOString(),
			),
			this.repository.tokensSince(bot.id, startOfDay(this.now())),
		]);
		return { ...bot, repliesLastHour, tokensToday };
	}

	async list(workspaceId: string): Promise<BotList> {
		const bots = await this.repository.listBots(workspaceId);
		return {
			bots: await Promise.all(bots.map((bot) => this.summary(bot))),
			persistence: this.repository.persistence,
		};
	}
	/** The workspace's bots without usage, for agent lists. */
	bots(workspaceId: string): Promise<Bot[]> {
		return this.repository.listBots(workspaceId);
	}
	private async find(workspaceId: string, id: string): Promise<Bot> {
		const bot = await this.repository.getBot(workspaceId, id);
		if (!bot) throw new BotError("Bot not found.", 404);
		return bot;
	}
	async get(workspaceId: string, id: string): Promise<BotDetails> {
		const bot = await this.find(workspaceId, id);
		const [summary, runs] = await Promise.all([
			this.summary(bot),
			this.repository.listRuns(workspaceId, id, RUNS_SHOWN),
		]);
		return { ...summary, runs };
	}

	async create(
		workspaceId: string,
		input: CreateBotRequest,
		actorName: string,
	): Promise<BotDetails> {
		const existing = await this.repository.listBots(workspaceId);
		if (existing.length >= BOT_LIMITS.bots)
			throw new BotError(`A workspace holds at most ${BOT_LIMITS.bots} bots.`);
		const at = this.at();
		const bot: Bot = {
			id: randomUUID(),
			workspaceId,
			name: "",
			instructions: "",
			model: "",
			enabled: true,
			agentHops: 0,
			tools: false,
			limits: DEFAULT_BOT_LIMITS,
			createdAt: at,
			createdBy: actorName,
			updatedAt: at,
			revision: 1,
		};
		this.apply(bot, {
			...input,
			name: input.name ?? "",
			instructions: input.instructions ?? "",
			model: input.model ?? "",
		});
		// Mentions and the agents panel show names, so they must tell bots apart.
		if (
			existing.some(
				(other) => other.name.toLowerCase() === bot.name.toLowerCase(),
			)
		)
			throw new BotError(`A bot named ${bot.name} already exists.`, 409);
		await this.repository.insertBot(bot);
		return this.get(workspaceId, bot.id);
	}

	async update(
		workspaceId: string,
		id: string,
		input: UpdateBotRequest,
	): Promise<BotDetails> {
		const bot = await this.find(workspaceId, id);
		const stale = new BotError(
			"This bot changed during your request. Refresh and try again.",
			409,
		);
		if (input.revision !== undefined && input.revision !== bot.revision)
			throw stale;
		const revision = bot.revision;
		this.apply(bot, input);
		if (input.name !== undefined) {
			const others = await this.repository.listBots(workspaceId);
			if (
				others.some(
					(other) =>
						other.id !== id &&
						other.name.toLowerCase() === bot.name.toLowerCase(),
				)
			)
				throw new BotError(`A bot named ${bot.name} already exists.`, 409);
		}
		bot.revision = revision + 1;
		bot.updatedAt = this.at();
		if (!(await this.repository.replaceBot(bot, revision))) throw stale;
		return this.get(workspaceId, id);
	}

	async remove(workspaceId: string, id: string): Promise<void> {
		if (!(await this.repository.deleteBot(workspaceId, id)))
			throw new BotError("Bot not found.", 404);
	}

	/** Bots working on a reply in a channel, for "is replying…". */
	async activity(workspaceId: string, channelId: string): Promise<BotActivity> {
		// A run nobody started within two minutes is not a reply in progress.
		const runs = await this.repository.activeRuns(
			workspaceId,
			channelId,
			this.at(),
			new Date(this.now() - PENDING_SHOWN_MS).toISOString(),
		);
		if (!runs.length) return { replying: [] };
		const names = new Map(
			(await this.repository.listBots(workspaceId)).map((bot) => [
				bot.id,
				bot.name,
			]),
		);
		return {
			replying: [...new Set(runs.map((run) => run.botId))].flatMap((botId) => {
				const name = names.get(botId);
				return name ? [{ botId, name }] : [];
			}),
		};
	}
}
