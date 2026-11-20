import { randomUUID } from "node:crypto";
import {
	BUDGET_LIMITS,
	BUDGET_PERIODS,
	type BudgetAppliesTo,
	type BudgetCovers,
	type BudgetList,
	type BudgetPolicy,
	type BudgetPolicyInput,
	type BudgetPolicyView,
	type BudgetSpend,
	budgetCovers,
	budgetPeriodKey,
	budgetPolicyProblem,
	budgetResetsAt,
	budgetSummary,
	type TelemetryCaller,
	type UpdateBudgetPolicyRequest,
	videoModelLabel,
} from "@autonomo.us/common";
import { ServiceError } from "../service-error.js";
import { toMicros } from "../web/store.js";
import type { WorkspaceRef } from "../workspaces/store.js";
import type { BudgetHold, BudgetStore } from "./store.js";

const fromMicros = (micros: number) => micros / 1_000_000;
const money = (usd: number) =>
	`$${usd.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export type BudgetServiceOptions = {
	now?: () => Date;
	/** The ids of the workspace's agents, to check the agents a budget names. */
	knownAgents?: (workspace: WorkspaceRef) => Promise<Set<string>>;
	/** Where a charge that could not be written is reported. */
	onChargeError?: (error: unknown) => void;
};

/**
 * Budgets for a workspace's models. Language model calls are checked before
 * they start and charged after, from the estimate telemetry makes; a call
 * that starts under budget finishes, so spend can pass a limit by the calls
 * already running. Videos cost a known estimate, held against every budget
 * that covers them before the provider is called.
 */
export class BudgetService {
	private readonly pending = new Set<Promise<void>>();
	private readonly now: () => Date;

	constructor(
		private readonly store: BudgetStore,
		private readonly options: BudgetServiceOptions = {},
	) {
		this.now = options.now ?? (() => new Date());
	}

	get persistence() {
		return this.store.persistence;
	}

	async list(workspace: WorkspaceRef): Promise<BudgetList> {
		const { policies } = await this.store.policies(workspace.id);
		return {
			policies: await this.views(workspace.id, policies),
			persistence: this.store.persistence,
		};
	}

	private async views(
		workspaceId: string,
		policies: BudgetPolicy[],
	): Promise<BudgetPolicyView[]> {
		const now = this.now();
		const spent = await this.store.spent(workspaceId, policies);
		return policies.map((policy, index) => ({
			...structuredClone(policy),
			usage: {
				period: budgetPeriodKey(policy.period, now),
				spentUsd: fromMicros(spent[index] ?? 0),
				resetsAt: budgetResetsAt(policy.period, now),
			},
		}));
	}

	async create(
		workspace: WorkspaceRef,
		input: BudgetPolicyInput,
	): Promise<BudgetPolicyView> {
		const checked = await this.check(workspace, input);
		const at = this.now().toISOString();
		const policy: BudgetPolicy = {
			id: randomUUID(),
			...checked,
			enabled: input.enabled ?? true,
			createdAt: at,
			updatedAt: at,
		};
		await this.change(workspace.id, (policies) => {
			if (policies.length >= BUDGET_LIMITS.policies)
				throw new ServiceError(
					`A workspace holds at most ${BUDGET_LIMITS.policies} budgets.`,
					409,
				);
			return [...policies, policy];
		});
		const [view] = await this.views(workspace.id, [policy]);
		return view;
	}

	async update(
		workspace: WorkspaceRef,
		id: string,
		input: UpdateBudgetPolicyRequest,
	): Promise<BudgetPolicyView> {
		let updated: BudgetPolicy | undefined;
		const { policies } = await this.store.policies(workspace.id);
		const current = policies.find((policy) => policy.id === id);
		if (!current) throw new ServiceError("Budget not found.", 404);
		const checked = await this.check(
			workspace,
			{
				appliesTo: input.appliesTo ?? current.appliesTo,
				covers: input.covers ?? current.covers,
				limitUsd: input.limitUsd ?? current.limitUsd,
				period: input.period ?? current.period,
			},
			current,
		);
		await this.change(workspace.id, (saved) =>
			saved.map((policy) => {
				if (policy.id !== id) return policy;
				updated = {
					...policy,
					...checked,
					enabled: input.enabled ?? policy.enabled,
					updatedAt: this.now().toISOString(),
				};
				return updated;
			}),
		);
		if (!updated) throw new ServiceError("Budget not found.", 404);
		const [view] = await this.views(workspace.id, [updated]);
		return view;
	}

	async remove(workspace: WorkspaceRef, id: string): Promise<void> {
		let found = false;
		await this.change(workspace.id, (policies) => {
			found = policies.some((policy) => policy.id === id);
			return policies.filter((policy) => policy.id !== id);
		});
		if (!found) throw new ServiceError("Budget not found.", 404);
	}

	/** Applies `edit` to a fresh read; a lost race is retried. */
	private async change(
		workspaceId: string,
		edit: (policies: BudgetPolicy[]) => BudgetPolicy[],
	): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			const { policies, revision } = await this.store.policies(workspaceId);
			try {
				await this.store.write(workspaceId, edit(policies), revision);
				return;
			} catch (error) {
				const raced = error instanceof ServiceError && error.statusCode === 409;
				if (!raced || attempt >= 4) throw error;
			}
		}
	}

	/** Checks what a person sent; agents a budget already names may have been removed since. */
	private async check(
		workspace: WorkspaceRef,
		input: BudgetPolicyInput,
		current?: BudgetPolicy,
	): Promise<Omit<BudgetPolicyInput, "enabled">> {
		const appliesTo = normalizeAppliesTo(input.appliesTo);
		const covers = normalizeCovers(input.covers);
		const period = input.period;
		if (!BUDGET_PERIODS.includes(period))
			throw new ServiceError("A budget runs for a day or a month.");
		const limitUsd =
			typeof input.limitUsd === "number"
				? Math.round(input.limitUsd * 100) / 100
				: input.limitUsd;
		const problem = budgetPolicyProblem({
			appliesTo,
			covers,
			limitUsd,
			period,
		});
		if (problem) throw new ServiceError(problem);
		if (appliesTo.kind === "agents" && this.options.knownAgents) {
			const before = new Set(
				current?.appliesTo.kind === "agents" ? current.appliesTo.agentIds : [],
			);
			const added = appliesTo.agentIds.filter((id) => !before.has(id));
			if (added.length) {
				const known = await this.options.knownAgents(workspace);
				const unknown = added.find((id) => !known.has(id));
				if (unknown)
					throw new ServiceError(
						`${unknown} is not an agent in this workspace.`,
					);
			}
		}
		return { appliesTo, covers, limitUsd, period };
	}

	private async covering(
		workspaceId: string,
		caller: TelemetryCaller | undefined,
		spend: BudgetSpend,
	): Promise<BudgetPolicy[]> {
		const { policies } = await this.store.policies(workspaceId);
		return policies.filter((policy) => budgetCovers(policy, caller, spend));
	}

	/** When the budget starts again, and who can change it. */
	private after(policy: BudgetPolicy): string {
		const resets = budgetResetsAt(policy.period, this.now())
			.slice(0, 16)
			.replace("T", " ");
		return `It starts again at ${resets} UTC. A workspace admin can change it on the Models page, under Budget.`;
	}

	private refusal(policy: BudgetPolicy, spentMicros: number): string {
		return `The budget "${budgetSummary(policy)}" is used up: ${money(fromMicros(spentMicros))} of ${money(policy.limitUsd)} spent. ${this.after(policy)}`;
	}

	/**
	 * Why this caller may not start a language model call on `model` now,
	 * or null. A budget refuses once its spend reaches its limit.
	 */
	async llmRefusal(
		workspaceId: string,
		caller: TelemetryCaller | undefined,
		model: string,
	): Promise<string | null> {
		const policies = await this.covering(workspaceId, caller, {
			type: "llm",
			model,
		});
		if (!policies.length) return null;
		const spent = await this.store.spent(workspaceId, policies);
		const index = policies.findIndex(
			(policy, at) => (spent[at] ?? 0) >= toMicros(policy.limitUsd),
		);
		return index < 0 ? null : this.refusal(policies[index], spent[index] ?? 0);
	}

	/**
	 * Counts a language model call's estimated cost on every budget that
	 * covers it. Written in the background; `idle()` waits for the writes.
	 */
	chargeLlm(
		workspaceId: string,
		caller: TelemetryCaller | undefined,
		model: string,
		costUsd: number,
	): void {
		if (!(costUsd > 0)) return;
		const write = (async () => {
			const policies = await this.covering(workspaceId, caller, {
				type: "llm",
				model,
			});
			await this.store.charge(workspaceId, policies, toMicros(costUsd));
		})()
			.catch((error) => this.options.onChargeError?.(error))
			.finally(() => this.pending.delete(write));
		this.pending.add(write);
	}

	/** Holds a video's estimate against every budget that covers it, or says which refused. */
	async holdVideo(
		workspaceId: string,
		caller: TelemetryCaller | undefined,
		model: string,
		costUsd: number,
	): Promise<BudgetHold | { refused: string }> {
		const policies = await this.covering(workspaceId, caller, {
			type: "video",
			model,
		});
		const held = await this.store.hold(
			workspaceId,
			policies,
			toMicros(costUsd),
		);
		if (!("refused" in held)) return held;
		const policy = held.refused;
		const [spent = 0] = await this.store
			.spent(workspaceId, [policy])
			.catch(() => [0]);
		const limit = toMicros(policy.limitUsd);
		return {
			refused:
				spent < limit
					? `The budget "${budgetSummary(policy)}" has ${money(fromMicros(limit - spent))} left, less than this video's estimate of ${money(costUsd)}. ${this.after(policy)}`
					: this.refusal(policy, spent),
		};
	}

	release(hold: BudgetHold): Promise<void> {
		return this.store.release(hold);
	}

	/** Waits for charges still being written. */
	async idle(): Promise<void> {
		while (this.pending.size) await Promise.allSettled([...this.pending]);
	}

	close(): Promise<void> {
		return this.store.close();
	}
}

function normalizeAppliesTo(input: BudgetAppliesTo): BudgetAppliesTo {
	if (input?.kind === "everyone") return { kind: "everyone" };
	if (input?.kind === "agents") {
		const listed: unknown[] = Array.isArray(input.agentIds)
			? input.agentIds
			: [];
		const ids = [
			...new Set(
				listed
					.filter((id): id is string => typeof id === "string")
					.map((id) => id.trim())
					.filter(Boolean),
			),
		];
		return { kind: "agents", agentIds: ids };
	}
	throw new ServiceError("A budget applies to everyone or to agents.");
}

function normalizeCovers(input: BudgetCovers): BudgetCovers {
	switch (input?.kind) {
		case "all":
		case "llm":
		case "video":
			return { kind: input.kind };
		case "llm-model": {
			const model = String(input.model ?? "").trim();
			if (model.length > BUDGET_LIMITS.modelLength)
				throw new ServiceError(
					`A model id is at most ${BUDGET_LIMITS.modelLength} characters.`,
				);
			return { kind: "llm-model", model };
		}
		case "video-model": {
			const model = String(input.model ?? "").trim();
			if (model && videoModelLabel(model) === model)
				throw new ServiceError(`${model} is not a video model.`);
			return { kind: "video-model", model };
		}
		default:
			throw new ServiceError(
				"A budget covers all models, language models, video models, or one model.",
			);
	}
}
