import type {
	SynapseFinding,
	SynapseFindingKind,
	SynapseMaintenanceBatch,
	SynapseMaintenanceView,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	decideSynapseFindings,
	fetchSynapseMaintenance,
	runSynapseMaintenance,
} from "./api.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { type InlineOptions, renderInline } from "./synapse-markdown.js";
import { noteHash } from "./synapse-route.js";
import { failureMessage, shortDate, shortDateTime } from "./synapse-shared.js";

/** The order findings are reviewed in: what contradicts first. */
const KINDS: readonly {
	kind: SynapseFindingKind;
	label: string;
	one: string;
}[] = [
	{ kind: "conflict", label: "Conflicts", one: "conflict" },
	{
		kind: "duplicate",
		label: "Possible duplicates",
		one: "possible duplicate",
	},
	{ kind: "stale", label: "Stale", one: "stale note" },
	{
		kind: "unsupported",
		label: "Unsupported claims",
		one: "unsupported claim",
	},
];
const plural = (count: number) => `${count} finding${count === 1 ? "" : "s"}`;

/** What applying a finding does, in words. */
function fixText(finding: SynapseFinding): string {
	const { fix } = finding;
	if (!fix) return "Needs an edit by hand: there is no automatic fix.";
	if (fix.action === "merge")
		return `Applying merges “${fix.from}” into “${fix.into}” and deletes “${fix.from}”. Its history keeps what it held.`;
	if (fix.action === "confirm")
		return `Applying confirms “${fix.title}” is still current, reviewed today.`;
	return `Applying marks “${fix.title}” superseded by “${fix.by}”.`;
}

function Finding({
	finding,
	label,
	options,
	selectable,
	selected,
	disabled,
	onSelect,
}: {
	finding: SynapseFinding;
	/** The finding's kind, in the singular. */
	label: string;
	options: InlineOptions;
	/** The viewer may decide it and it is still open. */
	selectable: boolean;
	selected: boolean;
	disabled: boolean;
	onSelect(selected: boolean): void;
}) {
	return (
		<li className="synapse-finding">
			{selectable && (
				<input
					type="checkbox"
					className="synapse-proposal-select"
					aria-label={`Select ${label}: ${finding.titles.join(", ")}`}
					checked={selected}
					disabled={disabled}
					onChange={(event) => onSelect(event.target.checked)}
				/>
			)}
			<div>
				<p className="synapse-finding-summary">
					{renderInline(finding.summary, options)}
				</p>
				{finding.state === "open" ? (
					<p className="synapse-result-meta">{fixText(finding)}</p>
				) : (
					<p className="synapse-result-meta">
						<span className={`synapse-chip synapse-state-${finding.state}`}>
							{finding.state === "applied" ? "Applied" : "Dismissed"}
						</span>
						{finding.decidedBy && ` by ${finding.decidedBy.name}`}
						{finding.decidedAt && ` on ${shortDate(finding.decidedAt)}`}
					</p>
				)}
				{finding.detail && (
					<p className="synapse-finding-detail">
						<strong>Could not apply:</strong> {finding.detail}
					</p>
				)}
			</div>
		</li>
	);
}

/** A space's latest maintenance run: its digest and the findings to review as a batch. */
export function SynapseMaintenance({
	space,
	canEdit,
	onNavigate,
	onChanged,
}: {
	space: string;
	/** False where the viewer may only read, such as Global for members. */
	canEdit: boolean;
	onNavigate(title: string): void;
	/** Applied findings changed notes; the parent refreshes its counts. */
	onChanged(): void;
}) {
	const [view, setView] = useState<SynapseMaintenanceView | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	/** The batch moved on under the reviewer and was reloaded. */
	const [stale, setStale] = useState(false);
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	const [busy, setBusy] = useState<"run" | "apply" | "dismiss" | null>(null);
	const selectAll = useRef<HTMLInputElement>(null);
	const sequence = useRef(0);
	/** Shows a batch, and drops from the selection what is no longer open in it. */
	const adopt = useCallback((next: SynapseMaintenanceView) => {
		setView(next);
		const open = new Set(
			next.batch?.findings
				.filter((finding) => finding.state === "open")
				.map((finding) => finding.id),
		);
		setSelected((current) =>
			[...current].every((id) => open.has(id))
				? current
				: new Set([...current].filter((id) => open.has(id))),
		);
	}, []);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchSynapseMaintenance(space);
			if (request === sequence.current) {
				adopt(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(failureMessage(cause, "Could not load maintenance."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [space, adopt]);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);

	const batch = view?.batch ?? null;
	const open = batch?.findings.filter((item) => item.state === "open") ?? [];
	const chosen = open.filter((item) => selected.has(item.id));
	const allSelected = open.length > 0 && chosen.length === open.length;
	const manual = chosen.filter((item) => !item.fix).length;
	// Some but not all picked: the select-all box shows a dash, as for proposals.
	useEffect(() => {
		if (selectAll.current)
			selectAll.current.indeterminate = chosen.length > 0 && !allSelected;
	});
	/** A response to an action replaces whatever a slower reload would bring. */
	const settle = (next: SynapseMaintenanceBatch | null) => {
		sequence.current++;
		setLoading(false);
		if (view && next) adopt({ ...view, batch: next });
	};
	const run = async () => {
		if (busy) return;
		setBusy("run");
		setError("");
		setNotice("");
		setStale(false);
		try {
			const result = await runSynapseMaintenance(space);
			if (result.batch) {
				settle(result.batch);
				setNotice(
					`Maintenance ran: ${plural(result.batch.findings.length)} to review.`,
				);
			} else await refresh();
		} catch (cause) {
			setError(failureMessage(cause, "Could not run maintenance."));
		} finally {
			setBusy(null);
		}
	};
	const decide = async (decision: "apply" | "dismiss") => {
		if (busy || !batch || !chosen.length) return;
		const ids = chosen.map((item) => item.id);
		setBusy(decision);
		setError("");
		setNotice("");
		setStale(false);
		try {
			const reviewed = await decideSynapseFindings(space, {
				ids,
				decision,
				revision: batch.revision,
			});
			settle(reviewed);
			const decided = reviewed.findings.filter(
				(item) => ids.includes(item.id) && item.state !== "open",
			).length;
			const failed = ids.length - decided;
			setNotice(
				`${decision === "apply" ? "Applied" : "Dismissed"} ${plural(decided)}.${
					failed
						? ` ${failed} could not be applied and ${failed === 1 ? "stays" : "stay"} open: each says why.`
						: ""
				}`,
			);
			if (decision === "apply" && decided) onChanged();
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 409) {
				// Someone else decided, or a new run replaced the batch.
				setStale(true);
				await refresh();
			} else setError(failureMessage(cause, "Could not decide the findings."));
		} finally {
			setBusy(null);
		}
	};
	const options: InlineOptions = {
		hrefFor: (title) => noteHash(space, title),
		onNavigate,
	};
	const every = view
		? `Synapse checks this space every ${view.intervalHours} ${view.intervalHours === 1 ? "hour" : "hours"}`
		: "Synapse checks this space on a schedule";
	return (
		<div className="synapse-maintenance">
			<div className="section-heading">
				<p className="page-description">
					{every} for decisions that contradict each other, notes that look like
					one thing under two titles, decisions nobody has reviewed in a long
					time, commitments past their due date, and claims that cite nothing.
					Nothing is merged or marked until a person applies it here.
				</p>
				<div className="token-actions">
					<button
						className="button"
						type="button"
						disabled={loading || busy !== null}
						onClick={() => void refresh()}
					>
						{loading ? "Loading…" : "Refresh"}
					</button>
					{canEdit && (
						<button
							className="button primary"
							type="button"
							disabled={busy !== null || !view}
							onClick={() => void run()}
						>
							{busy === "run" ? "Running…" : "Run now"}
						</button>
					)}
				</div>
			</div>
			{!canEdit && (
				<p className="card-note">
					Only owners and admins change the global Synapse. You can read its
					latest maintenance run here.
				</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{stale && (
				<p className="banner-warning" role="alert">
					This batch changed while you were reviewing it, so nothing was
					decided. It has been reloaded: check the findings and decide again.
				</p>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{batch ? (
				<>
					<section className="card" aria-labelledby="synapse-digest-heading">
						<h2 id="synapse-digest-heading">Latest run</h2>
						<p className="card-note">
							Made{" "}
							<time dateTime={batch.createdAt}>
								{shortDateTime(batch.createdAt)}
							</time>
							{batch.digest.since
								? `, covering what happened since ${shortDateTime(batch.digest.since)}`
								: ", the first run for this space"}
							. Runs every {view?.intervalHours}{" "}
							{view?.intervalHours === 1 ? "hour" : "hours"}.
						</p>
						<div className="synapse-digest">
							<section aria-labelledby="synapse-digest-changed">
								<h3 id="synapse-digest-changed">What changed</h3>
								{batch.digest.changed.length ? (
									<ul>
										{batch.digest.changed.map((line, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: a digest's lines never reorder
											<li key={index}>{renderInline(line, options)}</li>
										))}
									</ul>
								) : (
									<p className="card-note">
										Nothing changed since the run before.
									</p>
								)}
							</section>
							<section aria-labelledby="synapse-digest-needs">
								<h3 id="synapse-digest-needs">What needs you</h3>
								{batch.digest.needsYou.length ? (
									<ul>
										{batch.digest.needsYou.map((line, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: a digest's lines never reorder
											<li key={index}>{renderInline(line, options)}</li>
										))}
									</ul>
								) : (
									<p className="card-note">Nothing needs you.</p>
								)}
							</section>
						</div>
					</section>
					{canEdit && open.length > 0 && (
						<fieldset
							className="card synapse-bulk-bar synapse-finding-bar"
							disabled={busy !== null}
						>
							<legend className="visually-hidden">
								Review several findings
							</legend>
							<label className="failover-enable">
								<input
									ref={selectAll}
									type="checkbox"
									checked={allSelected}
									onChange={() =>
										setSelected(
											allSelected
												? new Set()
												: new Set(open.map(({ id }) => id)),
										)
									}
								/>
								Select all
							</label>
							<span className="synapse-bulk-count" aria-live="polite">
								{`${chosen.length} of ${plural(open.length)} selected`}
								{manual > 0 &&
									` · ${manual} ${manual === 1 ? "needs" : "need"} an edit by hand, so the selection can only be dismissed`}
							</span>
							<button
								className="button"
								type="button"
								disabled={chosen.length === 0}
								onClick={() => void decide("dismiss")}
							>
								{busy === "dismiss" ? "Dismissing…" : "Dismiss selected"}
							</button>
							<button
								className="button primary"
								type="button"
								disabled={chosen.length === 0 || manual > 0}
								onClick={() => void decide("apply")}
							>
								{busy === "apply" ? "Applying…" : "Apply selected"}
							</button>
						</fieldset>
					)}
					{batch.findings.length ? (
						KINDS.map(({ kind, label, one }) => {
							const findings = batch.findings.filter(
								(item) => item.kind === kind,
							);
							if (!findings.length) return null;
							return (
								<section
									className="card synapse-findings"
									key={kind}
									aria-labelledby={`synapse-findings-${kind}`}
								>
									<h2 id={`synapse-findings-${kind}`}>
										{label} ({findings.length})
									</h2>
									<ul className="synapse-finding-list">
										{findings.map((finding) => (
											<Finding
												key={finding.id}
												finding={finding}
												label={one}
												options={options}
												selectable={canEdit && finding.state === "open"}
												selected={selected.has(finding.id)}
												disabled={busy !== null}
												onSelect={(picked) =>
													setSelected((current) => {
														const next = new Set(current);
														if (picked) next.add(finding.id);
														else next.delete(finding.id);
														return next;
													})
												}
											/>
										))}
									</ul>
								</section>
							);
						})
					) : (
						<div className="card">
							<div className="empty-state">
								This run found nothing to review.
							</div>
						</div>
					)}
				</>
			) : loading && !view ? (
				<LoadingBanner>Loading maintenance…</LoadingBanner>
			) : view ? (
				<div className="card">
					<div className="empty-state">
						No maintenance run for this space yet. The first one comes with the
						next scheduled check
						{canEdit ? ", or run it now." : "."}
					</div>
				</div>
			) : null}
		</div>
	);
}
