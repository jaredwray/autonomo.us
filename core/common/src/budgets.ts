/**
 * Budgets: caps on what a workspace's models may spend, estimated from list
 * prices, over a UTC day or month. A budget applies to everyone or to agents
 * picked by name (who then share it), and covers every model, every language
 * model, every video model, or one model. A request is refused while any
 * budget that covers it is used up. See docs/BUDGETS_PLAN.md.
 */
import type { TelemetryCaller } from "./analytics.js";
import { VIDEO_MODELS } from "./video.js";

export const BUDGET_PERIODS = ["day", "month"] as const;
export type BudgetPeriod = (typeof BUDGET_PERIODS)[number];

/** Who a budget limits. Agents named here share one pool. */
export type BudgetAppliesTo =
	| { kind: "everyone" }
	| { kind: "agents"; agentIds: string[] };

/** What spend a budget counts. */
export type BudgetCovers =
	| { kind: "all" }
	| { kind: "llm" }
	| { kind: "video" }
	/** A language model's routable id, e.g. `anthropic/claude-opus-4-8`. */
	| { kind: "llm-model"; model: string }
	/** A video model's id, e.g. `gen4.5`. */
	| { kind: "video-model"; model: string };

export type BudgetPolicyInput = {
	appliesTo: BudgetAppliesTo;
	covers: BudgetCovers;
	/** US dollars per period. Zero refuses everything it covers. */
	limitUsd: number;
	period: BudgetPeriod;
	/** Defaults to true. */
	enabled?: boolean;
};

export type BudgetPolicy = Required<BudgetPolicyInput> & {
	id: string;
	createdAt: string;
	updatedAt: string;
};

/** Spend in the period now running. */
export type BudgetUsage = {
	/** `2026-11` for a month, `2026-11-20` for a day. */
	period: string;
	spentUsd: number;
	/** When the period ends and spend starts again from zero. */
	resetsAt: string;
};

export type BudgetPolicyView = BudgetPolicy & { usage: BudgetUsage };

export type BudgetList = {
	policies: BudgetPolicyView[];
	persistence: "mongodb" | "memory";
};

/** Fields to change. */
export type UpdateBudgetPolicyRequest = Partial<BudgetPolicyInput>;

export const BUDGET_LIMITS = {
	/** Budgets per workspace. */
	policies: 50,
	agentsPerPolicy: 100,
	maxLimitUsd: 1_000_000,
	modelLength: 200,
} as const;

/** One call or video that spends money. */
export type BudgetSpend = { type: "llm" | "video"; model: string };

/** The period key a budget counts in at `now`. */
export function budgetPeriodKey(period: BudgetPeriod, now: Date): string {
	const iso = now.toISOString();
	return period === "day" ? iso.slice(0, 10) : iso.slice(0, 7);
}

/** When the period running at `now` ends, as an ISO time. */
export function budgetResetsAt(period: BudgetPeriod, now: Date): string {
	const next =
		period === "day"
			? Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
			: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
	return new Date(next).toISOString();
}

/** Whether a budget counts this spend by this caller. */
export function budgetCovers(
	policy: Pick<BudgetPolicy, "appliesTo" | "covers" | "enabled">,
	caller: TelemetryCaller | undefined,
	spend: BudgetSpend,
): boolean {
	if (!policy.enabled) return false;
	if (policy.appliesTo.kind === "agents") {
		if (caller?.kind !== "agent" || !caller.id.startsWith("agent:"))
			return false;
		if (!policy.appliesTo.agentIds.includes(caller.id.slice("agent:".length)))
			return false;
	}
	switch (policy.covers.kind) {
		case "all":
			return true;
		case "llm":
		case "video":
			return policy.covers.kind === spend.type;
		case "llm-model":
			return spend.type === "llm" && spend.model === policy.covers.model;
		case "video-model":
			return spend.type === "video" && spend.model === policy.covers.model;
	}
}

/** A video model's label, or its id when the gateway does not know it. */
export function videoModelLabel(id: string): string {
	for (const models of Object.values(VIDEO_MODELS)) {
		const found = models.find((model) => model.id === id);
		if (found) return found.label;
	}
	return id;
}

const money = (usd: number) =>
	`$${usd.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: usd > 0 && usd < 0.01 ? 4 : 2,
	})}`;

/** "Researcher", "Researcher and Writer", "Researcher, Writer, and 2 more". */
export function agentNamesText(names: string[]): string {
	if (names.length <= 1) return names[0] ?? "No agents";
	if (names.length === 2) return `${names[0]} and ${names[1]}`;
	if (names.length === 3) return `${names[0]}, ${names[1]}, and ${names[2]}`;
	return `${names[0]}, ${names[1]}, and ${names.length - 2} more`;
}

/** Who a budget applies to, in words. Agent names come from the caller when it has them. */
export function budgetAppliesToText(
	appliesTo: BudgetAppliesTo,
	agentName?: (id: string) => string | undefined,
): string {
	if (appliesTo.kind === "everyone") return "Everyone";
	const names = appliesTo.agentIds.map((id) => agentName?.(id));
	if (names.every((name): name is string => Boolean(name)))
		return agentNamesText(names);
	const count = appliesTo.agentIds.length;
	return count === 1 ? "1 agent" : `${count} agents`;
}

/** What a budget covers, in words. */
export function budgetCoversText(covers: BudgetCovers): string {
	switch (covers.kind) {
		case "all":
			return "All models";
		case "llm":
			return "All language models";
		case "video":
			return "All video models";
		case "llm-model":
			return covers.model;
		case "video-model":
			return videoModelLabel(covers.model);
	}
}

/** "$100.00 a month". */
export function budgetLimitText(
	policy: Pick<BudgetPolicy, "limitUsd" | "period">,
): string {
	return `${money(policy.limitUsd)} a ${policy.period}`;
}

/** "Everyone · All models · $100.00 a month". */
export function budgetSummary(
	policy: Pick<BudgetPolicy, "appliesTo" | "covers" | "limitUsd" | "period">,
	agentName?: (id: string) => string | undefined,
): string {
	return [
		budgetAppliesToText(policy.appliesTo, agentName),
		budgetCoversText(policy.covers),
		budgetLimitText(policy),
	].join(" · ");
}

/** Why a budget cannot be saved, or null. Checked again on the server. */
export function budgetPolicyProblem(input: BudgetPolicyInput): string | null {
	if (input.appliesTo.kind === "agents") {
		const ids = input.appliesTo.agentIds;
		if (!ids.length) return "Pick at least one agent.";
		if (ids.length > BUDGET_LIMITS.agentsPerPolicy)
			return `A budget names at most ${BUDGET_LIMITS.agentsPerPolicy} agents.`;
	}
	if (
		(input.covers.kind === "llm-model" ||
			input.covers.kind === "video-model") &&
		!input.covers.model.trim()
	)
		return "Pick a model.";
	const limit = input.limitUsd;
	if (
		typeof limit !== "number" ||
		!Number.isFinite(limit) ||
		limit < 0 ||
		limit > BUDGET_LIMITS.maxLimitUsd
	)
		return `The limit is from $0 to $${BUDGET_LIMITS.maxLimitUsd.toLocaleString("en-US")}.`;
	return null;
}
