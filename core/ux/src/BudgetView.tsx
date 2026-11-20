import {
	AGENT_KINDS,
	type AgentSummary,
	agentNamesText,
	BUDGET_LIMITS,
	type BudgetCovers,
	type BudgetPeriod,
	type BudgetPolicyInput,
	type BudgetPolicyView,
	budgetPolicyProblem,
	type ModelInfo,
	VIDEO_KIND_LABELS,
	VIDEO_KINDS,
	VIDEO_MODELS,
	videoModelLabel,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	createBudget,
	deleteBudget,
	fetchAgents,
	fetchBudgets,
	fetchModels,
	updateBudget,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";

type CoversChoice = "all" | "llm" | "llm-model" | "video" | "video-model";
const COVERS_LABELS: Record<CoversChoice, string> = {
	all: "All models",
	llm: "All language models",
	"llm-model": "One language model",
	video: "All video models",
	"video-model": "One video model",
};

const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/** "$1,234.50"; a fraction of a cent shows enough digits to be seen. */
export const money = (usd: number) =>
	`$${usd.toLocaleString("en-US", {
		minimumFractionDigits: 2,
		maximumFractionDigits: usd > 0 && usd < 0.01 ? 4 : 2,
	})}`;

/** "21 Nov" or "1 Dec 2026", in UTC, as budgets count. */
function resetDay(iso: string): string {
	const date = new Date(iso);
	const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
	return date.toLocaleDateString("en-GB", {
		day: "numeric",
		month: "short",
		...(sameYear ? {} : { year: "numeric" }),
		timeZone: "UTC",
	});
}

type Names = {
	agent(id: string): string | undefined;
	llm(id: string): string;
};

function coversText(covers: BudgetCovers, names: Names): string {
	switch (covers.kind) {
		case "all":
			return "all models";
		case "llm":
			return "all language models";
		case "video":
			return "all video models";
		case "llm-model":
			return names.llm(covers.model);
		case "video-model":
			return videoModelLabel(covers.model);
	}
}

function whoText(input: BudgetPolicyInput, names: Names): string {
	if (input.appliesTo.kind === "everyone") return "Everyone in this workspace";
	const listed = input.appliesTo.agentIds.map(
		(id) => names.agent(id) ?? "a removed agent",
	);
	return agentNamesText(listed);
}

/** What a budget does, as a sentence a person can check before saving. */
export function budgetSentence(input: BudgetPolicyInput, names: Names): string {
	const who = whoText(input, names);
	const shared =
		input.appliesTo.kind === "agents" && input.appliesTo.agentIds.length > 1;
	const what = coversText(input.covers, names);
	const per = input.period === "day" ? "a day (UTC)" : "a month (UTC)";
	if (input.limitUsd === 0)
		return `${who} cannot use ${what}: a budget of $0 refuses every request it covers.`;
	return `${who} can ${shared ? "together " : ""}spend up to ${money(input.limitUsd)} ${per} on ${what}.`;
}

/** Adds a budget, or changes one. */
function BudgetForm({
	existing,
	agents,
	llmModels,
	modelsFailed,
	names,
	onSaved,
	onClose,
}: {
	existing?: BudgetPolicyView;
	agents: AgentSummary[];
	llmModels: ModelInfo[];
	/** The language models could not be read, so none can be offered. */
	modelsFailed: boolean;
	names: Names;
	onSaved(budget: BudgetPolicyView, added: boolean): void;
	onClose(): void;
}) {
	const id = useId();
	const [who, setWho] = useState<"everyone" | "agents">(
		existing?.appliesTo.kind ?? "everyone",
	);
	const [agentIds, setAgentIds] = useState<string[]>(
		existing?.appliesTo.kind === "agents" ? existing.appliesTo.agentIds : [],
	);
	const [search, setSearch] = useState("");
	const [covers, setCovers] = useState<CoversChoice>(
		existing?.covers.kind ?? "all",
	);
	const [llmModel, setLlmModel] = useState(
		existing?.covers.kind === "llm-model"
			? existing.covers.model
			: (llmModels[0]?.id ?? ""),
	);
	const [videoModel, setVideoModel] = useState(
		existing?.covers.kind === "video-model"
			? existing.covers.model
			: VIDEO_MODELS[VIDEO_KINDS[0]][0].id,
	);
	const [limit, setLimit] = useState(existing ? String(existing.limitUsd) : "");
	const [period, setPeriod] = useState<BudgetPeriod>(
		existing?.period ?? "month",
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => {
		first.current?.focus();
	}, []);

	const input: BudgetPolicyInput = {
		appliesTo:
			who === "everyone" ? { kind: "everyone" } : { kind: "agents", agentIds },
		covers:
			covers === "llm-model"
				? { kind: "llm-model", model: llmModel }
				: covers === "video-model"
					? { kind: "video-model", model: videoModel }
					: { kind: covers },
		limitUsd: limit.trim() === "" ? Number.NaN : Number(limit),
		period,
	};
	const problem =
		limit.trim() === ""
			? "Enter a limit in US dollars."
			: budgetPolicyProblem(input);
	// Agents a budget names that have since been removed stay listed, so they can be taken out.
	const removed = agentIds.filter(
		(agentId) => !agents.some((agent) => agent.id === agentId),
	);
	const shown = agents.filter((agent) =>
		`${agent.name} ${AGENT_KINDS[agent.kind]}`
			.toLowerCase()
			.includes(search.trim().toLowerCase()),
	);
	const toggle = (agentId: string, on: boolean) =>
		setAgentIds((current) =>
			on ? [...current, agentId] : current.filter((item) => item !== agentId),
		);

	return (
		<section
			className="card add-model-card"
			aria-labelledby={`${id}-title`}
			onKeyDown={(event) => {
				// Escape closes the form, unless it is closing a list inside it.
				if (
					event.key !== "Escape" ||
					saving ||
					event.defaultPrevented ||
					(event.target as HTMLElement).closest('[role="listbox"]')
				)
					return;
				event.preventDefault();
				onClose();
			}}
		>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>
						{existing ? "Edit budget" : "Add a budget"}
					</h2>
					<p className="card-note">
						A budget caps estimated spend over a day or a month. Every budget
						that covers a request must have room for it.
					</p>
				</div>
				<button
					className="icon-button"
					type="button"
					aria-label={existing ? "Close edit budget" : "Close add budget"}
					onClick={onClose}
					disabled={saving}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (saving || problem) return;
					setSaving(true);
					setError("");
					try {
						const saved = existing
							? await updateBudget(existing.id, input)
							: await createBudget(input);
						onSaved(saved, !existing);
					} catch (cause) {
						setError(errorText(cause, "Could not save the budget."));
					} finally {
						setSaving(false);
					}
				}}
			>
				<fieldset className="budget-form" disabled={saving}>
					<fieldset className="budget-choices">
						<legend>Applies to</legend>
						<label className="budget-choice">
							<input
								ref={first}
								type="radio"
								name={`${id}-who`}
								checked={who === "everyone"}
								onChange={() => setWho("everyone")}
							/>
							<span>
								Everyone in this workspace
								<span className="field-hint">
									People, API tokens, and agents, all counted together.
								</span>
							</span>
						</label>
						<label className="budget-choice">
							<input
								type="radio"
								name={`${id}-who`}
								checked={who === "agents"}
								disabled={agents.length === 0 && removed.length === 0}
								onChange={() => setWho("agents")}
							/>
							<span>
								Specific agents
								<span className="field-hint">
									{agents.length === 0 && removed.length === 0
										? "This workspace has no agents yet."
										: "The agents you pick share one budget. For a separate limit each, add a budget per agent."}
								</span>
							</span>
						</label>
					</fieldset>
					{who === "agents" && (
						<div className="budget-agents">
							{agents.length > 6 && (
								<label className="model-search">
									<Icon name="search" />
									<input
										type="search"
										aria-label="Search agents"
										placeholder="Search agents…"
										value={search}
										onChange={(event) => setSearch(event.target.value)}
									/>
								</label>
							)}
							<ul aria-label="Agents" className="budget-agent-list">
								{shown.map((agent) => (
									<li key={agent.id}>
										<label>
											<input
												type="checkbox"
												checked={agentIds.includes(agent.id)}
												onChange={(event) =>
													toggle(agent.id, event.target.checked)
												}
											/>
											<span>
												{agent.name}
												<span className="field-hint">
													{AGENT_KINDS[agent.kind]}
													{agent.status !== "active"
														? ` · ${agent.status}`
														: ""}
												</span>
											</span>
										</label>
									</li>
								))}
								{removed.map((agentId) => (
									<li key={agentId}>
										<label>
											<input
												type="checkbox"
												checked
												onChange={() => toggle(agentId, false)}
											/>
											<span>
												Removed agent
												<span className="field-hint">
													No longer in this workspace. Uncheck to take it out.
												</span>
											</span>
										</label>
									</li>
								))}
								{shown.length === 0 && removed.length === 0 && (
									<li className="field-hint">No agents match.</li>
								)}
							</ul>
							<span className="field-hint">
								{agentIds.length === 0
									? "None picked."
									: `${agentIds.length} picked, at most ${BUDGET_LIMITS.agentsPerPolicy}.`}
							</span>
						</div>
					)}
					<div className="model-form-grid">
						<div className="form-field">
							<label htmlFor={`${id}-covers`}>Covers</label>
							<Dropdown
								id={`${id}-covers`}
								value={covers}
								onValueChange={(value) => setCovers(value as CoversChoice)}
							>
								{(Object.keys(COVERS_LABELS) as CoversChoice[]).map((value) => (
									<option key={value} value={value}>
										{COVERS_LABELS[value]}
									</option>
								))}
							</Dropdown>
						</div>
						{covers === "llm-model" && (
							<div className="form-field">
								<label htmlFor={`${id}-llm`}>Language model</label>
								{llmModels.length === 0 && !llmModel ? (
									<span className="field-hint" id={`${id}-llm`}>
										{modelsFailed
											? "The language models could not be loaded. Close this form and choose Refresh."
											: "No language models are active. Add one on the LLM tab first."}
									</span>
								) : (
									<Dropdown
										id={`${id}-llm`}
										value={llmModel}
										onValueChange={setLlmModel}
									>
										{[
											...(llmModels.some((model) => model.id === llmModel) ||
											!llmModel
												? []
												: [llmModel]),
											...llmModels.map((model) => model.id),
										].map((model) => (
											<option key={model} value={model}>
												{names.llm(model)}
											</option>
										))}
									</Dropdown>
								)}
								<span className="field-hint">
									Through this connection only. The same model on another
									connection needs a budget of its own.
								</span>
							</div>
						)}
						{covers === "video-model" && (
							<div className="form-field">
								<label htmlFor={`${id}-video`}>Video model</label>
								<Dropdown
									id={`${id}-video`}
									value={videoModel}
									onValueChange={setVideoModel}
								>
									{VIDEO_KINDS.flatMap((kind) =>
										VIDEO_MODELS[kind].map((model) => (
											<option key={model.id} value={model.id}>
												{`${model.label} (${VIDEO_KIND_LABELS[kind]})`}
											</option>
										)),
									)}
								</Dropdown>
							</div>
						)}
					</div>
					<div className="model-form-grid">
						<div className="form-field">
							<label htmlFor={`${id}-limit`}>Limit (USD)</label>
							<input
								id={`${id}-limit`}
								type="number"
								inputMode="decimal"
								required
								min={0}
								max={BUDGET_LIMITS.maxLimitUsd}
								step={0.01}
								placeholder="100"
								value={limit}
								onChange={(event) => setLimit(event.target.value)}
							/>
						</div>
						<div className="form-field">
							<label htmlFor={`${id}-period`}>Resets</label>
							<Dropdown
								id={`${id}-period`}
								value={period}
								onValueChange={(value) => setPeriod(value as BudgetPeriod)}
							>
								<option value="day">Every day (UTC)</option>
								<option value="month">Every month (UTC)</option>
							</Dropdown>
						</div>
					</div>
					<p className="budget-preview" id={`${id}-preview`}>
						{problem ?? budgetSentence(input, names)}
					</p>
					{existing && (
						<p className="field-hint">
							A new limit keeps what was spent. Changing who it applies to, what
							it covers, or when it resets starts its spend again from $0.
						</p>
					)}
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					<div className="form-actions">
						<button
							className="button"
							type="button"
							onClick={onClose}
							disabled={saving}
						>
							Cancel
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={Boolean(problem)}
							aria-describedby={`${id}-preview`}
						>
							{saving ? "Saving…" : existing ? "Save changes" : "Add budget"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/** What a budget covers, for its row in the table. */
function CoversCell({ covers }: { covers: BudgetCovers }) {
	switch (covers.kind) {
		case "llm-model":
			return (
				<>
					<code>{covers.model}</code>
					<span className="field-hint">Language model</span>
				</>
			);
		case "video-model":
			return (
				<>
					{videoModelLabel(covers.model)}
					<span className="field-hint">Video model</span>
				</>
			);
		default:
			return <>{COVERS_LABELS[covers.kind]}</>;
	}
}

/** How much of a budget is spent now, as a bar and words. */
function Used({ budget }: { budget: BudgetPolicyView }) {
	const { spentUsd, resetsAt } = budget.usage;
	const limit = budget.limitUsd;
	// A $0 budget is a block, not a meter: nothing is spent and nothing resets.
	if (limit === 0)
		return (
			<span className="budget-blocked">Blocks every request it covers</span>
		);
	const full = spentUsd >= limit;
	const share = limit > 0 ? Math.min(spentUsd / limit, 1) : 1;
	const tone = full ? "critical" : share >= 0.8 ? "warning" : "normal";
	const text = `${money(spentUsd)} of ${money(limit)}`;
	return (
		<div className="budget-used">
			<meter
				className="visually-hidden"
				aria-label={`Spent of ${money(limit)}`}
				min={0}
				max={Math.max(limit, 0.01)}
				value={Math.min(spentUsd, Math.max(limit, 0.01))}
				aria-valuetext={full ? `${text}, used up` : text}
			/>
			<span className="meter" aria-hidden="true">
				<span
					className={`meter-fill ${tone}`}
					style={{ width: `${share * 100}%` }}
				/>
			</span>
			<span aria-hidden="true">{text}</span>
			<span className={full ? "budget-full" : "field-hint"}>
				{full ? "Used up · " : ""}resets {resetDay(resetsAt)}, 00:00 UTC
			</span>
		</div>
	);
}

/**
 * The Models page's Budget tab: caps on what models may spend, for everyone
 * or for chosen agents, on all models, a kind, or one model. Members see
 * them; workspace admins add, change, switch off, and delete them.
 */
export function BudgetPanel({
	workspace,
	active = true,
}: {
	workspace?: { isDefault: boolean; role?: "admin" | "member" };
	/** Whether the tab is showing: coming back to it reads spend afresh. */
	active?: boolean;
}) {
	const canEdit = workspace?.role !== "member";
	const [budgets, setBudgets] = useState<BudgetPolicyView[] | null>(null);
	const [persistence, setPersistence] = useState<"mongodb" | "memory" | null>(
		null,
	);
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [llmModels, setLlmModels] = useState<ModelInfo[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [rowError, setRowError] = useState("");
	const [panel, setPanel] = useState<
		{ kind: "add" } | { kind: "edit"; id: string } | null
	>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const working = (budgetId: string, on: boolean) =>
		setBusy((current) => {
			const next = new Set(current);
			if (on) next.add(budgetId);
			else next.delete(budgetId);
			return next;
		});
	const [modelsFailed, setModelsFailed] = useState(false);
	const addButton = useRef<HTMLButtonElement>(null);
	const focusAdd = useRef(false);
	const sequence = useRef(0);
	// Delete and Cancel replace themselves: focus follows to what took their place.
	const confirmDelete = useRef<HTMLButtonElement>(null);
	const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
	const refocusDelete = useRef<string | null>(null);
	useEffect(() => {
		if (confirming) {
			confirmDelete.current?.focus();
			return;
		}
		const budgetId = refocusDelete.current;
		refocusDelete.current = null;
		if (budgetId) deleteButtons.current.get(budgetId)?.focus();
	}, [confirming]);

	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		const [list, agentList, models] = await Promise.allSettled([
			fetchBudgets(),
			fetchAgents(),
			fetchModels(),
		]);
		if (request !== sequence.current) return;
		if (list.status === "fulfilled") {
			setBudgets(list.value.policies);
			setPersistence(list.value.persistence);
			setError("");
		} else
			setError(
				errorText(
					list.reason,
					"Could not load budgets. Check the API connection and try again.",
				),
			);
		if (agentList.status === "fulfilled") setAgents(agentList.value.agents);
		if (models.status === "fulfilled") setLlmModels(models.value.models);
		setModelsFailed(models.status !== "fulfilled");
		setLoading(false);
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	const shownBefore = useRef(active);
	useEffect(() => {
		if (active && !shownBefore.current) void refresh();
		shownBefore.current = active;
	}, [active, refresh]);
	// Closing a form returns focus to what opened it: Add budget, or the row's Edit.
	const editButtons = useRef(new Map<string, HTMLButtonElement>());
	const focusEdit = useRef<string | null>(null);
	useEffect(() => {
		if (panel) return;
		const budgetId = focusEdit.current;
		focusEdit.current = null;
		if (budgetId && editButtons.current.get(budgetId)) {
			focusAdd.current = false;
			editButtons.current.get(budgetId)?.focus();
			return;
		}
		if (!focusAdd.current) return;
		focusAdd.current = false;
		addButton.current?.focus();
	}, [panel]);

	const names: Names = {
		agent: (agentId) => agents.find((agent) => agent.id === agentId)?.name,
		llm: (model) => model,
	};
	const closePanel = () => {
		if (panel?.kind === "edit") focusEdit.current = panel.id;
		else focusAdd.current = true;
		setPanel(null);
	};
	const editing =
		panel?.kind === "edit"
			? budgets?.find((budget) => budget.id === panel.id)
			: undefined;
	// Used up, or $0: either way it refuses what it covers now.
	const refusing = (budgets ?? []).filter(
		(budget) => budget.enabled && budget.usage.spentUsd >= budget.limitUsd,
	);
	const form = (existing?: BudgetPolicyView) => (
		<BudgetForm
			key={existing?.id ?? "add"}
			existing={existing}
			agents={agents}
			llmModels={llmModels.filter((model) => model.capability !== "decisions")}
			modelsFailed={modelsFailed}
			names={names}
			onClose={closePanel}
			onSaved={(saved, added) => {
				setBudgets((current) =>
					added
						? [...(current ?? []), saved]
						: (current ?? []).map((item) =>
								item.id === saved.id ? saved : item,
							),
				);
				setNotice(added ? "Budget added." : "Budget saved.");
				closePanel();
				void refresh();
			}}
		/>
	);

	return (
		<div className="budget-page">
			<div className="tab-intro">
				<p className="card-note">
					Caps on what models may spend, for everyone or for specific agents. A
					request is refused while any budget that covers it is used up.
				</p>
				{canEdit ? (
					<button
						ref={addButton}
						className="button primary"
						type="button"
						disabled={!budgets || panel?.kind === "add"}
						onClick={() => {
							setPanel({ kind: "add" });
							setNotice("");
						}}
					>
						<Icon name="plus" /> Add budget
					</button>
				) : (
					<p className="card-note">Ask a workspace admin to change budgets.</p>
				)}
			</div>
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}{" "}
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => void refresh()}
					>
						Retry
					</button>
				</div>
			)}
			{panel?.kind === "add" && budgets && form()}
			{editing && form(editing)}
			<section className="models-overview" aria-label="Budget overview">
				<div>
					<span className="overview-value">
						{budgets ? budgets.length : "—"}
					</span>
					<span>Budgets</span>
				</div>
				<div>
					<span className="overview-value">
						{budgets ? refusing.length : "—"}
					</span>
					<span>Refusing requests now</span>
				</div>
				<p>Estimated from list prices.</p>
			</section>
			<section
				className="card active-models"
				aria-labelledby="budgets-heading"
				aria-busy={loading && Boolean(budgets)}
			>
				<div className="section-heading">
					<div>
						<h2 id="budgets-heading">Budgets</h2>
						<p className="card-note">
							Spend counts in UTC days or months, from when a budget is added or
							last changed what it limits.
						</p>
					</div>
					<button
						type="button"
						className="button"
						disabled={loading}
						onClick={() => {
							setRowError("");
							void refresh();
						}}
					>
						{loading ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				{rowError && (
					<div className="banner-error" role="alert">
						{rowError}
					</div>
				)}
				{!budgets ? (
					<div className="models-empty">
						{loading ? (
							<LoadingBanner>Loading budgets…</LoadingBanner>
						) : (
							"Budgets could not be loaded."
						)}
					</div>
				) : budgets.length === 0 ? (
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="models" />
						</span>
						<h3>No budgets</h3>
						<p>Nothing limits what models spend in this workspace.</p>
						{canEdit && (
							<button
								type="button"
								className="button"
								disabled={panel?.kind === "add"}
								onClick={() => setPanel({ kind: "add" })}
							>
								<Icon name="plus" /> Add your first budget
							</button>
						)}
					</div>
				) : (
					<div className="table-scroll">
						<table className="models-table budget-table">
							<thead>
								<tr>
									<th>Applies to</th>
									<th>Covers</th>
									<th>Limit</th>
									<th>Spent</th>
									<th>Status</th>
									{canEdit && (
										<th>
											<span className="visually-hidden">Actions</span>
										</th>
									)}
								</tr>
							</thead>
							<tbody>
								{budgets.map((budget) => {
									const label = `${whoText(budget, names)} on ${coversText(budget.covers, names)}`;
									return (
										<tr key={budget.id}>
											<td className="budget-who">
												<strong>{whoText(budget, names)}</strong>
												{budget.appliesTo.kind === "agents" &&
													budget.appliesTo.agentIds.length > 1 && (
														<span className="field-hint">
															Shared by {budget.appliesTo.agentIds.length}{" "}
															agents
														</span>
													)}
											</td>
											<td data-label="Covers">
												<CoversCell covers={budget.covers} />
												{budget.origin === "video-budget" && (
													<span className="field-hint">
														Was the monthly video budget
													</span>
												)}
											</td>
											<td data-label="Limit">
												{money(budget.limitUsd)}{" "}
												<span className="field-hint">
													{budget.period === "day" ? "a day" : "a month"}
												</span>
											</td>
											<td data-label="Spent">
												<Used budget={budget} />
											</td>
											<td data-label="Status">
												{canEdit ? (
													<label className="failover-enable">
														<input
															type="checkbox"
															aria-label={`Use the budget for ${label}`}
															checked={budget.enabled}
															disabled={busy.has(budget.id)}
															onChange={async (event) => {
																setRowError("");
																working(budget.id, true);
																try {
																	const saved = await updateBudget(budget.id, {
																		enabled: event.target.checked,
																	});
																	setBudgets((current) =>
																		(current ?? []).map((item) =>
																			item.id === saved.id ? saved : item,
																		),
																	);
																	// A list read before this change would undo it on screen.
																	void refresh();
																} catch (cause) {
																	setRowError(
																		errorText(cause, "Could not change it."),
																	);
																} finally {
																	working(budget.id, false);
																}
															}}
														/>
														{budget.enabled ? "On" : "Off"}
													</label>
												) : (
													<span className="chip">
														<span
															className={`dot ${budget.enabled ? "dot-good" : "dot-muted"}`}
														/>
														{budget.enabled ? "On" : "Off"}
													</span>
												)}
											</td>
											{canEdit && (
												<td className="budget-actions">
													<div className="proxy-actions">
														<button
															ref={(element) => {
																if (element)
																	editButtons.current.set(budget.id, element);
																else editButtons.current.delete(budget.id);
															}}
															className="button"
															type="button"
															aria-label={`Edit the budget for ${label}`}
															onClick={() => {
																setPanel({ kind: "edit", id: budget.id });
																setNotice("");
															}}
														>
															Edit
														</button>
														{confirming === budget.id ? (
															<>
																<button
																	className="button danger"
																	type="button"
																	aria-label={`Confirm delete the budget for ${label}`}
																	disabled={busy.has(budget.id)}
																	ref={confirmDelete}
																	onClick={async () => {
																		setRowError("");
																		working(budget.id, true);
																		try {
																			await deleteBudget(budget.id);
																			setConfirming(null);
																			if (
																				panel?.kind === "edit" &&
																				panel.id === budget.id
																			)
																				setPanel(null);
																			setBudgets((current) =>
																				(current ?? []).filter(
																					(item) => item.id !== budget.id,
																				),
																			);
																			setNotice("Budget deleted.");
																			void refresh();
																		} catch (cause) {
																			setRowError(
																				errorText(
																					cause,
																					"Could not delete it.",
																				),
																			);
																		} finally {
																			working(budget.id, false);
																		}
																	}}
																>
																	{busy.has(budget.id) ? "Deleting…" : "Delete"}
																</button>
																<button
																	className="button"
																	type="button"
																	onClick={() => {
																		refocusDelete.current = budget.id;
																		setConfirming(null);
																	}}
																>
																	Cancel
																</button>
															</>
														) : (
															<button
																ref={(element) => {
																	if (element)
																		deleteButtons.current.set(
																			budget.id,
																			element,
																		);
																	else deleteButtons.current.delete(budget.id);
																}}
																className="button"
																type="button"
																aria-label={`Delete the budget for ${label}`}
																onClick={() => setConfirming(budget.id)}
															>
																Delete
															</button>
														)}
													</div>
												</td>
											)}
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				<p className="card-note budget-footnote">
					A language model call that starts under budget finishes, so spend can
					pass a limit by the calls already running. Language models without a
					public list price are not counted. A video&apos;s estimate is held
					before it starts.
				</p>
			</section>
			{persistence && (
				<p className="card-note">
					{persistence === "mongodb"
						? "Budgets are saved in MongoDB."
						: "Budgets are temporary and last until the API restarts. Connect MongoDB to keep them."}
				</p>
			)}
		</div>
	);
}
