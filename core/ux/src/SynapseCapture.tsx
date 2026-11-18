import type {
	SynapseCaptureRequest,
	SynapseCaptureResult,
	SynapseCaptureUpdate,
} from "@autonomo.us/common";
import { useRef, useState } from "react";
import { captureToSynapse } from "./api.js";
import { failureMessage, NoteLink } from "./synapse-shared.js";

const SOURCE_STATUS: Record<SynapseCaptureResult["source"]["status"], string> =
	{
		created: "Created",
		updated: "Updated",
		unchanged: "Unchanged",
	};
const UPDATE_STATE: Record<SynapseCaptureUpdate["state"], string> = {
	prepared: "Prepared",
	applied: "Applied",
	proposed: "Proposed",
	skipped: "Skipped",
};
const count = (value: number, one: string, many = `${one}s`) =>
	`${value} ${value === 1 ? one : many}`;

function CaptureResult({
	result,
	space,
	onNavigate,
}: {
	result: SynapseCaptureResult;
	space: string;
	onNavigate(title: string): void;
}) {
	const { source, entities, updates } = result;
	return (
		<section
			className="card synapse-capture-result"
			aria-labelledby="synapse-capture-result-heading"
		>
			<h2 id="synapse-capture-result-heading">What was saved</h2>
			<p className="success-notice" role="status">
				{result.summary}
			</p>
			<p className="synapse-result-line">
				Source:{" "}
				<NoteLink space={space} title={source.title} onNavigate={onNavigate} />{" "}
				<span className={`synapse-chip synapse-state-${source.status}`}>
					{SOURCE_STATUS[source.status]}
				</span>{" "}
				<span className="synapse-result-meta">
					revision {source.revision}
					{source.captured && ` · first captured ${source.captured}`}
					{source.url && (
						<>
							{" · "}
							<a href={source.url} rel="noreferrer" target="_blank">
								{source.url}
							</a>
						</>
					)}
				</span>
			</p>
			{source.truncated && (
				<p className="card-note">
					The content was longer than a note holds, so the note keeps the start
					of it. Save a long document in sections.
				</p>
			)}
			{source.diff && (
				<section aria-labelledby="synapse-capture-diff">
					<h3 id="synapse-capture-diff">
						What changed since the last version (
						{count(source.diff.added, "line")} added, {source.diff.removed}{" "}
						removed)
					</h3>
					{source.diff.sample.length > 0 && (
						<pre className="synapse-capture-diff">
							{source.diff.sample.join("\n")}
						</pre>
					)}
				</section>
			)}
			<section aria-labelledby="synapse-capture-entities">
				<h3 id="synapse-capture-entities">
					Notes it mentions ({entities.length})
				</h3>
				{entities.length ? (
					<ul className="synapse-result-list">
						{entities.map((entity) => (
							<li key={`${entity.space}/${entity.title}`}>
								<div className="synapse-result-line">
									<NoteLink
										space={space}
										title={entity.title}
										onNavigate={onNavigate}
									/>
									{entity.categories.map((category) => (
										<span className="synapse-chip" key={category}>
											{category}
										</span>
									))}
									<span className="synapse-result-meta">
										{count(entity.mentions, "mention")}
									</span>
								</div>
								{entity.passage && <blockquote>{entity.passage}</blockquote>}
							</li>
						))}
					</ul>
				) : (
					<p className="card-note">
						The text names no existing note by its title or an alias.
					</p>
				)}
			</section>
			<section aria-labelledby="synapse-capture-updates">
				<h3 id="synapse-capture-updates">
					Updates to those notes ({updates.length})
				</h3>
				{updates.length ? (
					<ul className="synapse-result-list">
						{updates.map((update) => (
							<li key={`${update.space}/${update.title}`}>
								<div className="synapse-result-line">
									<NoteLink
										space={space}
										title={update.title}
										onNavigate={onNavigate}
									/>
									<span
										className={`synapse-chip synapse-state-${update.state}`}
									>
										{UPDATE_STATE[update.state]}
									</span>
								</div>
								<pre className="synapse-capture-line">{update.text}</pre>
								{update.detail && <p className="card-note">{update.detail}</p>}
							</li>
						))}
					</ul>
				) : (
					<p className="card-note">No note needs a line about this source.</p>
				)}
				{updates.some((update) => update.state === "prepared") && (
					<p className="card-note">
						Prepared lines are not written. Save again with “Also update the
						notes it mentions” checked to append them.
					</p>
				)}
			</section>
		</section>
	);
}

/** "Save to Synapse": keeps a page, pasted text, or a text document as a source note. */
export function SynapseCapture({
	space,
	canEdit,
	onNavigate,
	onChanged,
}: {
	space: string;
	/** False where the viewer may only read, such as Global for members. */
	canEdit: boolean;
	onNavigate(title: string): void;
	/** A capture wrote notes; the parent refreshes its counts. */
	onChanged(): void;
}) {
	const [url, setUrl] = useState("");
	const [text, setText] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [title, setTitle] = useState("");
	const [apply, setApply] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<SynapseCaptureResult | null>(null);
	const picker = useRef<HTMLInputElement>(null);
	if (!canEdit)
		return (
			<p className="card-note">
				Only owners and admins change the global Synapse, so nothing can be
				saved to it from here. Pick another space to save a source.
			</p>
		);
	const hasText = Boolean(text.trim());
	const both = hasText && file !== null;
	const submit = async () => {
		if (busy) return;
		if (both) {
			setError(
				"Send pasted text or a document, not both. Clear the text or remove the document.",
			);
			return;
		}
		setBusy(true);
		setError("");
		try {
			const request: SynapseCaptureRequest = {
				...(url.trim() ? { url: url.trim() } : {}),
				...(hasText ? { text } : {}),
				...(file
					? { document: { name: file.name, content: await file.text() } }
					: {}),
				...(title.trim() ? { title: title.trim() } : {}),
				apply,
			};
			const saved = await captureToSynapse(space, request);
			setResult(saved);
			if (
				saved.source.status !== "unchanged" ||
				saved.updates.some((update) => update.state === "applied")
			)
				onChanged();
		} catch (cause) {
			setResult(null);
			setError(failureMessage(cause, "Could not save to Synapse."));
		} finally {
			setBusy(false);
		}
	};
	return (
		<div className="synapse-capture">
			<section
				className="card token-form"
				aria-labelledby="synapse-capture-heading"
			>
				<h2 id="synapse-capture-heading">Save to Synapse</h2>
				<p className="card-note">
					Keeps a page, pasted text, or a text document as a source note, names
					the notes it mentions, and prepares a line for each. Saving the same
					content again writes nothing; changed content becomes a new revision
					of the same source.
				</p>
				<form
					onSubmit={(event) => {
						event.preventDefault();
						void submit();
					}}
				>
					<fieldset className="routing-fields" disabled={busy}>
						<div className="form-field">
							<label htmlFor="synapse-capture-url">Page address (URL)</label>
							<input
								id="synapse-capture-url"
								type="url"
								maxLength={2000}
								placeholder="https://example.com/pricing"
								value={url}
								onChange={(event) => setUrl(event.target.value)}
							/>
							<span className="field-hint">
								With text or a document, the address is recorded as where it
								came from. On its own, Synapse fetches the page, which only
								workspace admins may ask for.
							</span>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-capture-text">Text</label>
							<textarea
								id="synapse-capture-text"
								rows={8}
								value={text}
								placeholder="Paste the text to keep, as it is."
								onChange={(event) => setText(event.target.value)}
							/>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-capture-document">Text document</label>
							<input
								id="synapse-capture-document"
								ref={picker}
								type="file"
								accept=".txt,.md,.markdown,text/plain,text/markdown"
								onChange={(event) => setFile(event.target.files?.[0] ?? null)}
							/>
							<span className="field-hint">
								A .txt, .md, or .markdown file, instead of pasted text.
								{file && (
									<>
										{" "}
										Selected: {file.name}.{" "}
										<button
											type="button"
											className="synapse-text-button"
											onClick={() => {
												setFile(null);
												if (picker.current) picker.current.value = "";
											}}
										>
											Remove document
										</button>
									</>
								)}
							</span>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-capture-title">Title (optional)</label>
							<input
								id="synapse-capture-title"
								maxLength={200}
								value={title}
								onChange={(event) => setTitle(event.target.value)}
							/>
							<span className="field-hint">
								Defaults to the document's name, the page's heading, or its
								address.
							</span>
						</div>
						<label className="failover-enable synapse-capture-apply">
							<input
								type="checkbox"
								checked={apply}
								onChange={(event) => setApply(event.target.checked)}
							/>
							Also update the notes it mentions
						</label>
						{error && (
							<div className="banner-error" role="alert">
								{error}
							</div>
						)}
						<div className="form-actions">
							<button
								className="button primary"
								type="submit"
								disabled={!url.trim() && !hasText && !file}
							>
								{busy ? "Saving…" : "Save to Synapse"}
							</button>
						</div>
					</fieldset>
				</form>
			</section>
			{result && (
				<CaptureResult result={result} space={space} onNavigate={onNavigate} />
			)}
		</div>
	);
}
