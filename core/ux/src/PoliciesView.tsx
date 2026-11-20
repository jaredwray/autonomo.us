import type {
	AgentSummary,
	BudgetPolicyView,
	ModelInfo,
	VideoSettings,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	fetchAgents,
	fetchBudgets,
	fetchModels,
	fetchVideoSettings,
} from "./api.js";
import { BudgetForm, BudgetsCard } from "./BudgetView.js";
import { Icon } from "./Icons.js";
import { TabAction } from "./TabAction.js";
import { VideoLimitForm, VideoLimitsCard } from "./VideoLimitsView.js";

/** The kinds of policy a workspace can add. */
export type PolicyKind = "budget" | "video-limit";

const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/**
 * Which kind of policy the Add policy form makes. It takes the focus when
 * it appears, and again when a choice swaps the form below it.
 */
function PolicyTypePicker({
	value,
	videoDisabled,
	onChange,
}: {
	value: PolicyKind;
	/** Why a video limit cannot be added now, or null when it can. */
	videoDisabled: string | null;
	onChange(kind: PolicyKind): void;
}) {
	const id = useId();
	const chosen = useRef<HTMLInputElement>(null);
	useEffect(() => {
		chosen.current?.focus();
	}, []);
	const choice = (kind: PolicyKind, label: string, hint: string) => (
		<label className="budget-choice">
			<input
				ref={value === kind ? chosen : undefined}
				type="radio"
				name={`${id}-type`}
				checked={value === kind}
				disabled={kind === "video-limit" && videoDisabled !== null}
				onChange={() => onChange(kind)}
			/>
			<span>
				{label}
				<span className="field-hint">{hint}</span>
			</span>
		</label>
	);
	return (
		<fieldset className="budget-choices policy-type">
			<legend>Type</legend>
			{choice(
				"budget",
				"Budget",
				"Caps what models may spend in a day or a month.",
			)}
			{choice(
				"video-limit",
				"Video limit",
				videoDisabled ??
					"Caps how many videos each caller may start in a day, and how long they may be.",
			)}
		</fieldset>
	);
}

/**
 * The Models page's Policies tab: the rules on what agents, people, and API
 * tokens may spend and make. Budgets cap estimated spend; video limits cap
 * how many videos and how long. Members see them; workspace admins add,
 * change, switch off, and delete them.
 */
export function PoliciesPanel({
	workspace,
	active = true,
}: {
	workspace?: { isDefault: boolean; role?: "admin" | "member" };
	/** Whether the tab is showing: coming back to it reads spend afresh. */
	active?: boolean;
}) {
	const canEdit = workspace?.role !== "member";
	const [budgets, setBudgets] = useState<BudgetPolicyView[] | null>(null);
	const [budgetPersistence, setBudgetPersistence] = useState<
		"mongodb" | "memory" | null
	>(null);
	const [budgetError, setBudgetError] = useState("");
	const [video, setVideo] = useState<VideoSettings | null>(null);
	const [videoFailed, setVideoFailed] = useState(false);
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [llmModels, setLlmModels] = useState<ModelInfo[]>([]);
	const [modelsFailed, setModelsFailed] = useState(false);
	const [loading, setLoading] = useState(true);
	const [notice, setNotice] = useState("");
	const [adding, setAdding] = useState<PolicyKind | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const sequence = useRef(0);

	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		const [list, videoSettings, agentList, models] = await Promise.allSettled([
			fetchBudgets(),
			fetchVideoSettings(),
			fetchAgents(),
			fetchModels(),
		]);
		if (request !== sequence.current) return;
		if (list.status === "fulfilled") {
			setBudgets(list.value.policies);
			setBudgetPersistence(list.value.persistence);
			setBudgetError("");
		} else
			setBudgetError(
				errorText(
					list.reason,
					"Could not load budgets. Check the API connection and try again.",
				),
			);
		if (videoSettings.status === "fulfilled") setVideo(videoSettings.value);
		setVideoFailed(videoSettings.status !== "fulfilled");
		if (agentList.status === "fulfilled") setAgents(agentList.value.agents);
		if (models.status === "fulfilled")
			setLlmModels(
				models.value.models.filter((model) => model.capability !== "decisions"),
			);
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

	// Closing the add form returns focus to Add policy, once it is enabled again.
	const focusAdd = useRef(false);
	useEffect(() => {
		if (adding || !focusAdd.current) return;
		focusAdd.current = false;
		addButton.current?.focus();
	}, [adding]);
	const closeAdd = () => {
		focusAdd.current = true;
		setAdding(null);
	};
	const openAdd = (kind: PolicyKind) => {
		setAdding(kind);
		setNotice("");
	};

	const videoAvailable = video?.available ?? false;
	const videoDisabled = !video
		? videoFailed
			? "Video settings could not be loaded, so a video limit cannot be added now."
			: "Loading video settings…"
		: !video.available
			? "Video generation is turned off on this gateway, so video limits cannot be added."
			: null;
	// Video turned off while its form was open: the form is gone, so close it.
	useEffect(() => {
		if (adding === "video-limit" && videoDisabled !== null && !loading)
			closeAdd();
	});
	const connected = [
		...new Set((video?.connections ?? []).map((item) => item.kind)),
	];
	const names = {
		agent: (agentId: string) =>
			agents.find((agent) => agent.id === agentId)?.name,
		llm: (model: string) => model,
	};
	// Used up, or $0: either way it refuses what it covers now.
	const refusing = (budgets ?? []).filter(
		(budget) => budget.enabled && budget.usage.spentUsd >= budget.limitUsd,
	);
	const temporary =
		budgetPersistence === "memory" || video?.persistence === "memory";
	const picker = (value: PolicyKind) => (
		<PolicyTypePicker
			value={value}
			videoDisabled={videoDisabled}
			onChange={setAdding}
		/>
	);

	return (
		<div className="budget-page policies-page">
			<div className="tab-intro">
				{!canEdit && (
					<p className="page-note">Ask a workspace admin to change policies.</p>
				)}
				{temporary && (
					<p className="page-note">
						Policies are temporary and last until the API restarts. Connect
						MongoDB to keep them.
					</p>
				)}
				{canEdit && (
					<TabAction active={active}>
						<button
							ref={addButton}
							className="button primary"
							type="button"
							disabled={!budgets || adding !== null}
							onClick={() => openAdd("budget")}
						>
							<Icon name="plus" /> Add policy
						</button>
					</TabAction>
				)}
			</div>
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{budgetError && (
				<div className="banner-error" role="alert">
					{budgetError}{" "}
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
			{canEdit && adding === "budget" && budgets && (
				<BudgetForm
					key="add-budget"
					agents={agents}
					llmModels={llmModels}
					modelsFailed={modelsFailed}
					names={names}
					typePicker={picker("budget")}
					onClose={closeAdd}
					onSaved={(saved) => {
						setBudgets((current) => [...(current ?? []), saved]);
						setNotice("Budget added.");
						closeAdd();
						void refresh();
					}}
				/>
			)}
			{canEdit && adding === "video-limit" && videoDisabled === null && (
				<VideoLimitForm
					key="add-video-limit"
					agents={agents}
					names={names}
					connected={connected}
					typePicker={picker("video-limit")}
					onClose={closeAdd}
					onSaved={(saved) => {
						setVideo((current) =>
							current
								? { ...current, limits: [...current.limits, saved] }
								: current,
						);
						setNotice("Limit added.");
						closeAdd();
						void refresh();
					}}
				/>
			)}
			<section className="models-overview" aria-label="Policy overview">
				<div>
					<span className="overview-value">
						{budgets ? budgets.length : "—"}
					</span>
					<span>Budgets</span>
				</div>
				<div>
					<span className="overview-value">
						{video ? video.limits.length : "—"}
					</span>
					<span>Video limits</span>
				</div>
				<div>
					<span className="overview-value">
						{budgets ? refusing.length : "—"}
					</span>
					<span>Budgets refusing requests now</span>
				</div>
				<p>Spend is estimated from list prices.</p>
			</section>
			<BudgetsCard
				budgets={budgets}
				agents={agents}
				llmModels={llmModels}
				modelsFailed={modelsFailed}
				canEdit={canEdit}
				loading={loading}
				onChange={(update) =>
					setBudgets((current) => (current ? update(current) : current))
				}
				onNotice={setNotice}
				onRefresh={() => void refresh()}
				onAdd={() => openAdd("budget")}
			/>
			<VideoLimitsCard
				limits={video?.limits ?? null}
				agents={agents}
				connected={connected}
				canEdit={canEdit}
				available={videoAvailable}
				loading={loading}
				failed={videoFailed}
				onChange={(update) => {
					setVideo((current) =>
						current ? { ...current, limits: update(current.limits) } : current,
					);
					// A read started before this change would undo it on screen.
					void refresh();
				}}
				onNotice={setNotice}
				onAdd={() => openAdd("video-limit")}
				onRetry={() => void refresh()}
			/>
		</div>
	);
}
