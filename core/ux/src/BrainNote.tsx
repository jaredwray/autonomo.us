import type {
	BrainNoteSummary,
	BrainNoteView,
	BrainPropertyValue,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	ApiError,
	deleteBrainNote,
	fetchBrainNote,
	updateBrainNote,
} from "./api.js";
import {
	type InlineOptions,
	Markdown,
	renderInline,
} from "./brain-markdown.js";
import { noteHash } from "./brain-route.js";

export const shortDate = (value: string) => value.slice(0, 10);

type Mode = "read" | "edit" | "rename" | "delete";

function PropertyValue({
	value,
	options,
}: {
	value: BrainPropertyValue;
	options: InlineOptions;
}) {
	if (value === null || value === "")
		return <span className="brain-empty-value">—</span>;
	if (Array.isArray(value))
		return value.length ? (
			<span className="brain-chips">
				{value.map((item, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: list items may repeat and never reorder in place
					<span className="brain-chip" key={`${index}-${item}`}>
						{renderInline(item, options)}
					</span>
				))}
			</span>
		) : (
			<span className="brain-empty-value">—</span>
		);
	if (typeof value === "string") return <>{renderInline(value, options)}</>;
	return <>{String(value)}</>;
}

function NoteLinks<Note extends BrainNoteSummary>({
	notes,
	vault,
	onNavigate,
	detail,
}: {
	notes: Note[];
	vault: string;
	onNavigate(title: string): void;
	detail?(note: Note): string;
}) {
	return (
		<ul>
			{notes.map((note) => (
				<li key={note.id}>
					<a
						className="wikilink"
						href={noteHash(vault, note.title)}
						onClick={(event) => {
							event.preventDefault();
							onNavigate(note.title);
						}}
					>
						{note.title}
					</a>
					{detail && (
						<small className="brain-link-detail">{detail(note)}</small>
					)}
				</li>
			))}
		</ul>
	);
}

export function BrainNote({
	vault,
	title,
	version,
	onNavigate,
	onNewNote,
	onChanged,
	onDeleted,
}: {
	vault: string;
	title: string;
	/** Bumped by the parent when the vault changed elsewhere (import, proposal). */
	version: number;
	onNavigate(title: string): void;
	/** Opens the New note form prefilled with a breadcrumb title. */
	onNewNote(title: string): void;
	/** The note was saved or renamed; the parent refreshes its list. */
	onChanged(newTitle: string): void;
	onDeleted(): void;
}) {
	const [view, setView] = useState<BrainNoteView | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<{
		status: number;
		message: string;
	} | null>(null);
	const [mode, setMode] = useState<Mode>("read");
	const [draft, setDraft] = useState("");
	const [newTitle, setNewTitle] = useState("");
	const [busy, setBusy] = useState(false);
	const [formError, setFormError] = useState("");
	const [conflict, setConflict] = useState(false);
	/** The revision the draft was written against; saves send it, so a change made meanwhile is a 409, not an overwrite. */
	const [base, setBase] = useState(0);
	const sequence = useRef(0);
	const heading = useRef<HTMLHeadingElement>(null);

	const load = useCallback(async (): Promise<BrainNoteView | null> => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchBrainNote(vault, title);
			if (request === sequence.current) {
				setView(result);
				setError(null);
				return result;
			}
		} catch (cause) {
			if (request === sequence.current) {
				setView(null);
				setError({
					status: cause instanceof ApiError ? cause.status : 0,
					message:
						cause instanceof Error ? cause.message : "Could not load the note.",
				});
			}
		} finally {
			if (request === sequence.current) setLoading(false);
		}
		return null;
	}, [vault, title]);
	// A `version` bump re-reads the note after the vault changed elsewhere. It
	// leaves an open editor and its draft alone; saving still sends `base`.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` triggers the re-read
	useEffect(() => {
		void load();
		return () => {
			sequence.current++;
		};
	}, [load, version]);
	// Focus the title when the note first shows and after leaving a form, not on every refresh.
	const focusedNote = useRef<string | null>(null);
	const previousMode = useRef<Mode>(mode);
	useEffect(() => {
		const leftForm = previousMode.current !== "read" && mode === "read";
		previousMode.current = mode;
		if (!view || mode !== "read") return;
		if (leftForm || focusedNote.current !== view.note.id) {
			focusedNote.current = view.note.id;
			heading.current?.focus({ preventScroll: true });
		}
	}, [view, mode]);

	const options: InlineOptions = {
		resolved: new Map(
			view?.outgoing.map((link) => [link.title.toLowerCase(), link.exists]) ??
				[],
		),
		hrefFor: (target) => noteHash(vault, target),
		onNavigate,
	};

	const start = (next: Mode) => {
		setFormError("");
		setConflict(false);
		if (next === "edit") {
			setDraft(view?.markdown ?? "");
			setBase(view?.note.revision ?? 0);
		}
		if (next === "rename") setNewTitle(title);
		setMode(next);
	};
	const fail = (cause: unknown, fallback: string) => {
		if (cause instanceof ApiError && cause.status === 409) {
			setConflict(true);
			setFormError(
				`${cause.message} This note changed since you opened it. Reload to see the latest version; your draft stays in the editor until you cancel.`,
			);
		} else setFormError(cause instanceof Error ? cause.message : fallback);
	};
	const save = async () => {
		if (!view || busy) return;
		setBusy(true);
		setFormError("");
		try {
			await updateBrainNote(vault, title, {
				markdown: draft,
				revision: base,
			});
			setMode("read");
			onChanged(title);
			await load();
		} catch (cause) {
			fail(cause, "Could not save the note.");
		} finally {
			setBusy(false);
		}
	};
	const rename = async () => {
		if (!view || busy) return;
		const next = newTitle.trim();
		if (!next || next === title) {
			setMode("read");
			return;
		}
		setBusy(true);
		setFormError("");
		try {
			const note = await updateBrainNote(vault, title, {
				title: next,
				revision: view.note.revision,
			});
			setMode("read");
			onChanged(note.title);
		} catch (cause) {
			fail(cause, "Could not rename the note.");
		} finally {
			setBusy(false);
		}
	};
	const remove = async () => {
		if (busy) return;
		setBusy(true);
		setFormError("");
		try {
			await deleteBrainNote(vault, title);
			onDeleted();
		} catch (cause) {
			fail(cause, "Could not delete the note.");
			setBusy(false);
		}
	};
	/** Re-reads the note after a conflict; the editor keeps its draft but waits for the fresh revision. */
	const reload = async () => {
		setBusy(true);
		setConflict(false);
		setFormError("");
		try {
			// The draft now deliberately replaces the latest revision.
			const fresh = await load();
			if (fresh) setBase(fresh.note.revision);
		} finally {
			setBusy(false);
		}
	};

	if (error && !view) {
		return error.status === 404 ? (
			<div className="brain-missing">
				<h2>No note titled “{title}”</h2>
				<p className="card-note">
					Links to it are breadcrumbs: create the note and they resolve.
				</p>
				<button
					className="button primary"
					type="button"
					onClick={() => onNewNote(title)}
				>
					Create “{title}”
				</button>
			</div>
		) : (
			<div className="banner-error" role="alert">
				{error.message}{" "}
				<button className="button" type="button" onClick={() => void load()}>
					Retry
				</button>
			</div>
		);
	}
	if (!view)
		return (
			<p className="empty-state" role="status">
				Loading note…
			</p>
		);
	const { note } = view;
	const unresolved = view.outgoing.filter((link) => !link.exists);
	const properties = Object.entries(note.properties);
	return (
		<article
			className="brain-note"
			aria-labelledby="brain-note-title"
			aria-busy={loading}
		>
			<header className="brain-note-header">
				<div>
					<h2 id="brain-note-title" ref={heading} tabIndex={-1}>
						{note.title}
					</h2>
					<p className="card-note">
						{`Updated ${shortDate(note.updatedAt)} by ${note.updatedBy.name} · created ${shortDate(note.createdAt)} by ${note.createdBy.name} · revision ${note.revision}`}
					</p>
				</div>
				{mode === "read" && (
					<div className="token-actions">
						<button
							className="button"
							type="button"
							onClick={() => start("edit")}
						>
							Edit
						</button>
						<button
							className="button"
							type="button"
							onClick={() => start("rename")}
						>
							Rename
						</button>
						<button
							className="button danger"
							type="button"
							onClick={() => start("delete")}
						>
							Delete
						</button>
					</div>
				)}
			</header>
			{formError && (
				<div className="banner-error" role="alert">
					{formError}
					{conflict && (
						<>
							{" "}
							<button
								className="button"
								type="button"
								onClick={() => void reload()}
							>
								Reload note
							</button>
						</>
					)}
				</div>
			)}
			{mode === "edit" && (
				<form
					className="brain-editor"
					onSubmit={(event) => {
						event.preventDefault();
						void save();
					}}
				>
					<div className="form-field">
						<label htmlFor="brain-markdown">Markdown source</label>
						<textarea
							id="brain-markdown"
							value={draft}
							spellCheck={false}
							rows={18}
							disabled={busy}
							onChange={(event) => setDraft(event.target.value)}
						/>
						<span className="field-hint">
							Frontmatter between <code>---</code> lines becomes properties.
							Link other notes with <code>[[Title]]</code>; a link to a missing
							note is a breadcrumb for later.
						</span>
					</div>
					<div className="form-actions">
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => setMode("read")}
						>
							Cancel
						</button>
						<button className="button primary" type="submit" disabled={busy}>
							{busy ? "Saving…" : "Save note"}
						</button>
					</div>
				</form>
			)}
			{mode === "rename" && (
				<form
					className="brain-inline-form"
					onSubmit={(event) => {
						event.preventDefault();
						void rename();
					}}
				>
					<div className="form-field">
						<label htmlFor="brain-rename-title">New title</label>
						<input
							id="brain-rename-title"
							required
							maxLength={200}
							value={newTitle}
							disabled={busy}
							onChange={(event) => setNewTitle(event.target.value)}
						/>
						<span className="field-hint">
							Links to this note across the vault are rewritten, like Obsidian.
						</span>
					</div>
					<div className="form-actions">
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => setMode("read")}
						>
							Cancel
						</button>
						<button className="button primary" type="submit" disabled={busy}>
							{busy ? "Renaming…" : "Rename note"}
						</button>
					</div>
				</form>
			)}
			{mode === "delete" && (
				<form
					className="brain-inline-form"
					aria-label="Confirm delete"
					onSubmit={(event) => {
						event.preventDefault();
						void remove();
					}}
				>
					<p>
						Delete <strong>{note.title}</strong>? Links to it elsewhere stay as
						unresolved breadcrumbs. This cannot be undone.
					</p>
					<div className="form-actions">
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => setMode("read")}
						>
							Cancel
						</button>
						<button className="button danger" type="submit" disabled={busy}>
							{busy ? "Deleting…" : "Delete note"}
						</button>
					</div>
				</form>
			)}
			{mode !== "edit" && (
				<>
					{properties.length > 0 && (
						<table className="brain-properties">
							<caption className="visually-hidden">Properties</caption>
							<tbody>
								{properties.map(([key, value]) => (
									<tr key={key}>
										<th scope="row">{key}</th>
										<td>
											<PropertyValue value={value} options={options} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					)}
					{note.body.trim() ? (
						<Markdown source={note.body} {...options} />
					) : (
						<p className="card-note brain-empty-body">
							This note has no body yet. Edit it to add one.
						</p>
					)}
					{note.tags.length > 0 && (
						<p className="brain-tags">
							{note.tags.map((tag) => (
								<span className="brain-chip" key={tag}>
									#{tag}
								</span>
							))}
						</p>
					)}
					<div className="brain-sections">
						<section aria-labelledby="brain-backlinks">
							<h3 id="brain-backlinks">Backlinks ({view.backlinks.length})</h3>
							{view.backlinks.length ? (
								<NoteLinks
									notes={view.backlinks}
									vault={vault}
									onNavigate={onNavigate}
								/>
							) : (
								<p className="card-note">
									No note links here yet. Mention <code>[[{note.title}]]</code>{" "}
									in another note to connect them.
								</p>
							)}
						</section>
						<section aria-labelledby="brain-related">
							<h3 id="brain-related">Related ({view.related.length})</h3>
							{view.related.length ? (
								<NoteLinks
									notes={view.related}
									vault={vault}
									onNavigate={onNavigate}
									detail={(related) =>
										related.sharedLinks.length
											? `Shares ${related.sharedLinks.map((link) => `[[${link}]]`).join(", ")}`
											: "Linked directly"
									}
								/>
							) : (
								<p className="card-note">
									Notes that link here or share links appear as the graph grows.
								</p>
							)}
						</section>
						<section aria-labelledby="brain-unresolved">
							<h3 id="brain-unresolved">
								Unresolved links ({unresolved.length})
							</h3>
							{unresolved.length ? (
								<ul>
									{unresolved.map((link) => (
										<li key={link.title}>
											<button
												className="brain-breadcrumb"
												type="button"
												aria-label={`Create note ${link.title}`}
												title="Create this note"
												onClick={() => onNewNote(link.title)}
											>
												{link.title}
											</button>
										</li>
									))}
								</ul>
							) : (
								<p className="card-note">
									Every link here points at an existing note.
								</p>
							)}
						</section>
						{view.categoryMembers.length > 0 && (
							<section
								aria-labelledby="brain-members"
								className="brain-members"
							>
								<h3 id="brain-members">
									Notes in {note.title} ({view.categoryMembers.length})
								</h3>
								<NoteLinks
									notes={view.categoryMembers}
									vault={vault}
									onNavigate={onNavigate}
									detail={(member) => `Updated ${shortDate(member.updatedAt)}`}
								/>
							</section>
						)}
					</div>
				</>
			)}
		</article>
	);
}
