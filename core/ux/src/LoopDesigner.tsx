import type {
	CreateLoop,
	DecisionRule,
	LoopDetail,
	LoopMetric,
	LoopStep,
	LoopWorkflow,
	OrgIdentity,
	PublishLoopWorkflow,
} from "@autonomo.us/common";
import { useId, useState } from "react";
import { loopsRequest } from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { LoopPreviewPanel } from "./LoopPreviewPanel.js";
import {
	OccupantPicker,
	PositionPicker,
	useOrgAction,
} from "./OrganizationControls.js";
import { orgLink, useOrgRead } from "./organization-state.js";

function initialWorkflow(): LoopWorkflow {
	return {
		triggerCount: 1,
		decisionKey: "",
		steps: [
			{
				id: "review",
				kind: "decision",
				name: "Review the proposed change",
				assignee: null,
			},
			{
				id: "action",
				kind: "action",
				name: "Carry out the approved change",
				assignee: null,
			},
			{
				id: "verify",
				kind: "verify",
				name: "Verify the outcome",
				assignee: null,
			},
		],
	};
}
export function WorkflowSteps({
	workflow,
	workspace,
	canManage,
}: {
	workflow: LoopWorkflow;
	workspace: string;
	canManage: boolean;
}) {
	const people = useOrgRead<{ identities: OrgIdentity[] }>(
		workspace,
		canManage ? "/identities" : null,
	);
	return (
		<ol className="loop-steps">
			<li>
				<span className="eyebrow">Trigger</span>
				<strong>
					{workflow.triggerCount} flagged{" "}
					{workflow.triggerCount === 1 ? "observation" : "observations"} for the
					same work revision
				</strong>
			</li>
			{workflow.steps.map((s) => (
				<li key={s.id}>
					<span className="eyebrow">{s.kind}</span>
					<strong>{s.name}</strong>
					{s.assignee && (
						<small>
							Assigned to{" "}
							{people.data?.identities.find(
								(p) => p.kind === s.assignee?.kind && p.id === s.assignee?.id,
							)?.name ?? s.assignee.id}
						</small>
					)}
					{s.maxCostCents !== undefined && (
						<small>
							Authorized up to ${(s.maxCostCents / 100).toFixed(2)} USD
						</small>
					)}
					{s.kind === "decision" && (
						<small>Organization rule · {workflow.decisionKey}</small>
					)}
				</li>
			))}
		</ol>
	);
}

function WorkflowFields({
	workspace,
	workflow,
	onChange,
}: {
	workspace: string;
	workflow: LoopWorkflow;
	onChange: (w: LoopWorkflow) => void;
}) {
	const [selected, setSelected] = useState(workflow.steps[0].id);
	const people = useOrgRead<{ identities: OrgIdentity[] }>(
		workspace,
		"/identities",
	);
	const rules = useOrgRead<{ rules: DecisionRule[] }>(workspace, "/rules");
	const ruleList = useId();
	const rule = rules.data?.rules.find((r) => r.key === workflow.decisionKey);
	const [names, setNames] = useState<Record<string, string>>({});
	const i = workflow.steps.findIndex((s) => s.id === selected);
	const step = workflow.steps[i] ?? workflow.steps[0];
	const onStep = (change: Partial<LoopStep>) =>
		onChange({
			...workflow,
			steps: workflow.steps.map((s) =>
				s.id === step.id ? { ...s, ...change } : s,
			),
		});
	const insertTask = () => {
		const newStep: LoopStep = {
			id: crypto.randomUUID(),
			kind: "task",
			name: "Follow-up task",
			assignee: null,
		};
		onChange({
			...workflow,
			steps: [
				...workflow.steps.slice(0, -1),
				newStep,
				workflow.steps.at(-1) as LoopStep,
			],
		});
		setSelected(newStep.id);
	};
	const move = (offset: number) => {
		const steps = [...workflow.steps];
		[steps[i], steps[i + offset]] = [steps[i + offset], steps[i]];
		onChange({ ...workflow, steps });
	};
	const assignee = step.assignee;
	const key = assignee ? `${assignee.kind}:${assignee.id}` : "";
	const knownName =
		names[key] ??
		people.data?.identities.find(
			(p) => p.id === assignee?.id && p.kind === assignee?.kind,
		)?.name;
	return (
		<>
			<div className="loop-field-grid">
				<label>
					Trigger after flagged observations
					<input
						type="number"
						min="1"
						step="1"
						required
						max={100}
						value={workflow.triggerCount || ""}
						onChange={(e) =>
							onChange({
								...workflow,
								triggerCount: e.currentTarget.valueAsNumber,
							})
						}
					/>
				</label>
				<label>
					Decision rule key
					<input
						required
						maxLength={80}
						list={ruleList}
						placeholder="visual-continuity"
						value={workflow.decisionKey}
						onChange={(e) =>
							onChange({ ...workflow, decisionKey: e.target.value })
						}
					/>
				</label>
			</div>{" "}
			<datalist id={ruleList}>
				{rules.data?.rules.map((r) => (
					<option key={r.key} value={r.key} />
				))}
			</datalist>
			<p className="loop-muted">
				The decision follows the workspace’s{" "}
				<a href={orgLink(workspace, "organization", "escalations")}>
					escalation rules
				</a>
				. {rule && `Response window ${rule.deadlineMinutes} minutes.`}
			</p>
			<div className="loop-editor">
				<div>
					<ol className="loop-steps">
						{workflow.steps.map((s, number) => (
							<li key={s.id}>
								<button
									type="button"
									aria-pressed={s.id === step.id}
									onClick={() => setSelected(s.id)}
								>
									<span className="eyebrow">
										{number + 1} · {s.kind}
									</span>
									<strong>{s.name || "Untitled step"}</strong>
								</button>
							</li>
						))}
					</ol>
					{workflow.steps.length < 20 && (
						<button className="button" type="button" onClick={insertTask}>
							Add task
						</button>
					)}
				</div>
				<section className="loop-inspector" aria-label="Step settings">
					<label>
						Step name
						<input
							maxLength={140}
							required
							value={step.name}
							onChange={(e) => onStep({ name: e.target.value })}
						/>
					</label>
					{step.kind !== "decision" && (
						<OccupantPicker
							loopAct
							workspace={workspace}
							label={
								step.kind === "verify" ? "Independent verifier" : "Assigned to"
							}
							value={assignee ? { ...assignee, name: knownName } : null}
							onChange={(p) => {
								if (p)
									setNames((current) => ({
										...current,
										[`${p.kind}:${p.id}`]: p.name,
									}));
								onStep({ assignee: p ? { kind: p.kind, id: p.id } : null });
							}}
						/>
					)}
					{step.kind === "action" && (
						<label>
							Maximum cost (USD)
							<input
								type="number"
								min="0"
								step="0.01"
								value={
									step.maxCostCents === undefined ? "" : step.maxCostCents / 100
								}
								onChange={(e) =>
									onStep({
										maxCostCents:
											e.target.value === ""
												? undefined
												: Math.round(e.currentTarget.valueAsNumber * 100),
									})
								}
							/>
						</label>
					)}
					{step.kind === "verify" && (
						<small className="loop-muted">
							Choose someone who does not perform an action or task in this
							workflow.
						</small>
					)}
					{step.kind === "task" && (
						<div className="org-actions">
							<button
								className="button"
								type="button"
								disabled={i <= 1}
								onClick={() => move(-1)}
							>
								Move up
							</button>
							<button
								className="button"
								type="button"
								disabled={i >= workflow.steps.length - 2}
								onClick={() => move(1)}
							>
								Move down
							</button>
							<button
								className="button"
								type="button"
								onClick={() => {
									onChange({
										...workflow,
										steps: workflow.steps.filter((s) => s.id !== step.id),
									});
									setSelected(workflow.steps[Math.max(0, i - 1)].id);
								}}
							>
								Remove task
							</button>
						</div>
					)}
				</section>
			</div>
		</>
	);
}

function workflowError(workflow: LoopWorkflow) {
	for (const step of workflow.steps) {
		if (!step.name.trim()) return "Give each workflow step a name.";
		if (step.kind !== "decision" && !step.assignee)
			return `Select an assignee for “${step.name}”.`;
	}
	const verifier = workflow.steps.find((s) => s.kind === "verify")?.assignee;
	if (
		verifier &&
		workflow.steps.some(
			(s) =>
				(s.kind === "action" || s.kind === "task") &&
				s.assignee?.kind === verifier.kind &&
				s.assignee.id === verifier.id,
		)
	)
		return "Assign verification to someone independent of the action and tasks.";
}

export function LoopDesigner({
	workspace,
	loop,
	onSaved,
	cancel,
}: {
	workspace: string;
	loop?: LoopDetail;
	onSaved: (l: LoopDetail) => void;
	cancel: () => void;
}) {
	const [workflow, setWorkflow] = useState<LoopWorkflow>(
		() => loop?.workflow ?? initialWorkflow(),
	);
	const [baseVersion] = useState(loop?.version ?? 0);
	const [owner, setOwner] = useState("");
	const [direction, setDirection] =
		useState<LoopMetric["direction"]>("at_least");
	const [error, setError] = useState("");
	const action = useOrgAction();
	return (
		<form
			className="card org-form loop-form"
			onSubmit={(e) => {
				e.preventDefault();
				const issue =
					workflowError(workflow) ||
					(!loop && !owner ? "Choose an accountable position." : "");
				setError(issue);
				if (issue) return;
				const data = new FormData(e.currentTarget);
				const field = (key: string) => String(data.get(key) ?? "").trim();
				void action.run(async () => {
					const body: CreateLoop | PublishLoopWorkflow = loop
						? {
								expectedVersion: baseVersion,
								workflow,
								target: Number(field("target")),
								staleAfterMinutes: Number(field("stale")),
							}
						: {
								name: field("name"),
								goal: field("goal"),
								ownerPositionId: owner,
								workflow,
								metric: {
									name: field("metric"),
									source: field("source"),
									direction,
									target: Number(field("target")),
									staleAfterMinutes: Number(field("stale")),
								},
							};
					onSaved(
						await loopsRequest<LoopDetail>(
							workspace,
							loop ? `/${encodeURIComponent(loop.id)}/workflow` : "",
							{ method: loop ? "PUT" : "POST", body },
						),
					);
				});
			}}
		>
			<h2>{loop ? `Edit workflow v${baseVersion}` : "New loop"}</h2>
			{!loop && (
				<>
					<label>
						Loop name
						<input
							name="name"
							required
							maxLength={140}
							placeholder="Shot continuity"
						/>
					</label>
					<label>
						Outcome
						<textarea
							name="goal"
							required
							maxLength={1000}
							placeholder="Increase the share of shots accepted on their first render."
						/>
					</label>
					<PositionPicker
						workspace={workspace}
						label="Accountable position"
						occupiedOnly
						value={owner}
						onChange={setOwner}
					/>
					<div className="loop-field-grid">
						<label>
							Metric name
							<input
								name="metric"
								required
								maxLength={140}
								placeholder="First-pass acceptance"
							/>
						</label>
						<label>
							Data source
							<input
								name="source"
								required
								maxLength={140}
								placeholder="Studio QC"
							/>
						</label>
						<label>
							Target direction
							<Dropdown
								aria-label="Target direction"
								value={direction}
								onValueChange={(v) =>
									setDirection(v as LoopMetric["direction"])
								}
							>
								<option value="at_least">At least</option>
								<option value="at_most">At most</option>
							</Dropdown>
						</label>
					</div>
				</>
			)}
			<div className="loop-field-grid">
				<label>
					Target (%)
					<input
						name="target"
						required
						type="number"
						min="0"
						max="100"
						step="any"
						defaultValue={loop?.metric.target}
					/>
				</label>
				<label>
					Mark data stale after (minutes)
					<input
						name="stale"
						required
						type="number"
						min="1"
						max="525600"
						step="1"
						defaultValue={loop?.metric.staleAfterMinutes ?? 1440}
					/>
				</label>
			</div>
			{!loop && <h3>Workflow</h3>}
			<WorkflowFields
				workspace={workspace}
				workflow={workflow}
				onChange={setWorkflow}
			/>
			<LoopPreviewPanel
				workspace={workspace}
				ownerPositionId={loop?.ownerPositionId ?? owner}
				workflow={workflow}
			/>
			{(error || action.error) && <p role="alert">{error || action.error}</p>}
			{loop && (
				<p className="loop-muted">
					Publishing applies this version to future runs. Active runs follow the
					version that started them.
				</p>
			)}
			<div className="org-actions">
				<button className="button primary" type="submit" disabled={action.busy}>
					{loop ? "Publish workflow" : "Create loop"}
				</button>
				<button
					className="button"
					type="button"
					disabled={action.busy}
					onClick={cancel}
				>
					Cancel
				</button>
			</div>
		</form>
	);
}
