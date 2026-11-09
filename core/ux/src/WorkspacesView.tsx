import {
	TEAM_ROLES,
	type TeamMember,
	WORKSPACE_ROLES,
	type WorkspaceDetails,
	type WorkspaceList,
	type WorkspaceMembers,
	type WorkspaceRole,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	createWorkspace,
	fetchTeam,
	fetchWorkspace,
	fetchWorkspaceMembers,
	fetchWorkspaces,
	removeWorkspaceMember,
	setWorkspaceArchived,
	setWorkspaceMember,
	updateWorkspace,
} from "./api.js";
import { Icon } from "./Icons.js";

const date = (value: string) => new Date(value).toLocaleString();
const message = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

function CreateWorkspaceForm({
	onClose,
	onCreated,
}: {
	onClose(): void;
	onCreated(workspace: WorkspaceDetails): void;
}) {
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	return (
		<section
			className="card token-form"
			aria-labelledby="create-workspace-title"
		>
			<div className="section-heading">
				<h2 id="create-workspace-title" tabIndex={-1} ref={heading}>
					Create a workspace
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close workspace form"
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
						onCreated(
							await createWorkspace({
								name: name.trim(),
								description: description.trim(),
							}),
						);
					} catch (cause) {
						setError(message(cause, "Could not create the workspace."));
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="form-field">
						<label htmlFor="workspace-name">Name</label>
						<input
							id="workspace-name"
							required
							maxLength={100}
							placeholder="Hyphen"
							value={name}
							onChange={(event) => setName(event.target.value)}
						/>
					</div>
					<div className="form-field">
						<label htmlFor="workspace-description">Description</label>
						<input
							id="workspace-description"
							maxLength={1000}
							placeholder="Optional"
							value={description}
							onChange={(event) => setDescription(event.target.value)}
						/>
					</div>
					<p className="card-note">
						A new workspace starts empty: add its own connections, routing, and
						tokens. Keys set as environment variables stay in the Default
						workspace.
					</p>
				</fieldset>
				{error && (
					<p className="banner-error" role="alert">
						{error}
					</p>
				)}
				<div className="form-actions">
					<button
						type="button"
						className="button"
						onClick={onClose}
						disabled={busy}
					>
						Cancel
					</button>
					<button
						type="submit"
						className="button primary"
						disabled={busy || !name.trim()}
					>
						{busy ? "Creating…" : "Create workspace"}
					</button>
				</div>
			</form>
		</section>
	);
}

function MembersPanel({
	workspace,
	onError,
}: {
	workspace: WorkspaceDetails;
	onError(message: string): void;
}) {
	const [members, setMembers] = useState<WorkspaceMembers | null>(null);
	const [team, setTeam] = useState<TeamMember[]>([]);
	const [candidate, setCandidate] = useState("");
	const [role, setRole] = useState<WorkspaceRole>("member");
	const [busy, setBusy] = useState(false);
	const load = useCallback(async () => {
		try {
			const [list, settings] = await Promise.all([
				fetchWorkspaceMembers(workspace.id),
				fetchTeam(),
			]);
			setMembers(list);
			setTeam(settings.members);
		} catch (cause) {
			onError(message(cause, "Could not load members."));
		}
	}, [workspace.id, onError]);
	useEffect(() => {
		void load();
	}, [load]);
	const change = async (run: () => Promise<WorkspaceMembers>) => {
		setBusy(true);
		try {
			setMembers(await run());
			onError("");
		} catch (cause) {
			onError(message(cause, "Could not update members."));
		} finally {
			setBusy(false);
		}
	};
	const inWorkspace = new Set(members?.members.map((member) => member.id));
	const candidates = team.filter(
		(member) => member.role === "member" && !inWorkspace.has(member.id),
	);
	return (
		<section
			className="card"
			aria-labelledby="workspace-members-heading"
			aria-busy={busy}
		>
			<div className="section-heading">
				<h2 id="workspace-members-heading">Members</h2>
				<span className="card-note">
					Owners and admins can open every workspace.
				</span>
			</div>
			{members ? (
				<div className="table-scroll">
					<table className="tokens-table">
						<thead>
							<tr>
								<th>Person</th>
								<th>Team role</th>
								<th>Workspace role</th>
								<th>Actions</th>
							</tr>
						</thead>
						<tbody>
							{members.members.map((member) => (
								<tr key={member.id}>
									<td>
										<strong>{member.name || member.email}</strong>
										{member.name && (
											<small className="token-date">{member.email}</small>
										)}
									</td>
									<td>{TEAM_ROLES[member.orgRole]}</td>
									<td>
										{member.implicit ? (
											"Admin (from team role)"
										) : (
											<select
												aria-label={`Workspace role for ${member.name || member.email}`}
												value={member.role}
												disabled={busy}
												onChange={(event) =>
													void change(() =>
														setWorkspaceMember(
															workspace.id,
															member.id,
															event.target.value as WorkspaceRole,
														),
													)
												}
											>
												{(Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map(
													(item) => (
														<option key={item} value={item}>
															{WORKSPACE_ROLES[item]}
														</option>
													),
												)}
											</select>
										)}
									</td>
									<td>
										{!member.implicit && (
											<button
												type="button"
												className="button danger"
												disabled={busy}
												aria-label={`Remove ${member.name || member.email} from ${workspace.name}`}
												onClick={() =>
													void change(() =>
														removeWorkspaceMember(workspace.id, member.id),
													)
												}
											>
												Remove
											</button>
										)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="empty-state">Loading members…</p>
			)}
			{candidates.length > 0 ? (
				<form
					className="workspace-add-member"
					onSubmit={(event) => {
						event.preventDefault();
						if (!candidate) return;
						void change(async () => {
							const result = await setWorkspaceMember(
								workspace.id,
								candidate,
								role,
							);
							setCandidate("");
							return result;
						});
					}}
				>
					<div className="form-field">
						<label htmlFor="workspace-candidate">Add a team member</label>
						<select
							id="workspace-candidate"
							value={candidate}
							disabled={busy}
							onChange={(event) => setCandidate(event.target.value)}
						>
							<option value="">Choose a member…</option>
							{candidates.map((member) => (
								<option key={member.id} value={member.id}>
									{member.name
										? `${member.name} (${member.email})`
										: member.email}
								</option>
							))}
						</select>
					</div>
					<div className="form-field">
						<label htmlFor="workspace-candidate-role">Role</label>
						<select
							id="workspace-candidate-role"
							value={role}
							disabled={busy}
							onChange={(event) => setRole(event.target.value as WorkspaceRole)}
						>
							{(Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map((item) => (
								<option key={item} value={item}>
									{WORKSPACE_ROLES[item]}
								</option>
							))}
						</select>
					</div>
					<button
						type="submit"
						className="button primary"
						disabled={busy || !candidate}
					>
						Add to workspace
					</button>
				</form>
			) : (
				members && (
					<p className="card-note">
						Every team member is already here. Invite people from Team.
					</p>
				)
			)}
			{members && members.actions.length > 0 && (
				<details className="workspace-activity">
					<summary>Membership history</summary>
					<ul>
						{members.actions.slice(0, 20).map((action) => (
							<li key={action.id}>
								<time dateTime={action.timestamp}>
									{date(action.timestamp)}
								</time>{" "}
								{action.actorName}{" "}
								{action.action === "granted"
									? `added ${action.userEmail} as ${WORKSPACE_ROLES[action.after as WorkspaceRole]}`
									: action.action === "removed"
										? `removed ${action.userEmail}`
										: `changed ${action.userEmail} to ${WORKSPACE_ROLES[action.after as WorkspaceRole]}`}
							</li>
						))}
					</ul>
				</details>
			)}
		</section>
	);
}

function WorkspacePanel({
	id,
	canArchive,
	onChanged,
	onClose,
}: {
	id: string;
	canArchive: boolean;
	onChanged(notice: string): void;
	onClose(): void;
}) {
	const [workspace, setWorkspace] = useState<WorkspaceDetails | null>(null);
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		let active = true;
		fetchWorkspace(id).then(
			(details) => {
				if (!active) return;
				setWorkspace(details);
				setName(details.name);
				setDescription(details.description);
				heading.current?.focus();
			},
			(cause) => active && setError(message(cause, "Could not load.")),
		);
		return () => {
			active = false;
		};
	}, [id]);
	const showError = useCallback((text: string) => setError(text), []);
	if (!workspace)
		return (
			<section className="card" aria-busy="true">
				{error ? (
					<p className="banner-error" role="alert">
						{error}
					</p>
				) : (
					<p className="empty-state">Loading workspace…</p>
				)}
			</section>
		);
	const admin = workspace.role === "admin";
	const run = async (action: () => Promise<WorkspaceDetails>, done: string) => {
		setBusy(true);
		setError("");
		try {
			const next = await action();
			setWorkspace(next);
			onChanged(done);
		} catch (cause) {
			setError(message(cause, "Could not save."));
		} finally {
			setBusy(false);
		}
	};
	return (
		<>
			<section className="card token-form" aria-labelledby="workspace-panel">
				<div className="section-heading">
					<h2 id="workspace-panel" tabIndex={-1} ref={heading}>
						{workspace.name}
						{workspace.isDefault && (
							<span className="badge workspace-badge">Default</span>
						)}
						{workspace.archivedAt && (
							<span className="badge workspace-badge archived">Archived</span>
						)}
					</h2>
					<button
						type="button"
						className="icon-button"
						aria-label="Close workspace details"
						onClick={onClose}
					>
						<Icon name="close" />
					</button>
				</div>
				{error && (
					<p className="banner-error" role="alert">
						{error}
					</p>
				)}
				{admin ? (
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void run(
								() =>
									updateWorkspace(workspace.id, {
										name: name.trim(),
										description: description.trim(),
									}),
								"Workspace saved.",
							);
						}}
					>
						<fieldset
							className="routing-fields"
							disabled={busy || Boolean(workspace.archivedAt)}
						>
							<div className="form-field">
								<label htmlFor="workspace-edit-name">Name</label>
								<input
									id="workspace-edit-name"
									required
									maxLength={100}
									value={name}
									onChange={(event) => setName(event.target.value)}
								/>
							</div>
							<div className="form-field">
								<label htmlFor="workspace-edit-description">Description</label>
								<input
									id="workspace-edit-description"
									maxLength={1000}
									value={description}
									onChange={(event) => setDescription(event.target.value)}
								/>
							</div>
						</fieldset>
						<div className="form-actions">
							{canArchive && !workspace.isDefault && (
								<button
									type="button"
									className={`button ${workspace.archivedAt ? "" : "danger"}`}
									disabled={busy}
									onClick={() =>
										void run(
											() =>
												setWorkspaceArchived(
													workspace.id,
													!workspace.archivedAt,
												),
											workspace.archivedAt
												? `${workspace.name} was unarchived.`
												: `${workspace.name} was archived. Its tokens and sessions no longer work.`,
										)
									}
								>
									{workspace.archivedAt ? "Unarchive" : "Archive workspace"}
								</button>
							)}
							<button
								type="submit"
								className="button primary"
								disabled={
									busy ||
									Boolean(workspace.archivedAt) ||
									!name.trim() ||
									(name.trim() === workspace.name &&
										description.trim() === workspace.description)
								}
							>
								Save changes
							</button>
						</div>
					</form>
				) : (
					<p className="card-note">
						{workspace.description ||
							"You're a member here. A workspace admin manages its settings."}
					</p>
				)}
				<p className="card-note workspace-id">
					API base path: <code>/v1/{workspace.id}/</code>
				</p>
				{workspace.actions.length > 0 && (
					<details className="workspace-activity">
						<summary>Workspace history</summary>
						<ul>
							{workspace.actions.slice(0, 20).map((action) => (
								<li key={action.id}>
									<time dateTime={action.timestamp}>
										{date(action.timestamp)}
									</time>{" "}
									{action.detail}
									{action.actorName ? ` (${action.actorName})` : ""}
								</li>
							))}
						</ul>
					</details>
				)}
			</section>
			{admin && !workspace.archivedAt && (
				<MembersPanel workspace={workspace} onError={showError} />
			)}
		</>
	);
}

export function WorkspacesView({
	onChanged,
}: {
	/** Called after a create, rename, archive, or unarchive so the shell can refresh. */
	onChanged?(): void;
}) {
	const [data, setData] = useState<WorkspaceList | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [creating, setCreating] = useState(false);
	const [selected, setSelected] = useState<string | null>(null);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchWorkspaces();
			if (request === sequence.current) {
				setData(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(message(cause, "Could not load workspaces."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	const changed = (text: string) => {
		setNotice(text);
		void refresh();
		onChanged?.();
	};
	return (
		<div className="dashboard tokens-view workspaces-view">
			<header className="dashboard-header">
				<div>
					<h1>Workspaces</h1>
					<p className="page-description">
						Each workspace has its own connections, routing, tokens, and usage.
					</p>
				</div>
				<div className="header-actions">
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => void refresh()}
					>
						{loading ? "Loading…" : "Refresh"}
					</button>
					{data?.canCreate && (
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
							New workspace
						</button>
					)}
				</div>
			</header>
			{error && (
				<p className="banner-error" role="alert">
					{error}
				</p>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{creating && (
				<CreateWorkspaceForm
					onClose={() => setCreating(false)}
					onCreated={(workspace) => {
						setCreating(false);
						setSelected(workspace.id);
						changed(`${workspace.name} was created.`);
					}}
				/>
			)}
			<section className="card" aria-labelledby="workspaces-heading">
				<div className="section-heading">
					<h2 id="workspaces-heading">
						{data?.canCreate ? "All workspaces" : "Your workspaces"}
					</h2>
					<span className="card-note">
						{data?.workspaces.length ?? 0} total
					</span>
				</div>
				{data?.workspaces.length ? (
					<div className="table-scroll">
						<table className="tokens-table">
							<thead>
								<tr>
									<th>Workspace</th>
									<th>Your role</th>
									<th>Created</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{data.workspaces.map((workspace) => (
									<tr key={workspace.id}>
										<td>
											<strong>{workspace.name}</strong>
											{workspace.isDefault && (
												<span className="badge workspace-badge">Default</span>
											)}
											{workspace.archivedAt && (
												<span className="badge workspace-badge archived">
													Archived
												</span>
											)}
											{workspace.description && (
												<small className="token-date">
													{workspace.description}
												</small>
											)}
										</td>
										<td>
											{WORKSPACE_ROLES[workspace.role]}
											{workspace.implicit && (
												<small className="token-date">From team role</small>
											)}
										</td>
										<td>{date(workspace.createdAt)}</td>
										<td>
											<div className="token-actions">
												{!workspace.archivedAt && (
													<a
														className="button"
														href={`#/w/${workspace.id}/dashboard`}
													>
														Open
													</a>
												)}
												<button
													className="button"
													type="button"
													aria-label={`Manage ${workspace.name}`}
													aria-pressed={selected === workspace.id}
													onClick={() => {
														setNotice("");
														setSelected(workspace.id);
													}}
												>
													{workspace.role === "admin" ? "Manage" : "Details"}
												</button>
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p className="empty-state">
						{loading
							? "Loading workspaces…"
							: "You don't have access to a workspace yet. Ask an owner or admin to add you."}
					</p>
				)}
			</section>
			{selected && (
				<WorkspacePanel
					key={selected}
					id={selected}
					canArchive={Boolean(data?.canCreate)}
					onChanged={changed}
					onClose={() => setSelected(null)}
				/>
			)}
		</div>
	);
}
