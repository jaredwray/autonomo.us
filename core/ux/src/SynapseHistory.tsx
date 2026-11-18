import type {
	SynapseHistory as History,
	SynapseRevision,
	SynapseRevisionChange,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	fetchSynapseHistory,
	fetchSynapseRevision,
	restoreSynapseRevision,
} from "./api.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { failureMessage, shortDateTime } from "./synapse-shared.js";

const CHANGE_LABEL: Record<SynapseRevisionChange, string> = {
	created: "Created",
	updated: "Updated",
	deleted: "Deleted",
};

/** A note's past revisions: read any of them, and write one back as the newest. */
export function SynapseHistory({
	space,
	title,
	current,
	writable,
	onRestored,
}: {
	space: string;
	title: string;
	/** The note's revision now; the list reloads when it moves on. */
	current: number;
	/** The viewer may change this note here. */
	writable: boolean;
	/** A revision was restored; the note reloads. */
	onRestored(): Promise<void>;
}) {
	const [history, setHistory] = useState<History | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [shown, setShown] = useState<SynapseRevision | null>(null);
	/** The revision being fetched, for its button's label. */
	const [opening, setOpening] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);
	const sequence = useRef(0);
	/** Counts revisions opened, so a slow one never replaces a later choice. */
	const opened = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchSynapseHistory(space, title);
			if (request === sequence.current) {
				setHistory(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(failureMessage(cause, "Could not load the history."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [space, title]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: `current` reloads the list after the note changed
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh, current]);
	const open = async (revision: number) => {
		const request = ++opened.current;
		setOpening(revision);
		setError("");
		setNotice("");
		try {
			const result = await fetchSynapseRevision(space, title, revision);
			if (request === opened.current) setShown(result);
		} catch (cause) {
			if (request === opened.current)
				setError(failureMessage(cause, `Could not load revision ${revision}.`));
		} finally {
			if (request === opened.current) setOpening(null);
		}
	};
	const restore = async () => {
		if (busy || !shown) return;
		setBusy(true);
		setError("");
		try {
			const note = await restoreSynapseRevision(space, title, shown.revision);
			setNotice(
				`Restored revision ${shown.revision}. It is now revision ${note.revision}.`,
			);
			setShown(null);
			await onRestored();
		} catch (cause) {
			setError(failureMessage(cause, "Could not restore the revision."));
		} finally {
			setBusy(false);
		}
	};
	return (
		<section
			className="synapse-history"
			id="synapse-history"
			aria-labelledby="synapse-history-heading"
		>
			<h3 id="synapse-history-heading">History</h3>
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
			{history ? (
				<div className="table-scroll" aria-busy={loading}>
					<table className="synapse-table synapse-history-table">
						<caption className="visually-hidden">
							Revisions of {history.title}, newest first
						</caption>
						<thead>
							<tr>
								<th scope="col">Revision</th>
								<th scope="col">Change</th>
								<th scope="col">By</th>
								<th scope="col">When</th>
								<th scope="col">Size</th>
								<th scope="col">Source</th>
							</tr>
						</thead>
						<tbody>
							{history.revisions.map((item) => (
								<tr key={item.revision}>
									<th scope="row">
										{item.revision}
										{item.revision === current &&
											history.exists &&
											" (current)"}
									</th>
									<td>
										{CHANGE_LABEL[item.change]}
										{item.title !== history.title && ` as “${item.title}”`}
									</td>
									<td>{item.by.name}</td>
									<td>
										<time dateTime={item.at}>{shortDateTime(item.at)}</time>
									</td>
									<td>{item.size.toLocaleString("en-US")} characters</td>
									<td>
										<button
											className="button"
											type="button"
											aria-label={`View revision ${item.revision}`}
											aria-pressed={shown?.revision === item.revision}
											disabled={opening !== null || busy}
											onClick={() => void open(item.revision)}
										>
											{opening === item.revision ? "Loading…" : "View"}
										</button>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : loading ? (
				<LoadingBanner compact>Loading history…</LoadingBanner>
			) : null}
			{shown && (
				<section
					className="synapse-revision"
					aria-labelledby="synapse-revision-heading"
				>
					<div className="section-heading">
						<h4 id="synapse-revision-heading">
							Revision {shown.revision}:{" "}
							{CHANGE_LABEL[shown.change].toLowerCase()} by {shown.by.name} on{" "}
							{shortDateTime(shown.at)}
						</h4>
						<div className="token-actions">
							{writable && shown.revision !== current && (
								<button
									className="button primary"
									type="button"
									disabled={busy}
									onClick={() => void restore()}
								>
									{busy ? "Restoring…" : "Restore this revision"}
								</button>
							)}
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() => setShown(null)}
							>
								Close revision
							</button>
						</div>
					</div>
					<p className="card-note">
						{shown.change === "deleted"
							? "What the note held when it was deleted, as Markdown."
							: "The note as it was at this revision, as Markdown. Read-only."}
						{writable &&
							shown.revision !== current &&
							" Restoring writes it back as a new revision; nothing in the history is lost."}
						{shown.revision === current && " This is the current revision."}
					</p>
					<pre
						className="synapse-revision-source"
						// biome-ignore lint/a11y/noNoninteractiveTabindex: a long source scrolls, so the keyboard must reach it
						tabIndex={0}
					>
						{shown.markdown || "(Empty note.)"}
					</pre>
				</section>
			)}
		</section>
	);
}
