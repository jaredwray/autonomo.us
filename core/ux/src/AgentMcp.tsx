import {
	AGENT_KINDS,
	AGENT_TOKEN_PERMISSIONS,
	type AgentConnection,
	type AgentSummary,
	type AgentToken,
	type AgentTokenAction,
	type AgentTokenPermission,
	type AgentTokenSecret,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	createAgentToken,
	createOAuthAgent,
	disconnectAgentApp,
	fetchAgentConnections,
	fetchAgentTokens,
	mcpAddress,
	revokeAgentToken,
	rollAgentToken,
	updateAgentToken,
} from "./api.js";
import {
	NewSecret,
	PermissionFields,
	TokenForm,
	type TokenPanel,
	type TokenViewConfig,
} from "./TokensView.js";

const date = (value: string | null) =>
	value ? new Date(value).toLocaleString() : "Never";
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/** How agent tokens are created and changed, and what their grants mean. */
export const agentTokenConfig: TokenViewConfig<AgentTokenPermission> = {
	title: "Agents",
	tokenLabel: "agent",
	description: "",
	namePlaceholder: "Research agent",
	emptyMessage: "",
	permissionHint:
		"MCP Read lists the available tools. MCP Call runs them, which is how an agent reads and writes its Synapse and talks in its channels. Select both for a working agent. These grants give no REST API access.",
	permissions: AGENT_TOKEN_PERMISSIONS,
	permissionGroups: [
		{ resource: "mcp", label: "MCP", choices: ["mcp:read", "mcp:call"] },
		{
			resource: "channels",
			label: "Channels",
			choices: ["channels:manage"],
			hint: "Lets this agent create and manage channels, which opens every channel in the workspace to it.",
		},
	],
	api: {
		list: fetchAgentTokens,
		create: createAgentToken,
		update: updateAgentToken,
		roll: rollAgentToken,
		revoke: revokeAgentToken,
	},
};

/** An agent's MCP grants in words. */
export function grantsText(permissions: readonly AgentTokenPermission[]) {
	return (
		permissions
			.map((permission) => AGENT_TOKEN_PERMISSIONS[permission])
			.join(", ") || "No grants"
	);
}

export function AgentChips({
	kind,
	status,
}: Pick<AgentSummary, "kind" | "status">) {
	return (
		<>
			<span className="bot-chip">{AGENT_KINDS[kind]}</span>
			{status !== "active" && (
				<span className={`bot-chip ${status}`}>{status}</span>
			)}
		</>
	);
}

/** An agent's history: what was done to it, and apps signing in and out. */
function History({ actions }: { actions: AgentTokenAction[] }) {
	const heading = useId();
	return (
		<section className="card agents-card" aria-labelledby={heading}>
			<h3 id={heading}>History</h3>
			<p className="card-note">
				What was done to this agent, newest first. Token values are never
				included.
			</p>
			{actions.length ? (
				<div className="table-scroll">
					<table className="token-log-table">
						<thead>
							<tr>
								<th>Time</th>
								<th>Action</th>
								<th>Actor</th>
								<th>Details</th>
							</tr>
						</thead>
						<tbody>
							{actions.map((action) => (
								<tr key={action.id}>
									<td>{date(action.timestamp)}</td>
									<td className="token-action-name">{action.action}</td>
									<td>
										{action.actor === "user"
											? (action.actorName ?? "Team member")
											: action.actor === "owner"
												? "Owner credential (before team accounts)"
												: "Local admin"}
									</td>
									<td>{action.detail}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="card-note">Nothing yet.</p>
			)}
		</section>
	);
}

/** An agent that uses MCP, for someone who cannot manage it. */
export function McpAgentFacts({ agent }: { agent: AgentSummary }) {
	return (
		<section className="card agents-card" aria-label={agent.name}>
			<div className="bot-header">
				<h2>
					{agent.name}
					<AgentChips kind={agent.kind} status={agent.status} />
				</h2>
				<p className="card-note">Created {date(agent.createdAt)}</p>
			</div>
			<dl className="bot-facts">
				<dt>Connects with</dt>
				<dd>
					{agent.kind === "oauth"
						? "OAuth sign-in from an MCP app"
						: "An agent token"}
				</dd>
				<dt>Status</dt>
				<dd className="agent-status">{agent.status}</dd>
				<dt>Grants</dt>
				<dd>{grantsText(agent.permissions)}</dd>
				{agent.kind === "oauth" && (
					<>
						<dt>Apps signed in</dt>
						<dd>{agent.connections}</dd>
					</>
				)}
				<dt>Description</dt>
				<dd className="bot-instructions">
					{agent.description || "No description."}
				</dd>
			</dl>
		</section>
	);
}

/** An agent that holds an agent token: edit, roll, revoke, and its history. */
export function TokenAgent({
	token,
	actions,
	secret,
	onSecret,
	onChanged,
}: {
	token: AgentToken;
	actions: AgentTokenAction[];
	/** The token value made in this visit, shown once. */
	secret: AgentTokenSecret | null;
	onSecret(value: AgentTokenSecret | null): void;
	/** Something was saved: read the agents again and say so. */
	onChanged(message: string): void;
}) {
	const [panel, setPanel] = useState<TokenPanel<AgentTokenPermission> | null>(
		null,
	);
	const busy = Boolean(panel || secret);
	return (
		<>
			{secret && (
				<NewSecret
					config={agentTokenConfig}
					value={secret}
					onDismiss={() => onSecret(null)}
				/>
			)}
			{panel && (
				<TokenForm
					config={agentTokenConfig}
					key={`${panel.kind}-${token.id}`}
					panel={panel}
					onClose={() => setPanel(null)}
					onSaved={(message, value) => {
						setPanel(null);
						onSecret(value ?? null);
						onChanged(message);
					}}
				/>
			)}
			<section className="card agents-card" aria-label={token.name}>
				<div className="bot-header">
					<h2>
						{token.name}
						<AgentChips kind="token" status={token.status} />
					</h2>
					<p className="card-note">Created {date(token.createdAt)}</p>
				</div>
				<dl className="bot-facts">
					<dt>Token</dt>
					<dd>
						<code>{token.prefix}</code>
						{token.previousTokens.map((previous) => (
							<small className="token-date" key={previous.prefix}>
								Previous {previous.prefix}: works until{" "}
								{date(previous.expiresAt)}
							</small>
						))}
					</dd>
					<dt>Expires</dt>
					<dd>{date(token.expiresAt)}</dd>
					<dt>Status</dt>
					<dd className="agent-status">{token.status}</dd>
					<dt>Grants</dt>
					<dd>{grantsText(token.permissions)}</dd>
					<dt>Description</dt>
					<dd className="bot-instructions">
						{token.description || "No description."}
					</dd>
				</dl>
				<p className="card-note">
					The agent connects to <code>{mcpAddress()}</code> with its token as
					the bearer credential.
				</p>
				<div className="token-actions agent-actions">
					{(["edit", "roll", "revoke"] as const).map((kind) => {
						const label =
							kind === "edit" ? "Edit" : kind === "roll" ? "Roll" : "Revoke";
						return (
							<button
								key={kind}
								className={`button ${kind === "revoke" ? "danger" : ""}`}
								type="button"
								disabled={busy || token.status === "revoked"}
								aria-label={`${label} ${token.name}`}
								onClick={() => setPanel({ kind, token })}
							>
								{label}
							</button>
						);
					})}
				</div>
			</section>
			<History actions={actions} />
		</>
	);
}

/** Name, description, and grants of an agent that signs in with OAuth. */
export function OAuthAgentForm({
	agent,
	onSaved,
	onCancel,
}: {
	/** The agent to edit; absent to create one. */
	agent?: AgentToken;
	onSaved(agent: AgentToken): void;
	onCancel(): void;
}) {
	const id = useId();
	const [name, setName] = useState(agent?.name ?? "");
	const [description, setDescription] = useState(agent?.description ?? "");
	const [permissions, setPermissions] = useState<AgentTokenPermission[]>(() =>
		agent ? [...agent.permissions] : ["mcp:read", "mcp:call"],
	);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<form
			className="bot-form"
			onSubmit={async (event) => {
				event.preventDefault();
				if (busy) return;
				setBusy(true);
				setError("");
				const input = {
					name: name.trim(),
					description: description.trim(),
					permissions,
				};
				try {
					onSaved(
						agent
							? await updateAgentToken(agent.id, input)
							: await createOAuthAgent(input),
					);
				} catch (cause) {
					setError(errorText(cause, "Could not save the agent."));
					setBusy(false);
				}
			}}
		>
			<fieldset className="routing-fields" disabled={busy}>
				<div className="form-field">
					<label htmlFor={`${id}-name`}>Name</label>
					<input
						id={`${id}-name`}
						required
						maxLength={100}
						value={name}
						placeholder="Claude"
						onChange={(event) => setName(event.target.value)}
					/>
					<span className="field-hint">
						What people see in channels and type after @ to mention it.
					</span>
				</div>
				<div className="form-field">
					<label htmlFor={`${id}-description`}>Description</label>
					<textarea
						id={`${id}-description`}
						rows={2}
						maxLength={1000}
						value={description}
						placeholder="What is this agent for?"
						onChange={(event) => setDescription(event.target.value)}
					/>
				</div>
				<PermissionFields
					config={agentTokenConfig}
					value={permissions}
					onChange={setPermissions}
				/>
				{error && (
					<div className="banner-error" role="alert">
						{error}
					</div>
				)}
				<div className="form-actions">
					<button className="button" type="button" onClick={onCancel}>
						Cancel
					</button>
					<button
						className="button primary"
						type="submit"
						disabled={!name.trim()}
					>
						{busy ? "Saving…" : agent ? "Save changes" : "Create agent"}
					</button>
				</div>
			</fieldset>
		</form>
	);
}

/** The gateway's MCP address, to give to an app. */
function McpAddress() {
	const id = useId();
	const input = useRef<HTMLInputElement>(null);
	const [notice, setNotice] = useState("");
	return (
		<div className="form-field agent-address">
			<label htmlFor={id}>MCP address</label>
			<div className="agent-address-row">
				<input
					ref={input}
					id={id}
					readOnly
					spellCheck={false}
					value={mcpAddress()}
					onFocus={(event) => event.target.select()}
				/>
				<button
					className="button"
					type="button"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(mcpAddress());
							setNotice("Address copied.");
						} catch {
							input.current?.focus();
							input.current?.select();
							setNotice("Copy unavailable. Select and copy the address.");
						}
					}}
				>
					Copy address
				</button>
			</div>
			{notice && (
				<span className="field-hint" role="status">
					{notice}
				</span>
			)}
		</div>
	);
}

/**
 * An agent that apps sign in to with OAuth: how to connect one, the apps
 * signed in now, its grants, and revoking it.
 */
export function OAuthAgent({
	token,
	actions,
	created,
	onChanged,
}: {
	token: AgentToken;
	actions: AgentTokenAction[];
	/** The agent was made in this visit, so connecting an app comes first. */
	created: boolean;
	/** Something was saved: read the agents again and say so. */
	onChanged(message: string): void;
}) {
	const active = token.status === "active";
	const [connections, setConnections] = useState<AgentConnection[] | null>(
		null,
	);
	const [error, setError] = useState("");
	const [editing, setEditing] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [busy, setBusy] = useState(false);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		if (!active) {
			setConnections([]);
			return;
		}
		const request = ++sequence.current;
		try {
			const result = await fetchAgentConnections(token.id);
			if (request !== sequence.current) return;
			setConnections(result.connections);
			setError("");
		} catch (cause) {
			if (request === sequence.current)
				setError(errorText(cause, "Could not load the signed-in apps."));
		}
	}, [token.id, active]);
	useEffect(() => {
		void refresh();
		// An app that signs in while this page is open shows up by itself.
		const timer = setInterval(() => {
			if (!document.hidden) void refresh();
		}, 10_000);
		return () => {
			sequence.current++;
			clearInterval(timer);
		};
	}, [refresh]);
	const apps = useId();
	const connect = useId();
	return (
		<>
			<section className="card agents-card" aria-label={token.name}>
				<div className="bot-header">
					<h2>
						{token.name}
						<AgentChips kind="oauth" status={token.status} />
					</h2>
					<p className="card-note">Created {date(token.createdAt)}</p>
				</div>
				{error && (
					<div className="banner-error" role="alert">
						{error}
					</div>
				)}
				{editing ? (
					<OAuthAgentForm
						agent={token}
						onCancel={() => setEditing(false)}
						onSaved={(next) => {
							setEditing(false);
							onChanged(`Saved ${next.name}.`);
						}}
					/>
				) : (
					<>
						<dl className="bot-facts">
							<dt>Connects with</dt>
							<dd>OAuth sign-in from an MCP app. It has no token.</dd>
							<dt>Status</dt>
							<dd className="agent-status">{token.status}</dd>
							<dt>Grants</dt>
							<dd>{grantsText(token.permissions)}</dd>
							<dt>Description</dt>
							<dd className="bot-instructions">
								{token.description || "No description."}
							</dd>
						</dl>
						{confirming ? (
							<div className="synapse-inline-form">
								<p>
									Revoke <strong>{token.name}</strong>? Every app signed in to
									it is signed out at once, and none can sign in to it again.
									This cannot be undone.
								</p>
								<div className="form-actions">
									<button
										className="button"
										type="button"
										disabled={busy}
										onClick={() => setConfirming(false)}
									>
										Cancel
									</button>
									<button
										className="button danger"
										type="button"
										disabled={busy}
										onClick={async () => {
											setBusy(true);
											setError("");
											try {
												await revokeAgentToken(token.id);
												setConfirming(false);
												onChanged(`Revoked ${token.name}.`);
											} catch (cause) {
												setError(
													errorText(cause, "Could not revoke the agent."),
												);
											} finally {
												setBusy(false);
											}
										}}
									>
										{busy ? "Revoking…" : "Revoke agent"}
									</button>
								</div>
							</div>
						) : (
							active && (
								<div className="token-actions agent-actions">
									<button
										className="button"
										type="button"
										aria-label={`Edit ${token.name}`}
										onClick={() => setEditing(true)}
									>
										Edit
									</button>
									<button
										className="button danger"
										type="button"
										aria-label={`Revoke ${token.name}`}
										onClick={() => setConfirming(true)}
									>
										Revoke
									</button>
								</div>
							)
						)}
					</>
				)}
			</section>
			{active && (
				<section className="card agents-card" aria-labelledby={connect}>
					<h3 id={connect}>Connect an app</h3>
					{created && (
						<p className="analytics-notice">
							Next: connect an app. Nothing can act as this agent until one
							signs in.
						</p>
					)}
					<McpAddress />
					<ol className="agent-steps">
						<li>
							In the app (Claude, Cursor, or another MCP app), add an MCP server
							with this address. No token is needed.
						</li>
						<li>
							The app opens this dashboard in your browser and asks to sign in.
						</li>
						<li>
							Approve it and choose <strong>{token.name}</strong>. The app is
							then listed below.
						</li>
					</ol>
				</section>
			)}
			<section className="card agents-card" aria-labelledby={apps}>
				<h3 id={apps}>Signed-in apps</h3>
				<p className="card-note">
					Each app holds its own short-lived access and renews it by itself. A
					connection ends when its app has not renewed it for 30 days.
				</p>
				{connections?.length ? (
					<div className="table-scroll">
						<table className="token-log-table agent-connections">
							<thead>
								<tr>
									<th>App</th>
									<th>Signed in at</th>
									<th>Approved by</th>
									<th>Since</th>
									<th>Last renewed</th>
									<th>Ends</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{connections.map((connection) => (
									<tr key={connection.id}>
										<td>
											<strong>{connection.clientName}</strong>
											<small className="token-date">
												The app chose this name.
											</small>
										</td>
										<td>{connection.redirectHost}</td>
										<td>{connection.approvedBy}</td>
										<td>{date(connection.createdAt)}</td>
										<td>{date(connection.lastUsedAt)}</td>
										<td>{date(connection.expiresAt)}</td>
										<td>
											<button
												className="button danger"
												type="button"
												disabled={busy}
												aria-label={`Disconnect ${connection.clientName}`}
												onClick={async () => {
													setBusy(true);
													setError("");
													try {
														await disconnectAgentApp(token.id, connection.id);
														setConnections(
															(current) =>
																current?.filter(
																	(item) => item.id !== connection.id,
																) ?? null,
														);
														onChanged(`Disconnected ${connection.clientName}.`);
													} catch (cause) {
														setError(
															errorText(cause, "Could not disconnect the app."),
														);
														void refresh();
													} finally {
														setBusy(false);
													}
												}}
											>
												Disconnect
											</button>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p className="card-note" role={connections ? undefined : "status"}>
						{connections
							? active
								? "No app is signed in."
								: "This agent is revoked. No app can sign in to it."
							: error
								? "The signed-in apps could not be loaded."
								: "Loading…"}
					</p>
				)}
			</section>
			<History actions={actions} />
		</>
	);
}
