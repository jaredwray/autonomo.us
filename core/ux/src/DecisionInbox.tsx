import type {
	ActOnDecision,
	DecisionAction,
	DecisionCase,
	DecisionCasePage,
	OpenDecisionCase,
	WorkspaceAccess,
} from "@autonomo.us/common";
import { useEffect, useState } from "react";
import { organizationRequest } from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { loopLink } from "./loops-state.js";
import {
	PositionPicker,
	RouteTrace,
	useOrgAction,
} from "./OrganizationControls.js";
import {
	orgLink,
	queryPath,
	routeItem,
	useOrgRead,
} from "./organization-state.js";
import { PageTabs } from "./PageTabs.js";
import "./organization.css";

function NewCase({
	workspace,
	onSaved,
	cancel,
}: {
	workspace: string;
	onSaved: (c: DecisionCase) => void;
	cancel: () => void;
}) {
	const [position, setPosition] = useState("");
	const action = useOrgAction();
	return (
		<form
			className="card org-form"
			onSubmit={(e) => {
				e.preventDefault();
				const fields = new FormData(e.currentTarget);
				const value = (key: string) => String(fields.get(key) ?? "").trim();
				const input: OpenDecisionCase = {
					decisionKey: value("key"),
					question: value("question"),
					sourceWorkId: value("work"),
					sourceRevision: value("revision"),
					requesterPositionId: position || undefined,
				};
				if (value("ref"))
					input.evidence = [
						{ label: value("label") || "Evidence", ref: value("ref") },
					];
				void action.run(async () =>
					onSaved(
						await organizationRequest<DecisionCase>(workspace, "/cases", {
							method: "POST",
							body: input,
						}),
					),
				);
			}}
		>
			<h2>Request a decision</h2>
			<label>
				Question
				<textarea name="question" required />
			</label>
			<label>
				Decision key
				<input name="key" required />
			</label>
			<label>
				Work ID
				<input name="work" required />
			</label>
			<label>
				Work revision
				<input name="revision" required />
			</label>
			<PositionPicker
				workspace={workspace}
				label="My initiating position"
				ownOnly
				value={position}
				onChange={setPosition}
				optional
			/>
			<label>
				Evidence label
				<input name="label" />
			</label>
			<label>
				Evidence reference
				<input name="ref" placeholder="work:reference-b" />
			</label>
			{action.error && <p role="alert">{action.error}</p>}
			<div className="org-actions">
				<button type="submit" className="button primary" disabled={action.busy}>
					Open case
				</button>
				<button type="button" className="button" onClick={cancel}>
					Cancel
				</button>
			</div>
		</form>
	);
}

function CaseDetail({
	workspace,
	id,
	revision,
	refresh,
}: {
	workspace: string;
	id: string;
	revision: number;
	refresh: () => void;
}) {
	const [choice, setChoice] = useState<DecisionAction | null>(null);
	const [reason, setReason] = useState("");
	const [target, setTarget] = useState("");
	const action = useOrgAction();
	const resource = useOrgRead<DecisionCase>(
		workspace,
		`/cases/${encodeURIComponent(id)}`,
		revision,
		organizationRequest,
		!choice && !action.busy,
	);
	const c = resource.data;
	if (resource.error)
		return (
			<article className="card">
				<p role="alert">{resource.error}</p>
			</article>
		);
	if (!c)
		return (
			<article className="card" role="status">
				Loading decision…
			</article>
		);
	async function act(record: DecisionCase, kind: DecisionAction) {
		window.location.hash = orgLink(
			workspace,
			"loops/decisions",
			"cases",
			record.id,
		);
		const input: ActOnDecision = {
			action: kind,
			expectedRevision: record.revision,
			reason: kind === "approve" ? undefined : reason.trim() || undefined,
			targetPositionId: kind === "handoff" ? target : undefined,
		};
		try {
			await organizationRequest<DecisionCase>(
				workspace,
				`/cases/${encodeURIComponent(record.id)}/act`,
				{ method: "POST", body: input },
			);
			setChoice(null);
			setReason("");
			setTarget("");
		} finally {
			refresh();
		}
	}
	const linkedRun = /^loop-run:([\w-]+):([\w-]+)$/.exec(c.sourceWorkId);
	return (
		<article className="card org-case">
			<p className="eyebrow">
				{c.decisionKey} · {c.status.replaceAll("_", " ")}
			</p>
			<h2>{c.question}</h2>
			<dl>
				<dt>Blocked work</dt>
				<dd>
					{linkedRun ? (
						<a
							href={loopLink(
								workspace,
								linkedRun[1],
								"workflow",
								"activity",
								linkedRun[2],
							)}
						>
							View workflow run
						</a>
					) : (
						c.sourceWorkId
					)}{" "}
					· revision {c.sourceRevision}
				</dd>
				<dt>Requested by</dt>
				<dd>{c.requester.name}</dd>
				<dt>Assigned to</dt>
				<dd>{c.assignee?.name ?? "Human triage"}</dd>
				<dt>Due</dt>
				<dd>
					{c.deadline
						? new Date(c.deadline).toLocaleString()
						: "No active deadline"}
				</dd>
			</dl>
			{c.evidence.length > 0 && (
				<section>
					<h3>Evidence</h3>
					<ul>
						{c.evidence.map((e) => (
							<li key={e.ref}>
								<strong>{e.label}</strong> <code>{e.ref}</code>
							</li>
						))}
					</ul>
				</section>
			)}
			{c.outcome && (
				<section>
					<h3>Outcome</h3>
					<p>
						{c.outcome.by.name} · {c.outcome.status.replaceAll("_", " ")}
						{c.outcome.reason && ` · ${c.outcome.reason}`}
					</p>
				</section>
			)}
			{action.error && <p role="alert">{action.error}</p>}
			{(c.canAct || c.canHandoff) && (
				<div className="org-actions">
					{c.canAct && (
						<>
							<button
								className="button primary"
								type="button"
								disabled={action.busy}
								onClick={() => void action.run(() => act(c, "approve"))}
							>
								Approve
							</button>
							<button
								className="button"
								type="button"
								disabled={action.busy}
								onClick={() => setChoice("request_changes")}
							>
								Request changes
							</button>
						</>
					)}
					{c.canHandoff && (
						<button
							className="button"
							type="button"
							disabled={action.busy}
							onClick={() => setChoice("handoff")}
						>
							Hand off
						</button>
					)}
				</div>
			)}
			{((choice === "request_changes" && c.canAct) ||
				(choice === "handoff" && c.canHandoff)) && (
				<form
					className="org-form"
					onSubmit={(e) => {
						e.preventDefault();
						if (choice) void action.run(() => act(c, choice));
					}}
				>
					{choice === "handoff" &&
						(c.status === "triage" ? (
							<PositionPicker
								workspace={workspace}
								label="Next position"
								value={target}
								onChange={setTarget}
							/>
						) : (
							<label>
								Next position
								<Dropdown
									value={target}
									onValueChange={setTarget}
									aria-label="Next position"
								>
									<option value="">Choose a fallback</option>
									{c.route.steps
										.slice(
											c.route.steps.findIndex(
												(s) => s.position.id === c.assigneePositionId,
											) + 1,
										)
										.map((s) => (
											<option key={s.position.id} value={s.position.id}>
												{s.position.title}
											</option>
										))}
								</Dropdown>
							</label>
						))}
					<label>
						Reason
						<textarea
							value={reason}
							onChange={(e) => setReason(e.target.value)}
							required
						/>
					</label>
					<div className="org-actions">
						<button
							className="button primary"
							type="submit"
							disabled={
								action.busy ||
								!reason.trim() ||
								(choice === "handoff" && !target)
							}
						>
							Submit {choice === "handoff" ? "handoff" : "changes"}
						</button>
						<button
							className="button"
							type="button"
							onClick={() => setChoice(null)}
						>
							Cancel
						</button>
					</div>
				</form>
			)}
			<details>
				<summary>Routing at the time of request</summary>
				<RouteTrace workspace={workspace} route={c.route} />
			</details>
			<section>
				<h3>Decision history</h3>
				<ol className="org-history">
					{c.history.map((h, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: This immutable audit log is append-only and its sequence distinguishes simultaneous entries.
						<li key={`${h.at}-${index}`}>
							<strong>{h.event.replaceAll("_", " ")}</strong> ·{" "}
							{h.by?.name ?? "System"}
							{h.assignee ? ` · ${h.assignee.name}` : ""}
							<p>{h.reason}</p>
							<small>{new Date(h.at).toLocaleString()}</small>
						</li>
					))}
				</ol>
			</section>
		</article>
	);
}

type QueueView = "pending" | "assigned" | "requested" | "triage";
export function DecisionInbox({
	workspace,
	route,
	onChange,
}: {
	workspace: WorkspaceAccess;
	route: string;
	onChange: () => void;
}) {
	const selected = routeItem(route, "cases");
	const [view, setView] = useState<QueueView>("pending");
	const [cursor, setCursor] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [revision, setRevision] = useState(0);
	const refresh = () => {
		setRevision((v) => v + 1);
		onChange();
	};
	const queue = queryPath("/cases", { view, after: cursor });
	const [selection, setSelection] = useState<{ queue: string; id: string }>();
	const list = useOrgRead<DecisionCasePage>(
		workspace.id,
		queue,
		revision,
		organizationRequest,
		!creating,
	);
	const tabs: { id: QueueView; label: string }[] = [
		{ id: "pending", label: "Pending" },
		{ id: "assigned", label: "Assigned to me" },
		{ id: "requested", label: "Requested by me" },
	];
	if (workspace.role === "admin")
		tabs.push({ id: "triage", label: "Human triage" });
	const first = list.data?.cases[0]?.id;
	useEffect(() => {
		if (!selected && first)
			setSelection((previous) =>
				previous?.queue === queue ? previous : { queue, id: first },
			);
	}, [selected, queue, first]);
	const focus = selected ?? (selection?.queue === queue ? selection.id : first);
	return (
		<div>
			<header className="dashboard-header">
				<h2>Decisions</h2>
				<button
					className="button primary"
					type="button"
					onClick={() => setCreating(true)}
				>
					Request a decision
				</button>
			</header>
			{creating && (
				<NewCase
					workspace={workspace.id}
					cancel={() => setCreating(false)}
					onSaved={(c) => {
						setCreating(false);
						setView("requested");
						setCursor(null);
						window.location.hash = orgLink(
							workspace.id,
							"loops/decisions",
							"cases",
							c.id,
						);
						refresh();
					}}
				/>
			)}
			<PageTabs
				idPrefix="decision-inbox"
				label="Decision queues"
				tabs={tabs}
				selected={view}
				onSelect={(next) => {
					setView(next);
					setCursor(null);
					window.location.hash = orgLink(workspace.id, "loops/decisions");
				}}
			/>
			<div
				role="tabpanel"
				id="decision-inbox-panel"
				aria-labelledby={`decision-inbox-tab-${view}`}
				className="org-layout org-inbox"
			>
				<div className="card">
					<div className="section-heading">
						<h3>Decisions in this queue</h3>
						<button type="button" className="button" onClick={refresh}>
							Refresh
						</button>
					</div>
					{list.error ? (
						<p role="alert">{list.error}</p>
					) : !list.data ? (
						<p role="status">Loading decisions…</p>
					) : list.data.cases.length ? (
						<ul className="org-queue">
							{list.data.cases.map((c) => (
								<li key={c.id}>
									<a
										aria-current={focus === c.id ? "true" : undefined}
										href={orgLink(
											workspace.id,
											"loops/decisions",
											"cases",
											c.id,
										)}
									>
										<strong>{c.question}</strong>
										<small>
											{c.assignee?.name ?? "Human triage"} ·{" "}
											{c.status.replaceAll("_", " ")}
											{c.deadline &&
												` · Due ${new Date(c.deadline).toLocaleString()}`}
										</small>
									</a>
								</li>
							))}
						</ul>
					) : (
						<p>No decisions in this queue.</p>
					)}
					<div className="org-actions">
						{cursor && (
							<button
								className="button"
								type="button"
								onClick={() => setCursor(null)}
							>
								First page
							</button>
						)}
						{list.data?.next && (
							<button
								className="button"
								type="button"
								onClick={() => setCursor(list.data?.next ?? null)}
							>
								Next decisions
							</button>
						)}
					</div>
				</div>
				{focus && (
					<CaseDetail
						workspace={workspace.id}
						id={focus}
						key={focus}
						revision={revision}
						refresh={refresh}
					/>
				)}
			</div>
		</div>
	);
}
