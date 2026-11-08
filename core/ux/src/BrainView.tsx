import {
	BRAIN_SHARED_VAULT,
	type BrainCategory,
	type BrainImportResult,
	type BrainNoteSummary,
	type BrainTemplate,
	type BrainVault,
	type BrainVaultList,
	type TeamMember,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createBrainNote,
	fetchBrainCategories,
	fetchBrainExportZip,
	fetchBrainNotes,
	fetchBrainTemplates,
	fetchBrainVaults,
	importBrainNotes,
} from "./api.js";
import { BrainNote, shortDate } from "./BrainNote.js";
import { BrainProposals } from "./BrainProposals.js";
import {
	downloadBlob,
	filesToBrainFiles,
	vaultRelativePath,
} from "./brain-files.js";
import {
	type BrainRoute,
	brainHash,
	noteHash,
	parseBrainRoute,
} from "./brain-route.js";
import { Icon } from "./Icons.js";

type Panel = { kind: "new"; title: string } | { kind: "import" };

const vaultLabel = (vault: BrainVault) =>
	`${vault.kind === "shared" ? "Shared" : vault.name} (${vault.noteCount} ${vault.noteCount === 1 ? "note" : "notes"})`;

function NewNoteForm({
	vault,
	templates,
	initialTitle,
	onClose,
	onCreated,
}: {
	vault: string;
	templates: BrainTemplate[];
	initialTitle: string;
	onClose(): void;
	onCreated(title: string): void;
}) {
	const [title, setTitle] = useState(initialTitle);
	const [template, setTemplate] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	const chosen = templates.find((item) => item.name === template);
	return (
		<section className="card token-form" aria-labelledby="brain-new-heading">
			<div className="section-heading">
				<h2 id="brain-new-heading" tabIndex={-1} ref={heading}>
					New note
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close new note form"
					onClick={onClose}
					disabled={busy}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						const note = await createBrainNote(vault, {
							title: title.trim(),
							template: template || undefined,
						});
						onCreated(note.title);
					} catch (cause) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not create the note.",
						);
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="form-field">
						<label htmlFor="brain-new-title">Title</label>
						<input
							id="brain-new-title"
							required
							maxLength={200}
							value={title}
							placeholder="Ada Lovelace"
							onChange={(event) => setTitle(event.target.value)}
						/>
						<span className="field-hint">
							One note per thing, titled with its name. Evergreen ideas are
							titled as a statement. Titles are unique per vault and become file
							names.
						</span>
					</div>
					<div className="form-field">
						<label htmlFor="brain-new-template">Template</label>
						<select
							id="brain-new-template"
							value={template}
							onChange={(event) => setTemplate(event.target.value)}
						>
							<option value="">No template (blank note)</option>
							{templates.map((item) => (
								<option key={item.name} value={item.name}>
									{item.name}
								</option>
							))}
						</select>
						<span className="field-hint">
							{chosen
								? `${chosen.description} Properties: ${Object.keys(chosen.properties).join(", ")}.`
								: "Templates seed properties and set the note's category, so it shows up in that category's members."}
						</span>
					</div>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					<div className="form-actions">
						<button className="button" type="button" onClick={onClose}>
							Cancel
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={!title.trim()}
						>
							{busy ? "Creating…" : "Create note"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

function ImportForm({
	vault,
	onClose,
	onImported,
}: {
	vault: string;
	onClose(): void;
	onImported(result: BrainImportResult): void;
}) {
	const [files, setFiles] = useState<File[]>([]);
	const [overwrite, setOverwrite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<BrainImportResult | null>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	const pick = (list: FileList | null) => {
		if (!list) return;
		const picked = Array.from(list);
		setFiles((current) => {
			const paths = new Set(picked.map(vaultRelativePath));
			return [
				...current.filter((file) => !paths.has(vaultRelativePath(file))),
				...picked,
			];
		});
		setResult(null);
	};
	const markdown = files.filter((file) =>
		vaultRelativePath(file).toLowerCase().endsWith(".md"),
	);
	return (
		<section className="card token-form" aria-labelledby="brain-import-heading">
			<div className="section-heading">
				<h2 id="brain-import-heading" tabIndex={-1} ref={heading}>
					Import into{" "}
					{vault === BRAIN_SHARED_VAULT ? "the shared vault" : vault}
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close import form"
					onClick={onClose}
					disabled={busy}
				>
					<Icon name="close" />
				</button>
			</div>
			<p className="card-note">
				Pick Markdown files or a whole Obsidian vault folder. Each{" "}
				<code>.md</code> file becomes a note titled with its file name;
				frontmatter becomes properties. <code>.obsidian/</code>,{" "}
				<code>Templates/</code>, and non-Markdown files are skipped.
			</p>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy || !markdown.length) return;
					setBusy(true);
					setError("");
					try {
						const entries = await filesToBrainFiles(markdown);
						const outcome = await importBrainNotes(vault, {
							files: entries,
							overwrite,
						});
						setResult(outcome);
						setFiles([]);
						onImported(outcome);
					} catch (cause) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not import the files.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="brain-import-pickers">
						<div className="form-field">
							<label htmlFor="brain-import-files">Markdown files</label>
							<input
								id="brain-import-files"
								type="file"
								multiple
								accept=".md,text/markdown"
								onChange={(event) => pick(event.target.files)}
							/>
						</div>
						<div className="form-field">
							<label htmlFor="brain-import-folder">Vault folder</label>
							<input
								id="brain-import-folder"
								type="file"
								multiple
								{...({ webkitdirectory: "" } as Record<string, string>)}
								onChange={(event) => pick(event.target.files)}
							/>
						</div>
					</div>
					<label className="failover-enable brain-import-overwrite">
						<input
							type="checkbox"
							checked={overwrite}
							onChange={(event) => setOverwrite(event.target.checked)}
						/>
						Overwrite existing notes
					</label>
					<p className="card-note" role="status">
						{markdown.length
							? `${markdown.length} Markdown ${markdown.length === 1 ? "file" : "files"} selected${files.length > markdown.length ? ` (${files.length - markdown.length} other files will be skipped)` : ""}.`
							: "No files selected."}
					</p>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					{result && (
						<div className="success-notice brain-import-result" role="status">
							<p>
								Imported: {result.created.length} created,{" "}
								{result.updated.length} updated, {result.skipped.length}{" "}
								skipped.
							</p>
							{result.skipped.length > 0 && (
								<ul>
									{result.skipped.map((item) => (
										<li key={item.path}>
											<code>{item.path}</code>: {item.reason}
										</li>
									))}
								</ul>
							)}
						</div>
					)}
					<div className="form-actions">
						<button className="button" type="button" onClick={onClose}>
							{result ? "Done" : "Cancel"}
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={!markdown.length}
						>
							{busy ? "Importing…" : "Import"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

function NotesList({
	vault,
	selected,
	version,
	onOpen,
	onNewNote,
}: {
	vault: string;
	selected: string | null;
	version: number;
	onOpen(title: string): void;
	onNewNote(): void;
}) {
	const [text, setText] = useState("");
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("");
	const [categories, setCategories] = useState<BrainCategory[]>([]);
	const [notes, setNotes] = useState<BrainNoteSummary[] | null>(null);
	const [total, setTotal] = useState(0);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const sequence = useRef(0);
	useEffect(() => {
		const timer = setTimeout(() => setQuery(text.trim()), 250);
		return () => clearTimeout(timer);
	}, [text]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after notes changed outside this list
	useEffect(() => {
		let cancelled = false;
		fetchBrainCategories(vault)
			.then((result) => {
				if (!cancelled) setCategories(result.categories);
			})
			.catch(() => {
				if (!cancelled) setCategories([]);
			});
		return () => {
			cancelled = true;
		};
	}, [vault, version]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after notes changed outside this list
	useEffect(() => {
		const request = ++sequence.current;
		setLoading(true);
		fetchBrainNotes(vault, {
			text: query || undefined,
			category: category || undefined,
			limit: 200,
		})
			.then((result) => {
				if (request !== sequence.current) return;
				setNotes(result.notes);
				setTotal(result.total);
				setError("");
			})
			.catch((cause) => {
				if (request !== sequence.current) return;
				setError(
					cause instanceof Error ? cause.message : "Could not load the notes.",
				);
			})
			.finally(() => {
				if (request === sequence.current) setLoading(false);
			});
		return () => {
			sequence.current++;
		};
	}, [vault, query, category, version]);
	const filtered = Boolean(query || category);
	return (
		<aside className="card brain-sidebar" aria-label="Notes">
			<div className="form-field">
				<label htmlFor="brain-search">Search notes</label>
				<div className="model-search brain-search">
					<Icon name="search" />
					<input
						id="brain-search"
						type="search"
						placeholder="Title, body, or property…"
						value={text}
						onChange={(event) => setText(event.target.value)}
					/>
				</div>
			</div>
			<div className="form-field">
				<label htmlFor="brain-category">Category</label>
				<select
					id="brain-category"
					value={category}
					onChange={(event) => setCategory(event.target.value)}
				>
					<option value="">All categories</option>
					{categories.map((item) => (
						<option key={item.title} value={item.title}>
							{item.title} ({item.count})
						</option>
					))}
				</select>
			</div>
			<p className="card-note brain-list-count" role="status">
				{loading && !notes
					? "Loading notes…"
					: `${total} ${total === 1 ? "note" : "notes"}${filtered ? " match" : ""}`}
			</p>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{notes?.length ? (
				<ul className="brain-note-list">
					{notes.map((note) => {
						const active = selected?.toLowerCase() === note.title.toLowerCase();
						return (
							<li key={note.id}>
								<a
									href={noteHash(vault, note.title)}
									aria-current={active ? "page" : undefined}
									onClick={(event) => {
										event.preventDefault();
										onOpen(note.title);
									}}
								>
									<strong>{note.title}</strong>
									<span className="brain-note-meta">
										{note.categories.map((item) => (
											<span className="brain-chip" key={item}>
												{item}
											</span>
										))}
										<time dateTime={note.updatedAt}>
											{shortDate(note.updatedAt)}
										</time>
									</span>
									{note.snippet && (
										<span className="brain-snippet">{note.snippet}</span>
									)}
								</a>
							</li>
						);
					})}
				</ul>
			) : notes && !loading ? (
				<div className="empty-state brain-empty-list">
					{filtered ? (
						"No notes match. Try another search or category."
					) : (
						<>
							No notes yet. Agents write here through MCP, or{" "}
							<button type="button" onClick={onNewNote}>
								create one from a template
							</button>
							.
						</>
					)}
				</div>
			) : null}
		</aside>
	);
}

export function BrainView({ user }: { user: TeamMember }) {
	const [route, setRoute] = useState<BrainRoute>(() =>
		parseBrainRoute(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setRoute(parseBrainRoute(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const navigate = useCallback((next: BrainRoute) => {
		const hash = brainHash(next);
		if (window.location.hash !== hash) window.history.pushState(null, "", hash);
		setRoute(next);
	}, []);
	const [vaults, setVaults] = useState<BrainVaultList | null>(null);
	const [templates, setTemplates] = useState<BrainTemplate[]>([]);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [panel, setPanel] = useState<Panel | null>(null);
	const [exporting, setExporting] = useState(false);
	/** Bumps when notes changed outside the list's own filters. */
	const [version, setVersion] = useState(0);
	const changed = useCallback(() => setVersion((value) => value + 1), []);
	const sequence = useRef(0);
	const loadVaults = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const result = await fetchBrainVaults();
			if (request === sequence.current) {
				setVaults(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(
					cause instanceof Error ? cause.message : "Could not load the Brain.",
				);
		}
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` refreshes note counts after changes
	useEffect(() => {
		void loadVaults();
		return () => {
			sequence.current++;
		};
	}, [loadVaults, version]);
	useEffect(() => {
		let cancelled = false;
		fetchBrainTemplates()
			.then((result) => {
				if (!cancelled) setTemplates(result.templates);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	const vaultOptions: BrainVault[] = (() => {
		const list = [...(vaults?.vaults ?? [])].sort((a, b) =>
			a.kind !== b.kind
				? a.kind === "shared"
					? -1
					: 1
				: a.name.localeCompare(b.name),
		);
		if (!list.some((vault) => vault.id === route.vault))
			list.push({
				id: route.vault as BrainVault["id"],
				kind: route.vault === BRAIN_SHARED_VAULT ? "shared" : "agent",
				name: route.vault === BRAIN_SHARED_VAULT ? "Shared" : route.vault,
				noteCount: 0,
				createdAt: null,
				updatedAt: null,
			});
		return list;
	})();
	const openNote = (title: string) =>
		navigate({ tab: "notes", vault: route.vault, title });
	const exportZip = async () => {
		setExporting(true);
		setError("");
		try {
			downloadBlob(
				await fetchBrainExportZip(route.vault),
				`${route.vault}.zip`,
			);
			setNotice(`Exported ${route.vault}.zip. Open the folder in Obsidian.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not export.");
		} finally {
			setExporting(false);
		}
	};
	const canDecide = user.role !== "member";
	return (
		<div className="dashboard brain-view">
			<header className="dashboard-header">
				<div>
					<h1>Brain</h1>
					<p className="page-description">
						Linked Markdown notes: the team's shared memory and each agent's
						private vault. Notes link with <code>[[Title]]</code> and are
						classified by category, not folders.
					</p>
				</div>
				{route.tab === "notes" && (
					<div className="header-actions">
						<button
							className="button"
							type="button"
							disabled={Boolean(panel)}
							onClick={() => {
								setNotice("");
								setPanel({ kind: "import" });
							}}
						>
							Import
						</button>
						<button
							className="button"
							type="button"
							disabled={exporting}
							onClick={() => void exportZip()}
						>
							{exporting ? "Exporting…" : "Export .zip"}
						</button>
						<button
							className="button primary"
							type="button"
							disabled={Boolean(panel)}
							onClick={() => {
								setNotice("");
								setPanel({ kind: "new", title: "" });
							}}
						>
							<Icon name="plus" />
							New note
						</button>
					</div>
				)}
			</header>
			<div className="brain-tabs" role="tablist" aria-label="Brain sections">
				<button
					type="button"
					role="tab"
					aria-selected={route.tab === "notes"}
					onClick={() =>
						navigate({ tab: "notes", vault: route.vault, title: null })
					}
				>
					Notes
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={route.tab === "proposals"}
					onClick={() => navigate({ ...route, tab: "proposals" })}
				>
					Proposals
				</button>
			</div>
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
			{vaults?.persistence === "memory" && (
				<p className="card-note">
					Notes are temporary until MongoDB is connected. They are lost when the
					API restarts.
				</p>
			)}
			{route.tab === "proposals" ? (
				<BrainProposals
					canDecide={canDecide}
					version={version}
					onDecided={changed}
				/>
			) : (
				<>
					{panel?.kind === "new" && (
						<NewNoteForm
							key={`new-${panel.title}`}
							vault={route.vault}
							templates={templates}
							initialTitle={panel.title}
							onClose={() => setPanel(null)}
							onCreated={(title) => {
								setPanel(null);
								setNotice(`Created “${title}”.`);
								changed();
								openNote(title);
							}}
						/>
					)}
					{panel?.kind === "import" && (
						<ImportForm
							vault={route.vault}
							onClose={() => setPanel(null)}
							onImported={changed}
						/>
					)}
					<div className="brain-layout">
						<div className="brain-side">
							<div className="form-field brain-vault-field">
								<label htmlFor="brain-vault">Vault</label>
								<select
									id="brain-vault"
									value={route.vault}
									onChange={(event) =>
										navigate({
											tab: "notes",
											vault: event.target.value,
											title: null,
										})
									}
								>
									{vaultOptions.map((vault) => (
										<option key={vault.id} value={vault.id}>
											{vaultLabel(vault)}
										</option>
									))}
								</select>
								<span className="field-hint">
									{route.vault === BRAIN_SHARED_VAULT
										? "The team canon. Agents read it and change it only through proposals."
										: "An agent's private memory, kept across token rolls. Only the team sees it here."}
								</span>
							</div>
							<NotesList
								key={route.vault}
								vault={route.vault}
								selected={route.title}
								version={version}
								onOpen={openNote}
								onNewNote={() => setPanel({ kind: "new", title: "" })}
							/>
						</div>
						<section className="card brain-main" aria-label="Note">
							{route.title ? (
								<BrainNote
									key={`${route.vault}/${route.title.toLowerCase()}`}
									vault={route.vault}
									title={route.title}
									version={version}
									onNavigate={openNote}
									onNewNote={(title) => {
										setNotice("");
										setPanel({ kind: "new", title });
									}}
									onChanged={(title) => {
										changed();
										if (title !== route.title) openNote(title);
									}}
									onDeleted={() => {
										setNotice(`Deleted “${route.title}”.`);
										changed();
										navigate({ tab: "notes", vault: route.vault, title: null });
									}}
								/>
							) : (
								<div className="brain-intro">
									<h2>Pick a note</h2>
									<p className="card-note">
										Choose a note from the list, search for one, or create a new
										note from a template. A note's page shows its properties,
										body, backlinks, related notes, and the links that don't
										resolve yet.
									</p>
									<p className="card-note">
										Vault: <strong>{route.vault}</strong>
										{vaults && ` · time zone ${vaults.timeZone}`}
									</p>
								</div>
							)}
						</section>
					</div>
				</>
			)}
		</div>
	);
}
