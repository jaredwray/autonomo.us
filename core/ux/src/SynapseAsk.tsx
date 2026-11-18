import type {
	SynapsePassage,
	SynapsePassageStanding,
	SynapseRetrieval,
} from "@autonomo.us/common";
import { useEffect, useRef, useState } from "react";
import { retrieveSynapse, saveSynapseAnswer } from "./api.js";
import { failureMessage, NoteLink } from "./synapse-shared.js";

const PASSAGE_STANDING: Record<SynapsePassageStanding, string> = {
	approved: "Approved",
	unreviewed: "Unreviewed",
	draft: "Draft",
	disputed: "Disputed",
	superseded: "Superseded",
	source: "Source",
};
const STANDING_HINT: Record<SynapsePassageStanding, string> = {
	approved: "Team canon: a shared or global note",
	unreviewed: "An agent's own note, which nobody reviewed",
	draft: "Saved as a draft, not yet approved",
	disputed: "A decision marked disputed",
	superseded: "A decision that another one replaced",
	source: "Captured or clipped material, kept as found: somebody else's words",
};
const excerpt = (text: string) => {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 120 ? `${line.slice(0, 117)}…` : line;
};

/** Saves an answer that cites the passages the reader checks. */
function AnswerForm({
	space,
	question,
	passages,
	onSaved,
}: {
	space: string;
	question: string;
	/** Passages whose own words matched: only those can be quoted. */
	passages: SynapsePassage[];
	onSaved(title: string): void;
}) {
	const [answer, setAnswer] = useState("");
	const [title, setTitle] = useState("");
	const [picked, setPicked] = useState<ReadonlySet<number>>(() => new Set());
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			const note = await saveSynapseAnswer(space, {
				question,
				answer: answer.trim(),
				evidence: passages
					.filter((_, index) => picked.has(index))
					.map((passage) => ({ source: passage.title, passage: passage.text })),
				...(title.trim() ? { title: title.trim() } : {}),
			});
			onSaved(note.title);
		} catch (cause) {
			setError(failureMessage(cause, "Could not save the answer."));
			setBusy(false);
		}
	};
	return (
		<section
			className="card token-form"
			aria-labelledby="synapse-answer-heading"
		>
			<h2 id="synapse-answer-heading">Save as answer</h2>
			<p className="card-note">
				Saves your answer as a draft note in the Answers category, with the
				passages you check quoted as its evidence. A person approves it on the
				note's page.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="form-field">
						<label htmlFor="synapse-answer-text">Answer</label>
						<textarea
							id="synapse-answer-text"
							rows={4}
							required
							value={answer}
							onChange={(event) => setAnswer(event.target.value)}
						/>
					</div>
					<fieldset className="token-permission-fields synapse-answer-evidence">
						<legend>Evidence</legend>
						{passages.length ? (
							<ul className="synapse-check-list">
								{passages.map((passage, index) => (
									// biome-ignore lint/suspicious/noArrayIndexKey: one retrieval's passages never reorder
									<li key={index}>
										<label className="token-permission-choice">
											<input
												type="checkbox"
												checked={picked.has(index)}
												onChange={(event) =>
													setPicked((current) => {
														const next = new Set(current);
														if (event.target.checked) next.add(index);
														else next.delete(index);
														return next;
													})
												}
											/>
											<span>
												<strong>{passage.title}</strong>: “
												{excerpt(passage.text)}”
											</span>
										</label>
									</li>
								))}
							</ul>
						) : (
							<p className="card-note">
								No passage matched by its own words, so there is nothing to
								quote. Ask another way, or write the note first.
							</p>
						)}
						<span className="field-hint">
							An answer needs at least one passage. Each is checked against its
							note as it stands when you save.
						</span>
					</fieldset>
					<div className="form-field">
						<label htmlFor="synapse-answer-title">Title (optional)</label>
						<input
							id="synapse-answer-title"
							maxLength={200}
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
						<span className="field-hint">Defaults to the question.</span>
					</div>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					<div className="form-actions">
						<button
							className="button primary"
							type="submit"
							disabled={!answer.trim() || picked.size === 0}
						>
							{busy ? "Saving…" : "Save as answer"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/** Asks a space a question and shows the passages that bear on it. */
export function SynapseAsk({
	space,
	canEdit,
	onNavigate,
	onChanged,
}: {
	space: string;
	/** False where the viewer may only read, such as Global for members. */
	canEdit: boolean;
	onNavigate(title: string): void;
	/** An answer was saved; the parent refreshes its counts. */
	onChanged(): void;
}) {
	const [question, setQuestion] = useState("");
	const [found, setFound] = useState<SynapseRetrieval | null>(null);
	/** Which retrieval `found` is, so each one starts its own answer. */
	const [retrieval, setRetrieval] = useState(0);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState("");
	/** Counts the questions asked, so a slow answer never replaces a newer one. */
	const sequence = useRef(0);
	useEffect(
		() => () => {
			sequence.current++;
		},
		[],
	);
	const ask = async () => {
		const asked = question.trim();
		if (!asked) return;
		const request = ++sequence.current;
		setLoading(true);
		setError("");
		try {
			const result = await retrieveSynapse(space, { question: asked });
			if (request !== sequence.current) return;
			setFound(result);
			setRetrieval(request);
		} catch (cause) {
			if (request !== sequence.current) return;
			setFound(null);
			setError(failureMessage(cause, "Could not search Synapse."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	};
	const quotable = found?.passages.filter((item) => item.via === "text") ?? [];
	return (
		<div className="synapse-ask">
			<section
				className="card token-form"
				aria-labelledby="synapse-ask-heading"
			>
				<h2 id="synapse-ask-heading">Ask</h2>
				<p className="card-note">
					Finds the passages in this space that bear on a question, with how far
					each can be trusted, and says which of the question's words matched
					nothing.
				</p>
				<form
					className="synapse-ask-form"
					onSubmit={(event) => {
						event.preventDefault();
						void ask();
					}}
				>
					<div className="form-field">
						<label htmlFor="synapse-question">Question</label>
						<input
							id="synapse-question"
							type="search"
							required
							maxLength={1000}
							placeholder="How is pricing decided?"
							value={question}
							onChange={(event) => setQuestion(event.target.value)}
						/>
					</div>
					<button
						className="button primary"
						type="submit"
						disabled={loading || !question.trim()}
					>
						{loading ? "Searching…" : "Ask"}
					</button>
				</form>
				{error && (
					<div className="banner-error" role="alert">
						{error}
					</div>
				)}
			</section>
			{found && (
				<section
					className="card synapse-passages"
					aria-labelledby="synapse-passages-heading"
					aria-busy={loading}
				>
					<h2 id="synapse-passages-heading">Passages for “{found.question}”</h2>
					<p className="card-note" role="status">
						{found.passages.length
							? `${found.passages.length} ${found.passages.length === 1 ? "passage" : "passages"} from ${found.searched} ${found.searched === 1 ? "note" : "notes"} searched.`
							: `No passage matched in the ${found.searched} ${found.searched === 1 ? "note" : "notes"} searched.`}
					</p>
					{found.passages.length > 0 && (
						<ol className="synapse-passage-list">
							{found.passages.map((passage, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: one retrieval's passages never reorder
								<li key={index}>
									<div className="synapse-result-line">
										<NoteLink
											space={space}
											title={passage.title}
											onNavigate={onNavigate}
										/>
										{passage.heading && (
											<span className="synapse-passage-heading">
												› {passage.heading}
											</span>
										)}
										<span
											className={`synapse-chip synapse-state-${passage.standing}`}
											title={STANDING_HINT[passage.standing]}
										>
											{PASSAGE_STANDING[passage.standing]}
										</span>
										{passage.date && (
											<time
												className="synapse-result-meta"
												dateTime={passage.date}
											>
												{passage.date}
											</time>
										)}
									</div>
									<blockquote>{passage.text}</blockquote>
									{passage.via === "link" && passage.from && (
										<p className="synapse-result-meta">
											Linked from{" "}
											<NoteLink
												space={space}
												title={passage.from}
												onNavigate={onNavigate}
											/>
										</p>
									)}
								</li>
							))}
						</ol>
					)}
					{found.missing.length > 0 && (
						<p className="synapse-ask-gap">
							<strong>Nothing matched:</strong> {found.missing.join(", ")}
						</p>
					)}
					{found.unresolved.length > 0 && (
						<p className="synapse-ask-gap">
							<strong>Linked but not written yet:</strong>{" "}
							{found.unresolved.map((title, index) => (
								<span key={title}>
									{index > 0 && ", "}
									<NoteLink
										space={space}
										title={title}
										onNavigate={onNavigate}
										unresolved
									/>
								</span>
							))}
						</p>
					)}
				</section>
			)}
			{found && canEdit && (
				<AnswerForm
					// A new retrieval starts a new answer: its passages are other ones.
					key={retrieval}
					space={space}
					question={found.question}
					passages={quotable}
					onSaved={(title) => {
						onChanged();
						onNavigate(title);
					}}
				/>
			)}
		</div>
	);
}
