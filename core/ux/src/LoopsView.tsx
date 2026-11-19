import type {
	LoopDetail,
	LoopSummary,
	WorkspaceAccess,
} from "@autonomo.us/common";
import { useState } from "react";
import { DecisionInbox } from "./DecisionInbox.js";
import { LoopActivity, LoopRuns } from "./LoopActivity.js";
import { LoopDesigner, WorkflowSteps } from "./LoopDesigner.js";
import { LoopCard, LoopMetric, LoopStatus } from "./LoopMetric.js";
import { LoopSamples } from "./LoopSamples.js";
import { loopLink, observedTime, useLoopRead } from "./loops-state.js";
import { PageTabs } from "./PageTabs.js";
import "./loops.css";

const decode = (segment: string | undefined) => {
	try {
		return decodeURIComponent(segment ?? "");
	} catch {
		return "";
	}
};

function Observations({
	workspace,
	loop,
}: {
	workspace: string;
	loop: LoopDetail;
}) {
	return (
		<section className="card loop-evidence">
			<div className="section-heading">
				<h2>Recent observations</h2>
				<span className="loop-muted">{loop.metric.source}</span>
			</div>
			{loop.observations.length ? (
				<div className="table-scroll">
					<table className="token-log-table">
						<thead>
							<tr>
								<th>Observed</th>
								<th>Work revision</th>
								<th>Reported by</th>
								<th>Sample</th>
								<th>Evidence</th>
							</tr>
						</thead>
						<tbody>
							{loop.observations.map((o) => (
								<tr key={o.eventId}>
									<td>
										<time dateTime={o.observedAt}>
											{observedTime(o.observedAt)}
										</time>
									</td>
									<td>
										{o.workId} · {o.workRevision}
									</td>
									<td>
										{o.actor.kind} · {o.actor.id}
									</td>
									<td>
										{o.denominator
											? `${o.numerator} / ${o.denominator}`
											: "Trigger only"}
									</td>
									<td>{o.evidence ? <code>{o.evidence}</code> : "—"}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p>Waiting for the first observation from {loop.metric.source}.</p>
			)}
			<details>
				<summary>Connect a data source</summary>
				<p>
					Send observations from your source to this workspace endpoint with a
					token that has the <code>loops:report</code> permission.
				</p>
				<code className="loop-endpoint">
					POST /v1/{encodeURIComponent(workspace)}/loops/
					{encodeURIComponent(loop.id)}/observations
				</code>
				<p>
					Include a stable event ID, the work ID and revision, observation time,
					numerator, denominator, and whether this event counts toward the
					trigger.
				</p>
			</details>
		</section>
	);
}

function Detail({
	workspace,
	loopId,
	segments,
	userId,
}: {
	workspace: WorkspaceAccess;
	loopId: string;
	segments: string[];
	userId: string;
}) {
	const [revision, setRevision] = useState(0);
	const [editing, setEditing] = useState(false);
	const tab = segments[0] === "workflow" ? "workflow" : "overview";
	const mode = segments[1] === "activity" ? "activity" : "design";
	const result = useLoopRead<LoopDetail>(
		workspace.id,
		`/${encodeURIComponent(loopId)}`,
		revision,
		tab === "workflow" && mode === "activity",
	);
	const loop = result.data;
	const refresh = () => setRevision((v) => v + 1);
	const nav = (...rest: string[]) => {
		setEditing(false);
		window.location.hash = loopLink(workspace.id, loopId, ...rest);
	};
	return (
		<div className="dashboard loops">
			<a className="loop-back" href={loopLink(workspace.id)}>
				All loops
			</a>
			{result.error ? (
				<p role="alert">{result.error}</p>
			) : !loop ? (
				<p role="status">Loading loop…</p>
			) : (
				<>
					<header className="dashboard-header">
						<div>
							<p className="eyebrow">{loop.ownerName}</p>
							<h1>{loop.name}</h1>
							<p className="loop-muted">{loop.goal}</p>
						</div>
						<LoopStatus loop={loop} />
					</header>
					<PageTabs<"overview" | "workflow">
						idPrefix="loop-detail"
						label="Loop views"
						tabs={[
							{ id: "overview", label: "Overview" },
							{ id: "workflow", label: "Workflow" },
						]}
						selected={tab}
						onSelect={(next) =>
							nav(...(next === "workflow" ? ["workflow"] : []))
						}
					/>
					<div
						role="tabpanel"
						id="loop-detail-panel"
						aria-labelledby={`loop-detail-tab-${tab}`}
					>
						{tab === "overview" ? (
							<div className="loop-stack">
								<div className="card">
									<LoopMetric loop={loop} />
									<LoopSamples
										workspace={workspace.id}
										loop={loop}
										expanded={segments[0] === "samples"}
									/>
								</div>
								<LoopRuns workspace={workspace.id} loop={loop} />
								<Observations workspace={workspace.id} loop={loop} />
							</div>
						) : (
							<>
								<PageTabs<"design" | "activity">
									idPrefix="loop-workflow"
									label="Workflow views"
									tabs={[
										{ id: "design", label: "Design" },
										{ id: "activity", label: "Activity" },
									]}
									selected={mode}
									onSelect={(next) => nav("workflow", next)}
								/>
								<div
									role="tabpanel"
									id="loop-workflow-panel"
									aria-labelledby={`loop-workflow-tab-${mode}`}
								>
									{mode === "activity" ? (
										<LoopActivity
											workspace={workspace.id}
											loop={loop}
											userId={userId}
											runId={segments[2]}
											refresh={refresh}
										/>
									) : editing && workspace.role === "admin" ? (
										<LoopDesigner
											workspace={workspace.id}
											loop={loop}
											cancel={() => setEditing(false)}
											onSaved={() => {
												setEditing(false);
												refresh();
											}}
										/>
									) : (
										<section className="card">
											<div className="section-heading">
												<div>
													<p className="eyebrow">Published v{loop.version}</p>
													<h2>Workflow steps</h2>
												</div>
												{workspace.role === "admin" && (
													<button
														type="button"
														className="button"
														onClick={() => setEditing(true)}
													>
														Edit workflow
													</button>
												)}
											</div>
											<WorkflowSteps
												workflow={loop.workflow}
												workspace={workspace.id}
												canManage={workspace.role === "admin"}
											/>
										</section>
									)}
								</div>
							</>
						)}
					</div>
				</>
			)}
		</div>
	);
}

type IndexResult = { loops: LoopSummary[]; pendingDecisions: number };
function attentionOrder(a: LoopSummary, b: LoopSummary) {
	const rank = { stale: 0, off_target: 1, no_data: 2, on_target: 3 };
	return (
		Number(b.pendingDecisions > 0) - Number(a.pendingDecisions > 0) ||
		rank[a.status] - rank[b.status] ||
		b.pendingDecisions - a.pendingDecisions ||
		a.name.localeCompare(b.name) ||
		a.id.localeCompare(b.id)
	);
}
function Index({
	workspace,
	route,
}: {
	workspace: WorkspaceAccess;
	route: string;
}) {
	const [revision, setRevision] = useState(0);
	const [creating, setCreating] = useState(false);
	const result = useLoopRead<IndexResult>(
		workspace.id,
		"",
		revision,
		!creating,
	);
	const decisions = route === "/decisions" || route.startsWith("/decisions/");
	const tab = decisions ? "decisions" : "loops";
	const refresh = () => setRevision((v) => v + 1);
	const nav = (next: "loops" | "decisions") => {
		setCreating(false);
		window.location.hash = loopLink(
			workspace.id,
			...(next === "decisions" ? ["decisions"] : []),
		);
	};
	return (
		<div className="dashboard loops">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">{workspace.name}</p>
					<h1>Loops</h1>
					<p className="loop-muted">
						Track outcomes and review decisions across your loops.
					</p>
				</div>
				{!decisions && !creating && workspace.role === "admin" && (
					<button
						type="button"
						className="button primary"
						onClick={() => setCreating(true)}
					>
						New loop
					</button>
				)}
			</header>
			<PageTabs<"loops" | "decisions">
				label="Loops index"
				idPrefix="loops-index"
				tabs={[
					{ id: "loops", label: "Loops" },
					{
						id: "decisions",
						label: result.data
							? `Decisions (${result.data.pendingDecisions})`
							: "Decisions",
					},
				]}
				selected={tab}
				onSelect={nav}
			/>
			<div
				id="loops-index-panel"
				role="tabpanel"
				aria-labelledby={`loops-index-tab-${tab}`}
			>
				{result.error && <p role="alert">{result.error}</p>}
				{decisions ? (
					<DecisionInbox
						workspace={workspace}
						route={route.slice("/decisions".length)}
						onChange={refresh}
					/>
				) : creating && workspace.role === "admin" ? (
					<LoopDesigner
						workspace={workspace.id}
						cancel={() => setCreating(false)}
						onSaved={(loop) => {
							setCreating(false);
							window.location.hash = loopLink(workspace.id, loop.id);
						}}
					/>
				) : result.data ? (
					result.data.loops.length ? (
						<div className="loop-grid">
							{result.data.loops.toSorted(attentionOrder).map((l) => (
								<LoopCard workspace={workspace.id} loop={l} key={l.id} />
							))}
						</div>
					) : (
						<div className="card">
							<h2>No loops yet</h2>
							<p>
								Each loop tracks a metric against a target and starts a workflow
								when observations meet its trigger.
							</p>
						</div>
					)
				) : (
					!result.error && <p role="status">Loading loops…</p>
				)}
			</div>
		</div>
	);
}

export function LoopsView({
	workspace,
	route,
	userId,
}: {
	workspace: WorkspaceAccess;
	route: string;
	userId: string;
}) {
	const [first, ...segments] = route.split("/").filter(Boolean).map(decode);
	if (first && first !== "decisions")
		return (
			<Detail
				key={`${workspace.id}/${first}`}
				workspace={workspace}
				userId={userId}
				loopId={first}
				segments={segments}
			/>
		);
	return <Index key={workspace.id} workspace={workspace} route={route} />;
}
