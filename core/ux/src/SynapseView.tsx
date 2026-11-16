import {
	SYNAPSE_GLOBAL_SPACE,
	SYNAPSE_SHARED_SPACE,
	type SynapseCategory,
	type SynapseImportResult,
	type SynapseNoteSummary,
	type SynapseSpace,
	type SynapseSpaceList,
	type SynapseTemplate,
	type TeamMember,
	type WorkspaceAccess,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createSynapseNote,
	fetchSynapseCategories,
	fetchSynapseExportZip,
	fetchSynapseNotes,
	fetchSynapseSpaces,
	fetchSynapseTemplates,
	importSynapseNotes,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { PageTabs } from "./PageTabs.js";
import { SynapseGraph } from "./SynapseGraph.js";
import { SynapseNote, shortDate } from "./SynapseNote.js";
import { SynapseProposals } from "./SynapseProposals.js";
import {
	downloadBlob,
	filesToSynapseFiles,
	importBatches,
	vaultRelativePath,
} from "./synapse-files.js";
import {
	noteHash,
	parseSynapseRoute,
	type SynapseRoute,
	synapseHash,
} from "./synapse-route.js";

type Panel = { kind: "new"; title: string } | { kind: "import" };

const SYNAPSE_TABS = [
	{ id: "notes", label: "Notes" },
	{ id: "proposals", label: "Proposals" },
] as const;

/** Counts are each space's own notes; Shared also shows Global's notes. */
const spaceLabel = (space: SynapseSpace) =>
	`${space.kind === "global" ? "Global" : space.kind === "shared" ? "Shared" : space.name} (${space.noteCount} ${space.noteCount === 1 ? "note" : "notes"}${space.kind === "shared" ? ", inherits Global" : ""})`;
const KIND_ORDER: Record<SynapseSpace["kind"], number> = {
	global: 0,
	shared: 1,
	agent: 2,
};
const spaceHint = (space: string) =>
	space === SYNAPSE_GLOBAL_SPACE
		? "The canon for every workspace. Each workspace's Shared space inherits it; owners and admins change it."
		: space === SYNAPSE_SHARED_SPACE
			? "This workspace's canon, including notes inherited from Global. Agents read it and change it only through proposals."
			: "An agent's private memory, kept across token rolls. Only the team sees it here.";

function NewNoteForm({
	space,
	templates,
	initialTitle,
	onClose,
	onCreated,
}: {
	space: string;
	templates: SynapseTemplate[];
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
		<section className="card token-form" aria-labelledby="synapse-new-heading">
			<div className="section-heading">
				<h2 id="synapse-new-heading" tabIndex={-1} ref={heading}>
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
						const note = await createSynapseNote(space, {
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
						<label htmlFor="synapse-new-title">Title</label>
						<input
							id="synapse-new-title"
							required
							maxLength={200}
							value={title}
							placeholder="Ada Lovelace"
							onChange={(event) => setTitle(event.target.value)}
						/>
						<span className="field-hint">
							One note per thing, titled with its name. Evergreen ideas are
							titled as a statement. Titles are unique per space and become file
							names.
						</span>
					</div>
					<div className="form-field">
						<label htmlFor="synapse-new-template">Template</label>
						<Dropdown
							id="synapse-new-template"
							value={template}
							onValueChange={(value) => setTemplate(value)}
						>
							<option value="">No template (blank note)</option>
							{templates.map((item) => (
								<option key={item.name} value={item.name}>
									{item.name}
								</option>
							))}
						</Dropdown>
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
	space,
	onClose,
	onImported,
}: {
	space: string;
	onClose(): void;
	onImported(result: SynapseImportResult): void;
}) {
	const [files, setFiles] = useState<File[]>([]);
	const [overwrite, setOverwrite] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<SynapseImportResult | null>(null);
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
		<section
			className="card token-form"
			aria-labelledby="synapse-import-heading"
		>
			<div className="section-heading">
				<h2 id="synapse-import-heading" tabIndex={-1} ref={heading}>
					Import into{" "}
					{space === SYNAPSE_SHARED_SPACE ? "the shared space" : space}
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
						const entries = await filesToSynapseFiles(markdown);
						const outcome: SynapseImportResult = {
							created: [],
							updated: [],
							skipped: [],
						};
						try {
							for (const files of importBatches(entries)) {
								const part = await importSynapseNotes(space, {
									files,
									overwrite,
								});
								outcome.created.push(...part.created);
								outcome.updated.push(...part.updated);
								outcome.skipped.push(...part.skipped);
								outcome.warnings = [
									...(outcome.warnings ?? []),
									...(part.warnings ?? []),
								];
								outcome.warningsTruncated ||= part.warningsTruncated;
							}
							setFiles([]);
						} finally {
							// Earlier batches stay imported even when a later one fails.
							if (outcome.created.length || outcome.updated.length) {
								setResult(outcome);
								onImported(outcome);
							} else if (outcome.skipped.length) setResult(outcome);
						}
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
					<div className="synapse-import-pickers">
						<div className="form-field">
							<label htmlFor="synapse-import-files">Markdown files</label>
							<input
								id="synapse-import-files"
								type="file"
								multiple
								accept=".md,text/markdown"
								onChange={(event) => pick(event.target.files)}
							/>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-import-folder">Vault folder</label>
							<input
								id="synapse-import-folder"
								type="file"
								multiple
								{...({ webkitdirectory: "" } as Record<string, string>)}
								onChange={(event) => pick(event.target.files)}
							/>
						</div>
					</div>
					<label className="failover-enable synapse-import-overwrite">
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
						<div className="success-notice synapse-import-result" role="status">
							<p>
								Imported: {result.created.length} created,{" "}
								{result.updated.length} updated, {result.skipped.length}{" "}
								skipped.
							</p>
							{Boolean(result.warnings?.length) && (
								<details>
									<summary>Link warnings ({result.warnings?.length})</summary>
									<p>
										Links were kept. These warnings reflect each imported batch;
										later batches may resolve them. Unresolved links can be
										intentional breadcrumbs.
									</p>
									<ul>
										{result.warnings?.map((warning, index) => (
											// biome-ignore lint/suspicious/noArrayIndexKey: batch warnings are an immutable result
											<li key={index}>
												{warning.source}: <code>{warning.target}</code> —{" "}
												{warning.reason === "invalid-target"
													? "invalid title or folder characters"
													: "no matching note"}
												.
												{warning.target !== warning.interpretedTarget && (
													<>
														{" "}
														Interpreted as{" "}
														<code>{warning.interpretedTarget}</code>.
													</>
												)}
												{Boolean(warning.suggestions.length) && (
													<>
														{" "}
														Possible titles: {warning.suggestions.join(", ")}.
													</>
												)}
											</li>
										))}
									</ul>
									{result.warningsTruncated && (
										<p>Only the first 100 warnings per batch are shown.</p>
									)}
								</details>
							)}
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
	space,
	selected,
	version,
	onOpen,
	onNewNote,
}: {
	space: string;
	selected: string | null;
	version: number;
	onOpen(title: string): void;
	/** Absent where the viewer cannot write, such as Global for members. */
	onNewNote?: () => void;
}) {
	const [text, setText] = useState("");
	const [query, setQuery] = useState("");
	const [category, setCategory] = useState("");
	const [categories, setCategories] = useState<SynapseCategory[]>([]);
	const [notes, setNotes] = useState<SynapseNoteSummary[] | null>(null);
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
		fetchSynapseCategories(space)
			.then((result) => {
				if (!cancelled) setCategories(result.categories);
			})
			.catch(() => {
				if (!cancelled) setCategories([]);
			});
		return () => {
			cancelled = true;
		};
	}, [space, version]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` reloads after notes changed outside this list
	useEffect(() => {
		const request = ++sequence.current;
		setLoading(true);
		fetchSynapseNotes(space, {
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
	}, [space, query, category, version]);
	const filtered = Boolean(query || category);
	return (
		<aside className="card synapse-sidebar" aria-label="Notes">
			<div className="form-field">
				<label htmlFor="synapse-search">Search notes</label>
				<div className="model-search synapse-search">
					<Icon name="search" />
					<input
						id="synapse-search"
						type="search"
						placeholder="Title, body, or property…"
						value={text}
						onChange={(event) => setText(event.target.value)}
					/>
				</div>
			</div>
			<div className="form-field">
				<label htmlFor="synapse-category">Category</label>
				<Dropdown
					id="synapse-category"
					value={category}
					onValueChange={(value) => setCategory(value)}
				>
					<option value="">All categories</option>
					{categories.map((item) => (
						<option key={item.title} value={item.title}>
							{item.title} ({item.count})
						</option>
					))}
				</Dropdown>
			</div>
			<p className="card-note synapse-list-count" role="status">
				{loading && !notes
					? "Loading notes…"
					: `${total} ${total === 1 ? "note" : "notes"}${filtered ? " match" : ""}${
							notes && notes.length < total
								? ` · showing the first ${notes.length}; search or filter to narrow`
								: ""
						}`}
			</p>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{notes?.length ? (
				<ul className="synapse-note-list">
					{notes.map((note) => {
						const active = selected?.toLowerCase() === note.title.toLowerCase();
						return (
							<li key={note.id}>
								<a
									href={noteHash(space, note.title)}
									aria-current={active ? "page" : undefined}
									onClick={(event) => {
										event.preventDefault();
										onOpen(note.title);
									}}
								>
									<strong>{note.title}</strong>
									<span className="synapse-note-meta">
										{space === SYNAPSE_SHARED_SPACE &&
											note.space === SYNAPSE_GLOBAL_SPACE && (
												<span
													className="synapse-chip synapse-inherited"
													title="Inherited from the global Synapse"
												>
													Global
												</span>
											)}
										{note.categories.map((item) => (
											<span className="synapse-chip" key={item}>
												{item}
											</span>
										))}
										<time dateTime={note.updatedAt}>
											{shortDate(note.updatedAt)}
										</time>
									</span>
									{note.snippet && (
										<span className="synapse-snippet">{note.snippet}</span>
									)}
								</a>
							</li>
						);
					})}
				</ul>
			) : notes && !loading ? (
				<div className="empty-state synapse-empty-list">
					{filtered ? (
						"No notes match. Try another search or category."
					) : onNewNote ? (
						<>
							No notes yet. Agents write here through MCP, or{" "}
							<button type="button" onClick={onNewNote}>
								create one from a template
							</button>
							.
						</>
					) : (
						"No notes yet. Owners and admins write the global canon."
					)}
				</div>
			) : null}
		</aside>
	);
}

export function SynapseView({
	user,
	workspace,
}: {
	user: TeamMember;
	workspace: WorkspaceAccess;
}) {
	const [route, setRoute] = useState<SynapseRoute>(() =>
		parseSynapseRoute(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setRoute(parseSynapseRoute(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const navigate = useCallback((next: SynapseRoute) => {
		const hash = synapseHash(next);
		if (window.location.hash !== hash) window.history.pushState(null, "", hash);
		setRoute(next);
	}, []);
	const [spaces, setSpaces] = useState<SynapseSpaceList | null>(null);
	const [templates, setTemplates] = useState<SynapseTemplate[]>([]);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [panel, setPanel] = useState<Panel | null>(null);
	const [exporting, setExporting] = useState(false);
	/** Bumps when notes changed outside the list's own filters. */
	const [version, setVersion] = useState(0);
	const changed = useCallback(() => setVersion((value) => value + 1), []);
	const sequence = useRef(0);
	const loadSpaces = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const result = await fetchSynapseSpaces();
			if (request === sequence.current) {
				setSpaces(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(
					cause instanceof Error ? cause.message : "Could not load Synapse.",
				);
		}
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `version` refreshes note counts after changes
	useEffect(() => {
		void loadSpaces();
		return () => {
			sequence.current++;
		};
	}, [loadSpaces, version]);
	useEffect(() => {
		let cancelled = false;
		fetchSynapseTemplates()
			.then((result) => {
				if (!cancelled) setTemplates(result.templates);
			})
			.catch(() => {});
		return () => {
			cancelled = true;
		};
	}, []);
	const spaceOptions: SynapseSpace[] = (() => {
		const list = [...(spaces?.spaces ?? [])].sort(
			(a, b) =>
				KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.name.localeCompare(b.name),
		);
		if (!list.some((space) => space.id === route.space))
			list.push({
				id: route.space as SynapseSpace["id"],
				kind:
					route.space === SYNAPSE_GLOBAL_SPACE
						? "global"
						: route.space === SYNAPSE_SHARED_SPACE
							? "shared"
							: "agent",
				name:
					route.space === SYNAPSE_GLOBAL_SPACE
						? "Global"
						: route.space === SYNAPSE_SHARED_SPACE
							? "Shared"
							: route.space,
				noteCount: 0,
				createdAt: null,
				updatedAt: null,
			});
		return list;
	})();
	const openNote = (title: string) =>
		navigate({ tab: "notes", space: route.space, title });
	const graphRoute: SynapseRoute = {
		tab: "notes",
		space: route.space,
		title: null,
	};
	/** The graph's "full screen", kept here so it outlasts a visit to a note. */
	const [graphExpanded, setGraphExpanded] = useState(false);
	const expanded = graphExpanded && route.tab === "notes" && !route.title;
	const startNote = (title: string) => {
		setNotice("");
		setPanel({ kind: "new", title });
	};
	/** The note last opened, so the graph can show where the viewer came from. */
	const [lastNote, setLastNote] = useState<{
		space: string;
		title: string;
	} | null>(null);
	useEffect(() => {
		if (route.title) setLastNote({ space: route.space, title: route.title });
	}, [route.space, route.title]);
	const showTab = (tab: SynapseRoute["tab"]) =>
		navigate(
			tab === "notes"
				? { tab: "notes", space: route.space, title: null }
				: { ...route, tab: "proposals" },
		);
	const exportZip = async () => {
		setExporting(true);
		setError("");
		try {
			downloadBlob(
				await fetchSynapseExportZip(route.space),
				`${route.space}.zip`,
			);
			setNotice(`Exported ${route.space}.zip. Open the folder in Obsidian.`);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : "Could not export.");
		} finally {
			setExporting(false);
		}
	};
	// Workspace admins decide this workspace's proposals (org owners and
	// admins are admins everywhere); only org owners and admins change Global.
	const canDecide = workspace.role === "admin";
	const canEdit =
		route.space !== SYNAPSE_GLOBAL_SPACE || user.role !== "member";
	return (
		<div className={`dashboard synapse-view${expanded ? " is-expanded" : ""}`}>
			{expanded ? (
				// The graph covers the page; the page keeps its heading.
				<h1 className="visually-hidden">Synapse</h1>
			) : (
				<>
					<header className="dashboard-header">
						<div>
							<h1>Synapse</h1>
							<p className="page-description">
								Linked Markdown notes: {workspace.name}'s shared memory, which
								inherits the global canon, and each agent's private space. Notes
								link with <code>[[Title]]</code> and are classified by category,
								not folders.
							</p>
						</div>
						{route.tab === "notes" && (
							<div className="header-actions">
								{canEdit && (
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
								)}
								<button
									className="button"
									type="button"
									disabled={exporting}
									onClick={() => void exportZip()}
								>
									{exporting ? "Exporting…" : "Export .zip"}
								</button>
								{canEdit && (
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
								)}
							</div>
						)}
					</header>
					<PageTabs
						label="Synapse sections"
						idPrefix="synapse"
						tabs={SYNAPSE_TABS}
						selected={route.tab}
						onSelect={showTab}
					/>
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
					{spaces?.persistence === "memory" && (
						<p className="card-note">
							Notes are temporary until MongoDB is connected. They are lost when
							the API restarts.
						</p>
					)}
				</>
			)}
			<div
				role="tabpanel"
				id="synapse-panel"
				// The tabs are hidden while the graph is expanded.
				aria-labelledby={expanded ? undefined : `synapse-tab-${route.tab}`}
				aria-label={expanded ? "Notes" : undefined}
			>
				{route.tab === "proposals" ? (
					<SynapseProposals
						canDecide={canDecide}
						version={version}
						onDecided={changed}
					/>
				) : (
					<>
						{panel?.kind === "new" && (
							<NewNoteForm
								key={`new-${panel.title}`}
								space={route.space}
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
								space={route.space}
								onClose={() => setPanel(null)}
								onImported={changed}
							/>
						)}
						<div className="synapse-layout">
							<div className="synapse-side" hidden={expanded}>
								<div className="form-field synapse-space-field">
									<label htmlFor="synapse-space">Space</label>
									<Dropdown
										id="synapse-space"
										value={route.space}
										onValueChange={(value) =>
											navigate({
												tab: "notes",
												space: value,
												title: null,
											})
										}
									>
										{spaceOptions.map((space) => (
											<option key={space.id} value={space.id}>
												{spaceLabel(space)}
											</option>
										))}
									</Dropdown>
									<span className="field-hint">
										{spaceHint(route.space)}
										{spaces && ` Dates and daily notes use ${spaces.timeZone}.`}
									</span>
								</div>
								<NotesList
									key={route.space}
									space={route.space}
									selected={route.title}
									version={version}
									onOpen={openNote}
									onNewNote={
										canEdit
											? () => setPanel({ kind: "new", title: "" })
											: undefined
									}
								/>
							</div>
							<section
								className="card synapse-main"
								aria-label={route.title ? "Note" : "Graph"}
							>
								{route.title ? (
									<>
										<a
											className="synapse-graph-back"
											href={synapseHash(graphRoute)}
											onClick={(event) => {
												event.preventDefault();
												navigate(graphRoute);
											}}
										>
											<span aria-hidden="true">← </span>Back to graph
										</a>
										<SynapseNote
											key={`${route.space}/${route.title.toLowerCase()}`}
											space={route.space}
											title={route.title}
											version={version}
											canEdit={canEdit}
											onNavigate={openNote}
											onNewNote={startNote}
											onChanged={(title) => {
												changed();
												if (title !== route.title) openNote(title);
											}}
											onDeleted={() => {
												setNotice(`Deleted “${route.title}”.`);
												changed();
												navigate(graphRoute);
											}}
										/>
									</>
								) : (
									<SynapseGraph
										key={route.space}
										space={route.space}
										spaceName={
											spaceOptions.find((space) => space.id === route.space)
												?.name ?? route.space
										}
										expanded={expanded}
										onExpandedChange={setGraphExpanded}
										version={version}
										canEdit={canEdit}
										current={
											lastNote?.space === route.space ? lastNote.title : null
										}
										onOpen={openNote}
										// The New note form is on the page the expanded graph covers.
										onNewNote={(title) => {
											setGraphExpanded(false);
											startNote(title);
										}}
									/>
								)}
							</section>
						</div>
					</>
				)}
			</div>
		</div>
	);
}
