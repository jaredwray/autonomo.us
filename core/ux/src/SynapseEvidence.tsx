import type { SynapseEvidence as Evidence } from "@autonomo.us/common";
import { useState } from "react";
import { citeSynapseEvidence } from "./api.js";
import { failureMessage, NoteLink } from "./synapse-shared.js";

const STATE_LABEL: Record<Evidence["state"], string> = {
	verified: "Verified",
	changed: "The source changed",
	missing: "The source is missing",
	unquoted: "Nothing quoted",
};
const STATE_HINT: Record<Evidence["state"], string> = {
	verified: "The source contains this passage as it stands now.",
	changed:
		"The source no longer contains this passage. Its history may show when it changed.",
	missing: "No note with this title exists in the space.",
	unquoted:
		"The line links the source without quoting it, so there is nothing to check.",
};

/** Where a note's claims come from: its Evidence lines, each checked against its source. */
export function SynapseEvidence({
	space,
	title,
	evidence,
	writable,
	onNavigate,
	onChanged,
}: {
	space: string;
	/** The note that cites. */
	title: string;
	evidence: Evidence[];
	/** The viewer may change this note here. */
	writable: boolean;
	onNavigate(title: string): void;
	/** A source was cited; the note reloads. */
	onChanged(): Promise<void>;
}) {
	const [citing, setCiting] = useState(false);
	const [source, setSource] = useState("");
	const [passage, setPassage] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	if (!evidence.length && !writable) return null;
	const cite = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await citeSynapseEvidence(space, title, {
				source: source.trim(),
				passage: passage.trim(),
			});
			// The form stays until the note lists the new line.
			await onChanged();
			setCiting(false);
			setSource("");
			setPassage("");
		} catch (cause) {
			setError(failureMessage(cause, "Could not cite the source."));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section className="synapse-evidence" aria-labelledby="synapse-evidence">
			<div className="section-heading">
				<h3 id="synapse-evidence">Evidence ({evidence.length})</h3>
				{writable && !citing && (
					<button
						className="button"
						type="button"
						onClick={() => {
							setError("");
							setCiting(true);
						}}
					>
						Cite a source
					</button>
				)}
			</div>
			{evidence.length ? (
				<ul className="synapse-result-list">
					{evidence.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: evidence lines may repeat and keep their order
						<li key={index}>
							<div className="synapse-result-line">
								<NoteLink
									space={space}
									title={item.source}
									onNavigate={onNavigate}
									unresolved={item.state === "missing"}
								/>
								<span
									className={`synapse-chip synapse-state-${item.state}`}
									title={STATE_HINT[item.state]}
								>
									{STATE_LABEL[item.state]}
								</span>
								{(item.revision !== null || item.date) && (
									<span className="synapse-result-meta">
										Cited
										{item.revision !== null && ` at revision ${item.revision}`}
										{item.date && ` on ${item.date}`}
									</span>
								)}
							</div>
							{item.passage && <blockquote>{item.passage}</blockquote>}
						</li>
					))}
				</ul>
			) : (
				<p className="card-note">
					This note cites nothing yet. Cite the note its claims come from, with
					the words that support them.
				</p>
			)}
			{citing && (
				<form
					className="synapse-inline-form"
					aria-label="Cite a source"
					onSubmit={(event) => {
						event.preventDefault();
						void cite();
					}}
				>
					<fieldset className="routing-fields" disabled={busy}>
						<div className="form-field">
							<label htmlFor="synapse-cite-source">Source note</label>
							<input
								id="synapse-cite-source"
								required
								maxLength={200}
								value={source}
								placeholder="Title of a note in this space"
								onChange={(event) => setSource(event.target.value)}
							/>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-cite-passage">Passage</label>
							<textarea
								id="synapse-cite-passage"
								required
								rows={3}
								maxLength={1000}
								value={passage}
								onChange={(event) => setPassage(event.target.value)}
							/>
							<span className="field-hint">
								Words copied from the source. They must appear in it exactly.
							</span>
						</div>
						{error && (
							<div className="banner-error" role="alert">
								{error}
							</div>
						)}
						<div className="form-actions">
							<button
								className="button"
								type="button"
								onClick={() => setCiting(false)}
							>
								Cancel
							</button>
							<button
								className="button primary"
								type="submit"
								disabled={!source.trim() || !passage.trim()}
							>
								{busy ? "Citing…" : "Cite source"}
							</button>
						</div>
					</fieldset>
				</form>
			)}
		</section>
	);
}
