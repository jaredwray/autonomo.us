import {
	type SynapseStanding as Standing,
	SYNAPSE_DECISION_STATUSES,
	type SynapseDecisionStatus,
	type SynapseNote,
} from "@autonomo.us/common";
import { useState } from "react";
import { approveSynapseAnswer, setSynapseDecisionStatus } from "./api.js";
import { failureMessage, NoteLink } from "./synapse-shared.js";

const STATUS_LABEL: Record<SynapseDecisionStatus, string> = {
	active: "Active",
	disputed: "Disputed",
	superseded: "Superseded",
};
const STATUS_HINT: Record<SynapseDecisionStatus, string> = {
	active: "In force.",
	disputed: "Not settled: someone questions it.",
	superseded: "Replaced by another decision.",
};
const inCategory = (note: SynapseNote, category: string) =>
	note.categories.some((item) => item.toLowerCase() === category);

function Links({
	titles,
	space,
	onNavigate,
}: {
	titles: string[];
	space: string;
	onNavigate(title: string): void;
}) {
	return (
		<>
			{titles.map((title, index) => (
				<span key={title}>
					{index > 0 && ", "}
					<NoteLink space={space} title={title} onNavigate={onNavigate} />
				</span>
			))}
		</>
	);
}

/**
 * "Is it still current?" for a note: a decision's status and what replaced
 * it, a draft marker, and the actions that change them.
 */
export function SynapseStanding({
	space,
	note,
	standing,
	writable,
	onNavigate,
	onChanged,
}: {
	space: string;
	note: SynapseNote;
	standing: Standing;
	/** The viewer may change this note here. */
	writable: boolean;
	onNavigate(title: string): void;
	/** The status changed or the answer was approved; the note reloads. */
	onChanged(): Promise<void>;
}) {
	const [editing, setEditing] = useState(false);
	const [status, setStatus] = useState<SynapseDecisionStatus>("active");
	const [supersededBy, setSupersededBy] = useState("");
	const [reason, setReason] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const decision = inCategory(note, "decisions");
	const answer = inCategory(note, "answers");
	const approvedBy =
		answer && !standing.draft && typeof note.properties.approved_by === "string"
			? note.properties.approved_by
			: "";
	const shown =
		decision ||
		standing.status !== null ||
		standing.draft ||
		standing.supersededBy.length > 0 ||
		standing.supersedes.length > 0 ||
		Boolean(approvedBy);
	if (!shown) return null;
	const act = async (work: () => Promise<unknown>, fallback: string) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await work();
			// The form stays until the note shows its new standing.
			await onChanged();
			setEditing(false);
		} catch (cause) {
			setError(failureMessage(cause, fallback));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="synapse-standing" aria-label="Standing">
			<div className="synapse-standing-line">
				{standing.status ? (
					<span className={`synapse-chip synapse-state-${standing.status}`}>
						{STATUS_LABEL[standing.status]}
					</span>
				) : (
					decision && <span className="synapse-chip">No status yet</span>
				)}
				{standing.draft && (
					<span className="synapse-chip synapse-state-draft">Draft</span>
				)}
				{approvedBy && (
					<span className="synapse-chip synapse-state-approved">
						Approved by {approvedBy}
					</span>
				)}
				{standing.supersededBy.length > 0 && (
					<span>
						Superseded by{" "}
						<Links
							titles={standing.supersededBy}
							space={space}
							onNavigate={onNavigate}
						/>
					</span>
				)}
				{standing.supersedes.length > 0 && (
					<span>
						Supersedes{" "}
						<Links
							titles={standing.supersedes}
							space={space}
							onNavigate={onNavigate}
						/>
					</span>
				)}
				{decision && standing.reviewed && (
					<span className="synapse-result-meta">
						Last reviewed{" "}
						<time dateTime={standing.reviewed}>{standing.reviewed}</time>
					</span>
				)}
				{writable && decision && !editing && (
					<button
						className="button"
						type="button"
						onClick={() => {
							setStatus(standing.status ?? "active");
							setSupersededBy(standing.supersededBy[0] ?? "");
							setReason("");
							setError("");
							setEditing(true);
						}}
					>
						Change status
					</button>
				)}
				{writable && answer && standing.draft && (
					<button
						className="button primary"
						type="button"
						disabled={busy}
						onClick={() =>
							void act(
								() => approveSynapseAnswer(space, note.title),
								"Could not approve the answer.",
							)
						}
					>
						{busy ? "Approving…" : "Approve"}
					</button>
				)}
			</div>
			{standing.draft && answer && (
				<p className="card-note">
					A draft answer is saved, not yet knowledge. Approving it records who
					approved it and when.
				</p>
			)}
			{editing && (
				<form
					className="synapse-inline-form"
					onSubmit={(event) => {
						event.preventDefault();
						void act(
							() =>
								setSynapseDecisionStatus(space, note.title, {
									status,
									...(status === "superseded"
										? { supersededBy: supersededBy.trim() }
										: {}),
									...(reason.trim() ? { reason: reason.trim() } : {}),
								}),
							"Could not change the status.",
						);
					}}
				>
					<fieldset className="routing-fields" disabled={busy}>
						<fieldset className="token-permission-fields synapse-status-choices">
							<legend>Decision status</legend>
							{SYNAPSE_DECISION_STATUSES.map((item) => (
								<label className="token-permission-choice" key={item}>
									<input
										type="radio"
										name="synapse-decision-status"
										value={item}
										checked={status === item}
										onChange={() => setStatus(item)}
									/>
									<span>
										<strong>{STATUS_LABEL[item]}</strong> {STATUS_HINT[item]}
									</span>
								</label>
							))}
						</fieldset>
						{status === "superseded" && (
							<div className="form-field">
								<label htmlFor="synapse-superseded-by">Replaced by</label>
								<input
									id="synapse-superseded-by"
									required
									maxLength={200}
									value={supersededBy}
									placeholder="Title of the decision that replaces it"
									onChange={(event) => setSupersededBy(event.target.value)}
								/>
								<span className="field-hint">
									A note in the Decisions category of this space. It records in
									turn what it replaced.
								</span>
							</div>
						)}
						<div className="form-field">
							<label htmlFor="synapse-status-reason">Reason (optional)</label>
							<textarea
								id="synapse-status-reason"
								rows={2}
								maxLength={2000}
								value={reason}
								onChange={(event) => setReason(event.target.value)}
							/>
							<span className="field-hint">
								Written into the decision's Status section with your name and
								today's date.
							</span>
						</div>
						<div className="form-actions">
							<button
								className="button"
								type="button"
								onClick={() => setEditing(false)}
							>
								Cancel
							</button>
							<button
								className="button primary"
								type="submit"
								disabled={status === "superseded" && !supersededBy.trim()}
							>
								{busy ? "Saving…" : "Save status"}
							</button>
						</div>
					</fieldset>
				</form>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
		</section>
	);
}
