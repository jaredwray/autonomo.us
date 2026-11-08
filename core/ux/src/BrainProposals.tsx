import type {
	BrainProperties,
	BrainProposal,
	BrainProposalAction,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	decideBrainProposal,
	fetchBrainNote,
	fetchBrainProposals,
} from "./api.js";
import { shortDate } from "./BrainNote.js";
import { noteHash } from "./brain-route.js";

const ACTION_LABEL: Record<BrainProposalAction, string> = {
	create: "Create",
	update: "Update",
	append: "Append to",
	delete: "Delete",
};

function propertyLines(properties: BrainProperties | undefined): string {
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
function proposedText(proposal: BrainProposal): string {
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
	onDecided,
}: {
	proposal: BrainProposal;
	canDecide: boolean;
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
		fetchBrainNote("shared", proposal.title)
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
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await decideBrainProposal(proposal.id, {
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
	return (
		<article className="card brain-proposal" aria-labelledby={headingId}>
			<div className="section-heading">
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
				<span className="brain-chip">{proposal.status}</span>
			</div>
			<p className="brain-proposal-reason">
				<strong>Reason:</strong> {proposal.reason}
			</p>
			<div className="brain-diff">
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
						className="brain-inline-form"
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
								disabled={busy}
								onClick={() => setRejecting(false)}
							>
								Cancel
							</button>
							<button
								className="button danger"
								type="submit"
								disabled={busy || !reason.trim()}
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
							disabled={busy}
							aria-label={`Reject ${proposal.title}`}
							onClick={() => setRejecting(true)}
						>
							Reject
						</button>
						<button
							className="button primary"
							type="button"
							disabled={busy}
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

export function BrainProposals({
	canDecide,
	version,
	onDecided,
}: {
	canDecide: boolean;
	version: number;
	/** A decision changed the shared vault. */
	onDecided(): void;
}) {
	const [proposals, setProposals] = useState<BrainProposal[] | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchBrainProposals("pending");
			if (request === sequence.current) {
				setProposals(result.proposals);
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
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after a decision changed the shared vault
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh, version]);
	return (
		<div className="brain-proposals">
			<div className="section-heading">
				<p className="page-description">
					Agents never write the shared vault directly: they propose, and an
					owner or admin decides. Approving applies the change; rejecting sends
					the reason back to the agent's daily note.
				</p>
				<button
					className="button"
					type="button"
					disabled={loading}
					onClick={() => void refresh()}
				>
					{loading ? "Loading…" : "Refresh"}
				</button>
			</div>
			{!canDecide && (
				<p className="card-note">
					Owners and admins decide proposals. You can read them here.
				</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{proposals?.length ? (
				proposals.map((proposal) => (
					<ProposalCard
						key={proposal.id}
						proposal={proposal}
						canDecide={canDecide}
						onDecided={(message) => {
							setNotice(message);
							onDecided();
							void refresh();
						}}
					/>
				))
			) : (
				<div className="card empty-state">
					{loading && !proposals
						? "Loading proposals…"
						: "No pending proposals. Agents file them with the brain_propose tool when they want to change the shared vault."}
				</div>
			)}
		</div>
	);
}
