import {
	SYNAPSE_COMMITMENT_STATUSES,
	type SynapseCommitment,
	type SynapseCommitmentStatus,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createSynapseCommitment,
	fetchSynapseCommitments,
	recordSynapseCommitmentEvent,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { failureMessage, NoteLink } from "./synapse-shared.js";

const STATUS_LABEL: Record<SynapseCommitmentStatus, string> = {
	open: "Open",
	blocked: "Blocked",
	done: "Done",
	cancelled: "Cancelled",
};
/** Names typed with commas between them, as a list. */
const names = (value: string) =>
	value
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);

function NewCommitmentForm({
	space,
	onClose,
	onCreated,
}: {
	space: string;
	onClose(): void;
	onCreated(commitment: SynapseCommitment): void;
}) {
	const [title, setTitle] = useState("");
	const [owner, setOwner] = useState("");
	const [due, setDue] = useState("");
	const [project, setProject] = useState("");
	const [evidence, setEvidence] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	const submit = async () => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			onCreated(
				await createSynapseCommitment(space, {
					title: title.trim(),
					owner: names(owner),
					...(due ? { due } : {}),
					...(names(project).length ? { project: names(project) } : {}),
					evidence: evidence.trim(),
				}),
			);
		} catch (cause) {
			setError(failureMessage(cause, "Could not create the commitment."));
			setBusy(false);
		}
	};
	return (
		<section
			className="card token-form"
			aria-labelledby="synapse-commitment-new-heading"
		>
			<div className="section-heading">
				<h2 id="synapse-commitment-new-heading" tabIndex={-1} ref={heading}>
					New commitment
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close new commitment form"
					onClick={onClose}
					disabled={busy}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void submit();
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="form-field">
						<label htmlFor="synapse-commitment-title">Title</label>
						<input
							id="synapse-commitment-title"
							required
							maxLength={200}
							placeholder="Ship the pricing page"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
						/>
						<span className="field-hint">
							What is owed, as a short statement. It becomes a note in the
							Commitments category.
						</span>
					</div>
					<div className="form-row">
						<div className="form-field">
							<label htmlFor="synapse-commitment-owner">Owner</label>
							<input
								id="synapse-commitment-owner"
								required
								placeholder="Ada Lovelace"
								value={owner}
								onChange={(event) => setOwner(event.target.value)}
							/>
							<span className="field-hint">
								Who owes it. Separate several names with commas.
							</span>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-commitment-due">
								Due date (optional)
							</label>
							<input
								id="synapse-commitment-due"
								type="date"
								value={due}
								onChange={(event) => setDue(event.target.value)}
							/>
						</div>
						<div className="form-field">
							<label htmlFor="synapse-commitment-project">
								Project (optional)
							</label>
							<input
								id="synapse-commitment-project"
								value={project}
								onChange={(event) => setProject(event.target.value)}
							/>
						</div>
					</div>
					<div className="form-field">
						<label htmlFor="synapse-commitment-evidence">Evidence</label>
						<input
							id="synapse-commitment-evidence"
							required
							maxLength={500}
							placeholder="Weekly sync 2026-11-18"
							value={evidence}
							onChange={(event) => setEvidence(event.target.value)}
						/>
						<span className="field-hint">
							The message or note where it was promised: a note title, a{" "}
							<code>[[link]]</code>, or a message reference such as{" "}
							<code>channel:&lt;id&gt;#&lt;number&gt;</code>.
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
							disabled={!title.trim() || !owner.trim() || !evidence.trim()}
						>
							{busy ? "Creating…" : "Create commitment"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/** One commitment's update form: a new status from a person, or a new due date. */
function CommitmentUpdate({
	space,
	commitment,
	onClose,
	onRecorded,
}: {
	space: string;
	commitment: SynapseCommitment;
	onClose(): void;
	onRecorded(message: string): void;
}) {
	const [note, setNote] = useState("");
	const [due, setDue] = useState(commitment.due ?? "");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const id = "synapse-commitment-update";
	const record = async (
		event: Parameters<typeof recordSynapseCommitmentEvent>[2],
		message: string,
	) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			await recordSynapseCommitmentEvent(space, commitment.title, event);
			onRecorded(message);
		} catch (cause) {
			setError(failureMessage(cause, "Could not update the commitment."));
			setBusy(false);
		}
	};
	return (
		<fieldset
			className="synapse-inline-form synapse-commitment-update"
			disabled={busy}
		>
			<legend>Update “{commitment.title}”</legend>
			<div className="form-field">
				<label htmlFor={`${id}-note`}>Note (optional)</label>
				<input
					id={`${id}-note`}
					maxLength={1000}
					placeholder="What happened, in a sentence."
					value={note}
					onChange={(event) => setNote(event.target.value)}
				/>
				<span className="field-hint">
					Written to the commitment's activity with your name, as your
					confirmation.
				</span>
			</div>
			<div className="token-actions">
				{SYNAPSE_COMMITMENT_STATUSES.filter(
					(status) => status !== commitment.status,
				).map((status) => (
					<button
						key={status}
						className="button"
						type="button"
						onClick={() =>
							void record(
								{
									kind: "confirmation",
									status,
									...(note.trim() ? { text: note.trim() } : {}),
								},
								`Marked “${commitment.title}” ${STATUS_LABEL[status].toLowerCase()}.`,
							)
						}
					>
						Mark {STATUS_LABEL[status].toLowerCase()}
					</button>
				))}
			</div>
			<form
				className="synapse-commitment-due"
				onSubmit={(event) => {
					event.preventDefault();
					void record(
						{
							kind: "calendar",
							due,
							...(note.trim() ? { text: note.trim() } : {}),
						},
						`Moved “${commitment.title}” to ${due}.`,
					);
				}}
			>
				<div className="form-field">
					<label htmlFor={`${id}-due`}>New due date</label>
					<input
						id={`${id}-due`}
						type="date"
						required
						value={due}
						onChange={(event) => setDue(event.target.value)}
					/>
				</div>
				<button
					className="button"
					type="submit"
					disabled={!due || due === commitment.due}
				>
					Change due date
				</button>
			</form>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			<div className="form-actions">
				<button className="button" type="button" onClick={onClose}>
					Close
				</button>
			</div>
		</fieldset>
	);
}

/** A space's commitments: what was promised, by whom, by when, and how it stands. */
export function SynapseCommitments({
	space,
	canEdit,
	onNavigate,
	onChanged,
}: {
	space: string;
	/** False where the viewer may only read, such as Global for members. */
	canEdit: boolean;
	onNavigate(title: string): void;
	/** A commitment was written; the parent refreshes its counts. */
	onChanged(): void;
}) {
	const [commitments, setCommitments] = useState<SynapseCommitment[] | null>(
		null,
	);
	const [status, setStatus] = useState<SynapseCommitmentStatus | "">("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [creating, setCreating] = useState(false);
	/** Title of the commitment whose update form is open. */
	const [updating, setUpdating] = useState<string | null>(null);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchSynapseCommitments(space, {
				status: status || undefined,
			});
			if (request === sequence.current) {
				setCommitments(result.commitments);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(failureMessage(cause, "Could not load the commitments."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [space, status]);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	const written = (message: string) => {
		setNotice(message);
		onChanged();
		void refresh();
	};
	return (
		<div className="synapse-commitments">
			<div className="section-heading">
				<p className="page-description">
					What people and agents promised: who owes it, by when, and where it
					was said. A status changes on evidence or on a person's word; a
					calendar entry can only move the date.
				</p>
				{canEdit && (
					<button
						className="button primary"
						type="button"
						disabled={creating}
						onClick={() => {
							setNotice("");
							setCreating(true);
						}}
					>
						<Icon name="plus" />
						New commitment
					</button>
				)}
			</div>
			{!canEdit && (
				<p className="card-note">
					Only owners and admins change the global Synapse. You can read its
					commitments here.
				</p>
			)}
			{creating && (
				<NewCommitmentForm
					space={space}
					onClose={() => setCreating(false)}
					onCreated={(commitment) => {
						setCreating(false);
						written(`Created “${commitment.title}”.`);
					}}
				/>
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
			<section className="card" aria-labelledby="synapse-commitments-heading">
				<div className="section-heading">
					<h2 id="synapse-commitments-heading">Commitments</h2>
					<div className="form-field synapse-commitment-filter">
						<label htmlFor="synapse-commitment-status">Status</label>
						<Dropdown
							id="synapse-commitment-status"
							value={status}
							onValueChange={(value) => {
								setUpdating(null);
								setStatus(value as SynapseCommitmentStatus | "");
							}}
						>
							<option value="">All statuses</option>
							{SYNAPSE_COMMITMENT_STATUSES.map((item) => (
								<option key={item} value={item}>
									{STATUS_LABEL[item]}
								</option>
							))}
						</Dropdown>
					</div>
				</div>
				{commitments?.length ? (
					<div className="table-scroll" aria-busy={loading}>
						<table className="synapse-table synapse-commitment-table">
							<thead>
								<tr>
									<th scope="col">Commitment</th>
									<th scope="col">Owner</th>
									<th scope="col">Due</th>
									<th scope="col">Status</th>
									<th scope="col">Project</th>
									{canEdit && <th scope="col">Actions</th>}
								</tr>
							</thead>
							{commitments.map((commitment) => {
								// One inherited from Global is read-only in a workspace's Shared space.
								const writable = canEdit && commitment.space === space;
								const open = updating === commitment.title;
								return (
									<tbody key={`${commitment.space}/${commitment.title}`}>
										<tr>
											<th scope="row">
												<NoteLink
													space={space}
													title={commitment.title}
													onNavigate={onNavigate}
												/>
											</th>
											<td>{commitment.owner.join(", ") || "—"}</td>
											<td>
												{commitment.due ? (
													<time dateTime={commitment.due}>
														{commitment.due}
													</time>
												) : (
													"No date"
												)}
											</td>
											<td>
												<span
													className={`synapse-chip synapse-state-${commitment.status}`}
												>
													{STATUS_LABEL[commitment.status]}
												</span>
												{commitment.overdue && (
													<>
														{" "}
														<span className="synapse-chip synapse-overdue">
															Overdue
														</span>
													</>
												)}
											</td>
											<td>{commitment.project.join(", ") || "—"}</td>
											{canEdit && (
												<td>
													{writable ? (
														<button
															className="button"
															type="button"
															aria-expanded={open}
															aria-label={`Update ${commitment.title}`}
															onClick={() =>
																setUpdating(open ? null : commitment.title)
															}
														>
															Update
														</button>
													) : (
														<span className="synapse-result-meta">
															Inherited from Global
														</span>
													)}
												</td>
											)}
										</tr>
										{open && writable && (
											<tr className="synapse-commitment-editor">
												<td colSpan={6}>
													<CommitmentUpdate
														// A recorded event is a new revision: start the form again.
														key={commitment.revision}
														space={space}
														commitment={commitment}
														onClose={() => setUpdating(null)}
														onRecorded={(message) => {
															setUpdating(null);
															written(message);
														}}
													/>
												</td>
											</tr>
										)}
									</tbody>
								);
							})}
						</table>
					</div>
				) : loading && !commitments ? (
					<LoadingBanner>Loading commitments…</LoadingBanner>
				) : commitments ? (
					<div className="empty-state">
						{status
							? `No ${STATUS_LABEL[status].toLowerCase()} commitments in this space.`
							: "No commitments yet. They are notes in the Commitments category; agents record them through MCP, or create one here."}
					</div>
				) : null}
			</section>
		</div>
	);
}
