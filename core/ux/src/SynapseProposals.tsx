import type {
	SynapseProperties,
	SynapseProposal,
	SynapseProposalAction,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	currentWorkspaceId,
	decideSynapseProposal,
	fetchSynapseNote,
	fetchSynapseProposals,
} from "./api.js";
import { shortDate } from "./SynapseNote.js";
import { noteHash } from "./synapse-route.js";

const ACTION_LABEL: Record<SynapseProposalAction, string> = {
	create: "Create",
	update: "Update",
	append: "Append to",
	delete: "Delete",
};

function propertyLines(properties: SynapseProperties | undefined): string {
	if (!properties) return "";
	const lines = Object.entries(properties).map(([key, value]) =>
		Array.isArray(value)
			? value.length
				? `${key}:\n${value.map((item) => `  - ${item}`).join("\n")}`
				: `${key}: []`
			: `${key}: ${value === null ? "" : String(value)}`,
	);
	return lines.length ? `---\n${lines.join("\n")}\n---\n` : "";
}

/** The proposal as the text it would leave behind, for a side-by-side read. */
function proposedText(proposal: SynapseProposal): string {
	switch (proposal.action) {
		case "create":
			return `${propertyLines(proposal.properties)}${proposal.body ?? ""}`;
		case "update": {
			const parts: string[] = [];
			if (proposal.newTitle) parts.push(`Rename to “${proposal.newTitle}”`);
			if (proposal.properties)
				parts.push(`Merge properties:\n${propertyLines(proposal.properties)}`);
			if (proposal.body !== undefined)
				parts.push(`Replace body with:\n${proposal.body}`);
			return parts.join("\n\n");
		}
		case "append":
			return proposal.text ?? "";
		default:
			return "(The note is deleted. Links to it become unresolved.)";
	}
}

function ProposalCard({
	proposal,
	canDecide,
	selected,
	locked,
	onSelect,
	onDecided,
}: {
	proposal: SynapseProposal;
	canDecide: boolean;
	/** Picked for a bulk approval. */
	selected: boolean;
	/** A bulk approval is running: hold off on single decisions. */
	locked: boolean;
	onSelect(selected: boolean): void;
	onDecided(message: string): void;
}) {
	// A create proposal has no current note; the others fetch it.
	const [current, setCurrent] = useState<string | null>(
		proposal.action === "create" ? "" : null,
	);
	const [currentError, setCurrentError] = useState("");
	const [rejecting, setRejecting] = useState(false);
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	useEffect(() => {
		if (proposal.action === "create") return;
		let cancelled = false;
		fetchSynapseNote("shared", proposal.title)
			.then((view) => {
				if (!cancelled) setCurrent(view.markdown);
			})
			.catch((cause) => {
				if (cancelled) return;
				setCurrent("");
				setCurrentError(
					cause instanceof ApiError && cause.status === 404
						? "The note no longer exists."
						: cause instanceof Error
							? cause.message
							: "Could not load the current note.",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [proposal.action, proposal.title]);
	const decide = async (decision: "approve" | "reject") => {
		if (busy || locked) return;
		setBusy(true);
		setError("");
		try {
			await decideSynapseProposal(proposal.id, {
				decision,
				reason: decision === "reject" ? reason.trim() : undefined,
			});
			onDecided(
				decision === "approve"
					? `Approved: ${ACTION_LABEL[proposal.action].toLowerCase()} “${proposal.title}”.`
					: `Rejected: ${ACTION_LABEL[proposal.action].toLowerCase()} “${proposal.title}”. The reason was written to the agent's daily note.`,
			);
		} catch (cause) {
			setError(
				cause instanceof Error
					? cause.message
					: "Could not decide the proposal.",
			);
		} finally {
			setBusy(false);
		}
	};
	const headingId = `proposal-${proposal.id}`;
	const disabled = busy || locked;
	return (
		<article className="card synapse-proposal" aria-labelledby={headingId}>
			<div className="section-heading">
				<div className="synapse-proposal-title">
					{canDecide && (
						<input
							type="checkbox"
							className="synapse-proposal-select"
							aria-label={`Select ${ACTION_LABEL[proposal.action].toLowerCase()} “${proposal.title}”`}
							checked={selected}
							disabled={disabled}
							onChange={(event) => onSelect(event.target.checked)}
						/>
					)}
					<div>
						<h2 id={headingId}>
							{ACTION_LABEL[proposal.action]}{" "}
							<a className="wikilink" href={noteHash("shared", proposal.title)}>
								{proposal.title}
							</a>
							{proposal.newTitle && <> → {proposal.newTitle}</>}
						</h2>
						<p className="card-note">
							Proposed by {proposal.author.name} on{" "}
							{shortDate(proposal.createdAt)}
							{proposal.baseRevision !== null &&
								` · against revision ${proposal.baseRevision}`}
						</p>
					</div>
				</div>
				<span className="synapse-chip">{proposal.status}</span>
			</div>
			<p className="synapse-proposal-reason">
				<strong>Reason:</strong> {proposal.reason}
			</p>
			<div className="synapse-diff">
				<div>
					<h3>Current shared note</h3>
					{current === null ? (
						<p className="card-note">Loading…</p>
					) : (
						<pre>
							{current ||
								(proposal.action === "create"
									? "(No note yet.)"
									: currentError || "(Empty note.)")}
						</pre>
					)}
				</div>
				<div>
					<h3>
						{proposal.action === "append"
							? "Text to append"
							: proposal.action === "delete"
								? "Result"
								: "Proposed"}
					</h3>
					<pre>{proposedText(proposal) || "(No content.)"}</pre>
				</div>
			</div>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{canDecide ? (
				rejecting ? (
					<form
						className="synapse-inline-form"
						onSubmit={(event) => {
							event.preventDefault();
							void decide("reject");
						}}
					>
						<div className="form-field">
							<label htmlFor={`${headingId}-reason`}>Rejection reason</label>
							<textarea
								id={`${headingId}-reason`}
								required
								maxLength={2000}
								rows={2}
								value={reason}
								disabled={busy}
								placeholder="What should the agent do differently?"
								onChange={(event) => setReason(event.target.value)}
							/>
							<span className="field-hint">
								Appended to the agent's daily note so it learns from the
								decision.
							</span>
						</div>
						<div className="form-actions">
							<button
								className="button"
								type="button"
								disabled={disabled}
								onClick={() => setRejecting(false)}
							>
								Cancel
							</button>
							<button
								className="button danger"
								type="submit"
								disabled={disabled || !reason.trim()}
							>
								{busy ? "Rejecting…" : "Confirm rejection"}
							</button>
						</div>
					</form>
				) : (
					<div className="form-actions">
						<button
							className="button danger"
							type="button"
							disabled={disabled}
							aria-label={`Reject ${proposal.title}`}
							onClick={() => setRejecting(true)}
						>
							Reject
						</button>
						<button
							className="button primary"
							type="button"
							disabled={disabled}
							aria-label={`Approve ${proposal.title}`}
							onClick={() => void decide("approve")}
						>
							{busy ? "Applying…" : "Approve"}
						</button>
					</div>
				)
			) : null}
		</article>
	);
}

const plural = (count: number) => `${count} proposal${count === 1 ? "" : "s"}`;
const failureMessage = (cause: unknown) =>
	cause instanceof Error ? cause.message : "Could not decide the proposal.";
/** A proposal a bulk approval could not apply, and why. */
type BulkFailure = { id: string; message: string };

export function SynapseProposals({
	canDecide,
	version,
	onDecided,
}: {
	canDecide: boolean;
	version: number;
	/** A decision changed the shared space. */
	onDecided(): void;
}) {
	const [proposals, setProposals] = useState<SynapseProposal[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [selected, setSelected] = useState<ReadonlySet<string>>(
		() => new Set(),
	);
	/** How far a bulk approval has got, while it runs. */
	const [progress, setProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);
	const [failures, setFailures] = useState<BulkFailure[]>([]);
	const selectAll = useRef<HTMLInputElement>(null);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchSynapseProposals("pending");
			if (request === sequence.current) {
				setProposals(result.proposals);
				// Decided proposals leave the list, and the selection with them.
				const pending = new Set(result.proposals.map(({ id }) => id));
				setSelected((current) =>
					[...current].every((id) => pending.has(id))
						? current
						: new Set([...current].filter((id) => pending.has(id))),
				);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(
					cause instanceof Error ? cause.message : "Could not load proposals.",
				);
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after a decision changed the shared space
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh, version]);
	const total = proposals?.length ?? 0;
	const selectedCount = proposals
		? proposals.filter(({ id }) => selected.has(id)).length
		: 0;
	const allSelected = total > 0 && selectedCount === total;
	const bulkBusy = progress !== null;
	// Some but not all picked: the select-all box shows a dash. HTML has no
	// attribute for that, so it is set on the element after every render.
	useEffect(() => {
		if (selectAll.current)
			selectAll.current.indeterminate = selectedCount > 0 && !allSelected;
	});
	const select = (id: string, picked: boolean) =>
		setSelected((current) => {
			const next = new Set(current);
			if (picked) next.add(id);
			else next.delete(id);
			return next;
		});
	const approveSelected = async () => {
		if (bulkBusy || !proposals) return;
		// Oldest first, so changes land in the order the agents filed them.
		const chosen = proposals.filter(({ id }) => selected.has(id)).reverse();
		if (!chosen.length) return;
		setNotice("");
		setFailures([]);
		setProgress({ done: 0, total: chosen.length });
		// Switching workspaces mid-batch remounts this view, but the loop runs
		// on: keep every approval in the workspace the admin approved them in.
		const workspace = currentWorkspaceId();
		const approved: string[] = [];
		const failed: BulkFailure[] = [];
		// One at a time: two proposals can touch the same note, and each
		// approval must see the note as the one before it left it.
		for (const proposal of chosen) {
			try {
				await decideSynapseProposal(
					proposal.id,
					{ decision: "approve" },
					workspace,
				);
				approved.push(proposal.id);
			} catch (cause) {
				const label = `${ACTION_LABEL[proposal.action]} “${proposal.title}”`;
				failed.push({
					id: proposal.id,
					message: `${label}: ${failureMessage(cause)}`,
				});
			}
			setProgress({
				done: approved.length + failed.length,
				total: chosen.length,
			});
		}
		setSelected((current) => {
			const next = new Set(current);
			for (const id of approved) next.delete(id);
			return next;
		});
		setProgress(null);
		setFailures(failed);
		if (approved.length) {
			setNotice(`Approved ${plural(approved.length)}.`);
			onDecided();
		}
		void refresh();
	};
	return (
		<div className="synapse-proposals">
			<div className="section-heading">
				<p className="page-description">
					Agents never write the shared space directly: they propose, and an
					owner or admin decides. Approving applies the change; rejecting sends
					the reason back to the agent's daily note.
				</p>
				<button
					className="button"
					type="button"
					disabled={loading || bulkBusy}
					onClick={() => void refresh()}
				>
					{loading ? "Loading…" : "Refresh"}
				</button>
			</div>
			{!canDecide && (
				<p className="card-note">
					Workspace admins decide proposals. You can read them here.
				</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{failures.length > 0 && (
				<div className="banner-error synapse-bulk-failures" role="alert">
					<strong>
						Could not approve {plural(failures.length)}. They stay selected.
					</strong>
					<ul>
						{failures.map(({ id, message }) => (
							<li key={id}>{message}</li>
						))}
					</ul>
				</div>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{canDecide && total > 0 && (
				<fieldset className="card synapse-bulk-bar" disabled={bulkBusy}>
					<legend className="visually-hidden">Approve several proposals</legend>
					<label className="failover-enable">
						<input
							ref={selectAll}
							type="checkbox"
							checked={allSelected}
							onChange={() =>
								setSelected(
									allSelected
										? new Set()
										: new Set(proposals?.map(({ id }) => id)),
								)
							}
						/>
						Select all
					</label>
					<span className="synapse-bulk-count" aria-live="polite">
						{progress
							? `Approving ${Math.min(progress.done + 1, progress.total)} of ${progress.total}…`
							: `${selectedCount} of ${plural(total)} selected`}
					</span>
					<button
						className="button primary"
						type="button"
						disabled={selectedCount === 0}
						onClick={() => void approveSelected()}
					>
						{bulkBusy
							? "Approving…"
							: selectedCount
								? `Approve selected (${selectedCount})`
								: "Approve selected"}
					</button>
				</fieldset>
			)}
			{proposals?.length ? (
				proposals.map((proposal) => (
					<ProposalCard
						key={proposal.id}
						proposal={proposal}
						canDecide={canDecide}
						selected={selected.has(proposal.id)}
						locked={bulkBusy}
						onSelect={(picked) => select(proposal.id, picked)}
						onDecided={(message) => {
							setNotice(message);
							setFailures([]);
							onDecided();
							void refresh();
						}}
					/>
				))
			) : (
				<div className="card empty-state">
					{loading && !proposals
						? "Loading proposals…"
						: "No pending proposals. Agents file them with the synapse_propose tool when they want to change the shared space."}
				</div>
			)}
		</div>
	);
}
