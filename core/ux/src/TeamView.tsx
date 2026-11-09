import {
	TEAM_INVITE_TTLS,
	TEAM_ROLES,
	type TeamInvite,
	type TeamInviteTtl,
	type TeamMember,
	type TeamRole,
	type TeamSettings,
	WORKSPACE_ROLES,
	type WorkspaceAccess,
	type WorkspaceRole,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { PasswordFields, passwordProblem } from "./AuthScreens.js";
import {
	addTeamMember,
	changePassword,
	createTeamInvite,
	fetchTeam,
	removeTeamMember,
	resetTeamPassword,
	revokeTeamInvite,
	updateTeamMember,
} from "./api.js";
import { Icon } from "./Icons.js";

type Panel =
	| { kind: "add" }
	| { kind: "invite" }
	| { kind: "password" }
	| { kind: "edit"; member: TeamMember }
	| { kind: "reset"; member: TeamMember }
	| { kind: "remove"; member: TeamMember }
	| { kind: "revoke"; invite: TeamInvite };

const date = (value: string | null) =>
	value ? new Date(value).toLocaleString() : "Never";
const displayName = (member: TeamMember) => member.name || member.email;
const joined = (member: TeamMember) =>
	member.joinedVia === "setup"
		? "Created the gateway"
		: `${member.joinedVia === "invite" ? "Invited" : "Added"} by ${member.addedBy}`;
export function inviteLink(token: string) {
	const { origin, pathname } = window.location;
	return `${origin}${pathname}#/invite/${token}`;
}

function RoleSelect({
	value,
	onChange,
	allowOwner,
}: {
	value: TeamRole;
	onChange(role: TeamRole): void;
	allowOwner: boolean;
}) {
	return (
		<div className="form-field">
			<label htmlFor="team-role">Role</label>
			<select
				id="team-role"
				value={value}
				onChange={(event) => onChange(event.target.value as TeamRole)}
			>
				{(Object.keys(TEAM_ROLES) as TeamRole[])
					.filter((role) => allowOwner || role !== "owner" || value === "owner")
					.map((role) => (
						<option key={role} value={role}>
							{TEAM_ROLES[role]}
						</option>
					))}
			</select>
			<span className="field-hint">
				Owners and admins manage the team and can open every workspace. Members
				open the workspaces they are added to. Only owners can grant or change
				the Owner role.
			</span>
		</div>
	);
}

/** A member's workspace access, by workspace name. */
function workspaceSummary(
	member: TeamMember,
	names: Map<string, string>,
): string {
	if (member.role !== "member") return "All workspaces";
	if (!member.workspaces.length) return "None";
	return member.workspaces
		.map(
			(item) =>
				`${names.get(item.workspaceId) ?? "Unavailable workspace"}${item.role === "admin" ? " (Admin)" : ""}`,
		)
		.join(", ");
}

function WorkspaceAccessFields({
	workspaces,
	workspaceId,
	role,
	onWorkspace,
	onRole,
}: {
	workspaces: WorkspaceAccess[];
	workspaceId: string;
	role: WorkspaceRole;
	onWorkspace(id: string): void;
	onRole(role: WorkspaceRole): void;
}) {
	return (
		<div className="form-row">
			<div className="form-field">
				<label htmlFor="team-workspace">Workspace</label>
				<select
					id="team-workspace"
					value={workspaceId}
					onChange={(event) => onWorkspace(event.target.value)}
				>
					<option value="">No workspace yet</option>
					{workspaces.map((workspace) => (
						<option key={workspace.id} value={workspace.id}>
							{workspace.name}
						</option>
					))}
				</select>
				<span className="field-hint">
					Members see only the workspaces they belong to.
				</span>
			</div>
			<div className="form-field">
				<label htmlFor="team-workspace-role">Workspace role</label>
				<select
					id="team-workspace-role"
					value={role}
					disabled={!workspaceId}
					onChange={(event) => onRole(event.target.value as WorkspaceRole)}
				>
					{(Object.keys(WORKSPACE_ROLES) as WorkspaceRole[]).map((item) => (
						<option key={item} value={item}>
							{WORKSPACE_ROLES[item]}
						</option>
					))}
				</select>
				<span className="field-hint">
					Workspace admins add connections and manage members.
				</span>
			</div>
		</div>
	);
}

function TeamForm({
	panel,
	allowOwner,
	workspaces,
	currentWorkspaceId,
	onClose,
	onSaved,
}: {
	panel: Panel;
	allowOwner: boolean;
	workspaces: WorkspaceAccess[];
	currentWorkspaceId: string | null;
	onClose(): void;
	onSaved(message: string, link?: string): void;
}) {
	const member = "member" in panel ? panel.member : undefined;
	const openWorkspaces = workspaces.filter(
		(workspace) => !workspace.archivedAt,
	);
	const [workspaceId, setWorkspaceId] = useState(
		() =>
			openWorkspaces.find((workspace) => workspace.id === currentWorkspaceId)
				?.id ??
			openWorkspaces[0]?.id ??
			"",
	);
	const [workspaceRole, setWorkspaceRole] = useState<WorkspaceRole>("member");
	const [email, setEmail] = useState("");
	const [name, setName] = useState(member?.name ?? "");
	const [role, setRole] = useState<TeamRole>(member?.role ?? "member");
	const [ttl, setTtl] = useState<TeamInviteTtl>(7);
	const [current, setCurrent] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	const needsPassword =
		panel.kind === "add" || panel.kind === "reset" || panel.kind === "password";
	const title = {
		add: "Add a member",
		invite: "Create an invite link",
		password: "Change your password",
		edit: `Edit ${member ? displayName(member) : ""}`,
		reset: `Reset password for ${member ? displayName(member) : ""}`,
		remove: `Remove ${member ? displayName(member) : ""}`,
		revoke: "Revoke invite link",
	}[panel.kind];
	const submitLabel = {
		add: "Add member",
		invite: "Create link",
		password: "Change password",
		edit: "Save changes",
		reset: "Reset password",
		remove: "Remove member",
		revoke: "Revoke link",
	}[panel.kind];
	const danger = panel.kind === "remove" || panel.kind === "revoke";
	return (
		<section className="card token-form" aria-labelledby="team-form-title">
			<div className="section-heading">
				<h2 id="team-form-title" tabIndex={-1} ref={heading}>
					{title}
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close team form"
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
					if (needsPassword) {
						const problem = passwordProblem(password, confirm);
						if (problem) {
							setError(problem);
							return;
						}
					}
					setBusy(true);
					setError("");
					const workspace =
						role === "member" && workspaceId
							? { workspaceId, role: workspaceRole }
							: undefined;
					try {
						if (panel.kind === "add") {
							const added = await addTeamMember({
								email: email.trim(),
								name: name.trim(),
								role,
								password,
								...(workspace ? { workspace } : {}),
							});
							onSaved(
								`${displayName(added)} was added. Share the password with them securely; they can change it after signing in.`,
							);
						} else if (panel.kind === "invite") {
							const created = await createTeamInvite({
								role,
								ttlDays: ttl,
								...(workspace ? { workspace } : {}),
							});
							onSaved("Invite link created.", inviteLink(created.token));
						} else if (panel.kind === "password") {
							await changePassword(current, password);
							onSaved("Password changed. Your other sessions were signed out.");
						} else if (panel.kind === "edit") {
							await updateTeamMember(panel.member.id, {
								name: name.trim(),
								role,
							});
							onSaved("Member updated.");
						} else if (panel.kind === "reset") {
							await resetTeamPassword(panel.member.id, password);
							onSaved(
								`Password reset for ${displayName(panel.member)}. They were signed out everywhere.`,
							);
						} else if (panel.kind === "remove") {
							await removeTeamMember(panel.member.id);
							onSaved(`${displayName(panel.member)} was removed.`);
						} else {
							await revokeTeamInvite(panel.invite.id);
							onSaved("Invite link revoked.");
						}
					} catch (cause) {
						setError(
							cause instanceof Error ? cause.message : "Could not save.",
						);
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					{panel.kind === "add" && (
						<div className="form-field">
							<label htmlFor="team-email">Email</label>
							<input
								id="team-email"
								type="email"
								required
								maxLength={254}
								autoComplete="off"
								value={email}
								onChange={(event) => setEmail(event.target.value)}
							/>
							<span className="field-hint">
								Their sign-in address. Nothing is sent to it.
							</span>
						</div>
					)}
					{(panel.kind === "add" || panel.kind === "edit") && (
						<div className="form-field">
							<label htmlFor="team-name">Name</label>
							<input
								id="team-name"
								maxLength={100}
								value={name}
								onChange={(event) => setName(event.target.value)}
							/>
						</div>
					)}
					{(panel.kind === "add" ||
						panel.kind === "edit" ||
						panel.kind === "invite") && (
						<RoleSelect
							value={role}
							onChange={setRole}
							allowOwner={allowOwner}
						/>
					)}
					{(panel.kind === "add" || panel.kind === "invite") &&
						role === "member" &&
						openWorkspaces.length > 0 && (
							<WorkspaceAccessFields
								workspaces={openWorkspaces}
								workspaceId={workspaceId}
								role={workspaceRole}
								onWorkspace={setWorkspaceId}
								onRole={setWorkspaceRole}
							/>
						)}
					{panel.kind === "edit" &&
						member &&
						member.role !== "member" &&
						role === "member" && (
							<p className="banner-warning" role="note">
								{member.workspaces.length
									? "As a member, they will keep only the workspaces they were added to before."
									: "As a member, they will lose access to every workspace until you add them to one in Workspaces."}
							</p>
						)}
					{panel.kind === "invite" && (
						<>
							<div className="form-field token-ttl">
								<label htmlFor="team-invite-ttl">Link expires after</label>
								<select
									id="team-invite-ttl"
									value={ttl}
									onChange={(event) =>
										setTtl(Number(event.target.value) as TeamInviteTtl)
									}
								>
									{TEAM_INVITE_TTLS.map((days) => (
										<option key={days} value={days}>
											{days} {days === 1 ? "day" : "days"}
										</option>
									))}
								</select>
							</div>
							<p className="card-note">
								Anyone with the link can create one account with this role. It
								works once, and you'll see it only once.
							</p>
						</>
					)}
					{panel.kind === "password" && (
						<div className="form-field">
							<label htmlFor="team-current-password">Current password</label>
							<input
								id="team-current-password"
								type="password"
								autoComplete="current-password"
								required
								value={current}
								onChange={(event) => setCurrent(event.target.value)}
							/>
						</div>
					)}
					{needsPassword && (
						<PasswordFields
							idPrefix="team"
							label={panel.kind === "add" ? "Initial password" : "New password"}
							password={password}
							confirm={confirm}
							onPassword={setPassword}
							onConfirm={setConfirm}
						/>
					)}
					{panel.kind === "reset" && (
						<p className="card-note">
							They'll be signed out everywhere and need the new password to sign
							in.
						</p>
					)}
					{panel.kind === "remove" && member && (
						<p>
							Remove <strong>{displayName(member)}</strong>? They'll be signed
							out everywhere and lose access immediately.
						</p>
					)}
					{panel.kind === "revoke" && (
						<p>
							Revoke the {TEAM_ROLES[panel.invite.role]} invite link{" "}
							<code>{panel.invite.prefix}</code>? It will stop working
							immediately.
						</p>
					)}
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
							className={`button ${danger ? "danger" : "primary"}`}
							type="submit"
							disabled={panel.kind === "add" && !email.trim()}
						>
							{busy ? "Saving…" : submitLabel}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

function NewInviteLink({
	link,
	onDismiss,
}: {
	link: string;
	onDismiss(): void;
}) {
	const [notice, setNotice] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	return (
		<section
			className="card token-secret"
			aria-labelledby="invite-link-heading"
		>
			<h2 id="invite-link-heading">Share this invite link</h2>
			<p className="card-note">
				This is the only time the link is shown. Send it to the person you're
				inviting over a channel you trust.
			</p>
			<div className="form-field">
				<label htmlFor="new-invite-link">Invite link</label>
				<textarea
					ref={input}
					id="new-invite-link"
					value={link}
					readOnly
					spellCheck={false}
					rows={3}
				/>
			</div>
			<div className="form-actions">
				<button
					className="button"
					type="button"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(link);
							setNotice("Link copied.");
						} catch {
							input.current?.focus();
							input.current?.select();
							setNotice("Copy unavailable. Select and copy the link above.");
						}
					}}
				>
					Copy link
				</button>
				<button className="button primary" type="button" onClick={onDismiss}>
					Done
				</button>
			</div>
			{notice && <p role="status">{notice}</p>}
		</section>
	);
}

export function TeamView({
	workspaces = [],
	currentWorkspaceId = null,
}: {
	workspaces?: WorkspaceAccess[];
	currentWorkspaceId?: string | null;
} = {}) {
	const [data, setData] = useState<TeamSettings | null>(null);
	const [panel, setPanel] = useState<Panel | null>(null);
	const [link, setLink] = useState("");
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await fetchTeam();
			if (request === sequence.current) {
				setData(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(
					cause instanceof Error ? cause.message : "Could not load the team.",
				);
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
	const me = data?.members.find((member) => member.id === data.currentUserId);
	const names = new Map(
		workspaces.map((workspace) => [workspace.id, workspace.name]),
	);
	const isOwner = me?.role === "owner";
	const canEdit = (member: TeamMember) =>
		Boolean(data?.canManage) && (isOwner || member.role !== "owner");
	const open = (next: Panel) => {
		setNotice("");
		setLink("");
		setPanel(next);
	};
	const busy = Boolean(panel || link);
	return (
		<div className="dashboard tokens-view team-view">
			<header className="dashboard-header">
				<div>
					<h1>Team</h1>
					<p className="page-description">
						Manage who can sign in to this dashboard.
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
					{me && (
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => open({ kind: "password" })}
						>
							Change password
						</button>
					)}
					{data?.canManage && (
						<>
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() => open({ kind: "add" })}
							>
								Add member
							</button>
							<button
								className="button primary"
								type="button"
								disabled={busy}
								onClick={() => open({ kind: "invite" })}
							>
								<Icon name="plus" />
								Invite member
							</button>
						</>
					)}
				</div>
			</header>
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
			{data?.persistence === "memory" && (
				<p className="card-note">
					Accounts and invites are temporary until MongoDB is connected. They
					are lost when the API restarts.
				</p>
			)}
			{data && !data.canManage && (
				<p className="card-note">Only owners and admins can change the team.</p>
			)}
			{panel && (
				<TeamForm
					key={`${panel.kind}-${panel.kind === "revoke" ? panel.invite.id : "member" in panel ? panel.member.id : ""}`}
					panel={panel}
					allowOwner={isOwner}
					workspaces={workspaces}
					currentWorkspaceId={currentWorkspaceId}
					onClose={() => setPanel(null)}
					onSaved={(message, created) => {
						setPanel(null);
						setNotice(message);
						setLink(created ?? "");
						void refresh();
					}}
				/>
			)}
			{link && <NewInviteLink link={link} onDismiss={() => setLink("")} />}
			<section className="card" aria-labelledby="members-heading">
				<div className="section-heading">
					<h2 id="members-heading">Members</h2>
					<span className="card-note">{data?.members.length ?? 0} total</span>
				</div>
				{data?.members.length ? (
					<div className="table-scroll">
						<table className="tokens-table">
							<thead>
								<tr>
									<th>Member</th>
									<th>Role</th>
									<th>Workspaces</th>
									<th>Joined</th>
									<th>Last sign-in</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{data.members.map((member) => {
									const self = member.id === data.currentUserId;
									return (
										<tr key={member.id}>
											<td>
												<strong>{displayName(member)}</strong>
												{self && <span className="team-you">You</span>}
												{member.name && (
													<small className="token-date">{member.email}</small>
												)}
											</td>
											<td>{TEAM_ROLES[member.role]}</td>
											<td>{workspaceSummary(member, names)}</td>
											<td>
												{joined(member)}
												<small className="token-date">
													{date(member.createdAt)}
												</small>
											</td>
											<td>{date(member.lastSignInAt)}</td>
											<td>
												{canEdit(member) ? (
													<div className="token-actions">
														<button
															className="button"
															type="button"
															disabled={busy}
															aria-label={`Edit ${displayName(member)}`}
															onClick={() => open({ kind: "edit", member })}
														>
															Edit
														</button>
														{!self && (
															<>
																<button
																	className="button"
																	type="button"
																	disabled={busy}
																	aria-label={`Reset password for ${displayName(member)}`}
																	onClick={() =>
																		open({ kind: "reset", member })
																	}
																>
																	Reset password
																</button>
																<button
																	className="button danger"
																	type="button"
																	disabled={busy}
																	aria-label={`Remove ${displayName(member)}`}
																	onClick={() =>
																		open({ kind: "remove", member })
																	}
																>
																	Remove
																</button>
															</>
														)}
													</div>
												) : (
													<span className="card-note">—</span>
												)}
											</td>
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				) : (
					<div className="empty-state">
						{loading
							? "Loading members…"
							: "The team could not be loaded. Try refreshing."}
					</div>
				)}
			</section>
			<section className="card" aria-labelledby="invites-heading">
				<h2 id="invites-heading">Invite links</h2>
				<p className="card-note">
					The latest 50 links, newest first. Link values are never shown again
					after creation.
				</p>
				{data?.invites.length ? (
					<div className="table-scroll">
						<table className="token-log-table">
							<thead>
								<tr>
									<th>Link</th>
									<th>Role</th>
									<th>Created</th>
									<th>Expires</th>
									<th>Status</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{data.invites.map((invite) => (
									<tr key={invite.id}>
										<td>
											<code>{invite.prefix}</code>
										</td>
										<td>{TEAM_ROLES[invite.role]}</td>
										<td>
											{invite.createdBy}
											<small className="token-date">
												{date(invite.createdAt)}
											</small>
										</td>
										<td>{date(invite.expiresAt)}</td>
										<td>
											<span
												className={`token-status ${invite.status === "pending" ? "active" : invite.status}`}
											>
												{invite.status}
											</span>
											{invite.acceptedBy && (
												<small className="token-date">
													By {invite.acceptedBy}
												</small>
											)}
										</td>
										<td>
											{invite.status === "pending" &&
											data.canManage &&
											(isOwner || invite.role !== "owner") ? (
												<button
													className="button danger"
													type="button"
													disabled={busy}
													aria-label={`Revoke ${TEAM_ROLES[invite.role]} invite ${invite.prefix}`}
													onClick={() => open({ kind: "revoke", invite })}
												>
													Revoke
												</button>
											) : (
												<span className="card-note">—</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<div className="empty-state">
						{loading ? "Loading invites…" : "No invite links yet."}
					</div>
				)}
			</section>
		</div>
	);
}
