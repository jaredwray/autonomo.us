import type { LoopDetail, LoopRun, LoopRunCommand } from "@autonomo.us/common";
import { useEffect, useState } from "react";
import { loopsRequest } from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { loopLink, observedTime, useLoopRead } from "./loops-state.js";
import { useOrgAction } from "./OrganizationControls.js";

const stateLabel = (status: LoopRun["status"]) =>
	status === "changes_requested"
		? "Changes requested"
		: status.charAt(0).toUpperCase() + status.slice(1);
export function LoopRuns({
	workspace,
	loop,
}: {
	workspace: string;
	loop: LoopDetail;
}) {
	return (
		<section className="card">
			<h2>Recent runs</h2>
			{loop.runs.length ? (
				<ul className="loop-runs">
					{loop.runs.map((run) => (
						<li key={run.id}>
							<a
								href={loopLink(
									workspace,
									loop.id,
									"workflow",
									"activity",
									run.id,
								)}
							>
								{run.workId} · {run.workRevision}
							</a>
							<span>
								{stateLabel(run.status)} · v{run.version}
							</span>
						</li>
					))}
				</ul>
			) : (
				<p>No workflow runs yet.</p>
			)}
		</section>
	);
}

function RunAction({
	workspace,
	run,
	userId,
	refresh,
}: {
	workspace: string;
	run: LoopRun;
	userId: string;
	refresh: () => void;
}) {
	const action = useOrgAction();
	const [evidence, setEvidence] = useState("");
	const [cost, setCost] = useState("");
	const step = run.workflow.steps[run.stepIndex];
	if (
		run.status !== "active" ||
		step?.kind === "decision" ||
		!step ||
		step.assignee?.kind !== "user" ||
		step.assignee.id !== userId
	)
		return null;
	const mine = run.claimedBy?.kind === "user" && run.claimedBy.id === userId;
	const verify = step.kind === "verify";
	const command = (next: LoopRunCommand["action"]) =>
		action.run(async () => {
			const body: LoopRunCommand = {
				expectedRevision: run.revision,
				action: next,
			};
			if (next !== "claim" && evidence.trim()) body.evidence = evidence.trim();
			if (next === "complete" && step.kind === "action" && cost !== "")
				body.costCents = Math.round(Number(cost) * 100);
			await loopsRequest(
				workspace,
				`/${encodeURIComponent(run.loopId)}/runs/${encodeURIComponent(run.id)}/actions`,
				{ method: "POST", body },
			);
			refresh();
		});
	return (
		<section className="org-form">
			<h3>Your assignment</h3>
			{step.maxCostCents !== undefined && (
				<p>
					Authorized cost up to ${(step.maxCostCents / 100).toFixed(2)} USD.
				</p>
			)}
			{(mine || verify) && (
				<label>
					Evidence reference
					<input
						value={evidence}
						onChange={(e) => setEvidence(e.target.value)}
						placeholder="work:result-123"
						maxLength={250}
					/>
				</label>
			)}
			{mine && step.kind === "action" && (
				<label>
					Actual cost (USD)
					<input
						type="number"
						min="0"
						step="0.01"
						max={
							step.maxCostCents === undefined
								? undefined
								: step.maxCostCents / 100
						}
						value={cost}
						onChange={(e) => setCost(e.target.value)}
					/>
				</label>
			)}
			{action.error && <p role="alert">{action.error}</p>}
			<div className="org-actions">
				{verify ? (
					<>
						<button
							className="button primary"
							type="button"
							disabled={action.busy || !evidence.trim()}
							onClick={() => void command("pass")}
						>
							Pass verification
						</button>
						<button
							className="button"
							type="button"
							disabled={action.busy || !evidence.trim()}
							onClick={() => void command("fail")}
						>
							Fail verification
						</button>
					</>
				) : mine ? (
					<button
						className="button primary"
						type="button"
						disabled={
							action.busy ||
							!evidence.trim() ||
							(step.maxCostCents !== undefined && !cost)
						}
						onClick={() => void command("complete")}
					>
						Report completion
					</button>
				) : (
					!run.claimedBy && (
						<button
							className="button primary"
							type="button"
							disabled={action.busy}
							onClick={() => void command("claim")}
						>
							Claim assignment
						</button>
					)
				)}
			</div>
		</section>
	);
}

export function LoopActivity({
	workspace,
	loop,
	userId,
	runId,
	refresh,
}: {
	workspace: string;
	loop: LoopDetail;
	userId: string;
	runId?: string;
	refresh: () => void;
}) {
	const first = (loop.runs.find((r) => r.status === "active") ?? loop.runs[0])
		?.id;
	const [initial, setInitial] = useState(first);
	useEffect(() => {
		if (!initial && first) setInitial(first);
	}, [initial, first]);
	const selected = runId ?? initial ?? first;
	const recent = loop.runs.find((r) => r.id === selected);
	const archived = useLoopRead<LoopRun>(
		workspace,
		selected && !recent
			? `/${encodeURIComponent(loop.id)}/runs/${encodeURIComponent(selected)}`
			: null,
		0,
		true,
	);
	const run = recent ?? archived.data;
	if (selected && !run && !archived.error)
		return <p role="status">Loading workflow run…</p>;
	if (!run)
		return (
			<div className="card">
				{selected ? (
					<>
						<p role="alert">{archived.error || "This run is unavailable."}</p>
						<a href={loopLink(workspace, loop.id, "workflow", "activity")}>
							Recent activity
						</a>
					</>
				) : (
					<p>
						No runs yet. Runs start when reported observations meet the workflow
						trigger.
					</p>
				)}
			</div>
		);
	const step = run.workflow.steps[run.stepIndex];
	return (
		<section className="card loop-activity">
			<div className="section-heading">
				<h2>Run activity</h2>
				<Dropdown
					aria-label="Select a run"
					value={run.id}
					onValueChange={(id) => {
						window.location.hash = loopLink(
							workspace,
							loop.id,
							"workflow",
							"activity",
							id,
						);
					}}
				>
					{(recent ? loop.runs : [run, ...loop.runs]).map((r) => (
						<option key={r.id} value={r.id}>
							{r.workId} · {r.workRevision}
						</option>
					))}
				</Dropdown>
			</div>
			<div>
				<h3>{run.workId}</h3>
				<p className="loop-muted">
					Revision {run.workRevision} · Workflow v{run.version} ·{" "}
					{stateLabel(run.status)}
				</p>
			</div>
			<ol className="loop-steps">
				{run.workflow.steps.map((s, i) => (
					<li
						key={s.id}
						aria-current={
							i === run.stepIndex && run.status === "active"
								? "step"
								: undefined
						}
					>
						<span className="eyebrow">
							{s.kind} ·{" "}
							{run.status === "completed" || i < run.stepIndex
								? "Complete"
								: i === run.stepIndex
									? run.status === "active"
										? "Current"
										: "Stopped"
									: run.status === "active"
										? "Queued"
										: "Skipped"}
						</span>
						<strong>{s.name}</strong>
					</li>
				))}
			</ol>
			{run.caseId && (
				<a href={loopLink(workspace, "decisions", "cases", run.caseId)}>
					{run.status === "active" && step?.kind === "decision"
						? "Review decision"
						: "View decision"}
				</a>
			)}
			<RunAction
				key={`${run.id}/${run.revision}`}
				workspace={workspace}
				run={run}
				userId={userId}
				refresh={refresh}
			/>
			<h3>Activity history</h3>
			<ol className="org-history">
				{run.events.map((event, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: Events are an immutable ordered log.
					<li key={`${event.at}-${i}`}>
						<strong>{event.message}</strong>
						<small>
							{observedTime(event.at)}
							{event.costCents !== undefined &&
								` · $${(event.costCents / 100).toFixed(2)} USD`}
						</small>
						{event.evidence && <code>{event.evidence}</code>}
					</li>
				))}
			</ol>
			<button type="button" className="button" onClick={refresh}>
				Refresh activity
			</button>
		</section>
	);
}
