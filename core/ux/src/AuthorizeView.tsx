import {
	type AgentSummary,
	type AgentTokenPermission,
	type OAuthSignIn,
	type OAuthSignInDecision,
	redirectUriProblem,
	type WorkspaceAccess,
} from "@autonomo.us/common";
import { useEffect, useId, useState } from "react";
import { agentTokenConfig, grantsText } from "./AgentMcp.js";
import { AuthLayout } from "./AuthScreens.js";
import {
	ApiError,
	approveOAuthSignIn,
	denyOAuthSignIn,
	fetchAgents,
	fetchOAuthSignIn,
} from "./api.js";
import { browser } from "./navigation.js";
import { PermissionFields } from "./TokensView.js";

const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;
const WORKSPACE_KEY = "autonomous.workspace";

/**
 * Whether the gateway's answer sends the browser to the address the person
 * was shown, with nothing but query parameters added. A dashboard must never
 * open a `javascript:` or `data:` address, whatever it is told.
 */
export function safeReturn(redirectTo: string, shown: string): boolean {
	try {
		const target = new URL(redirectTo);
		const expected = new URL(shown);
		const place = (url: URL) => `${url.protocol}//${url.host}${url.pathname}`;
		target.search = "";
		return (
			redirectUriProblem(target.href) === null &&
			place(target) === place(expected)
		);
	} catch {
		return false;
	}
}

type Outcome = "approved" | "denied";

/**
 * An MCP app asked to sign in to the gateway. The person decides here: which
 * workspace, and which agent the app becomes. Nothing is granted before that.
 */
export function AuthorizeView({
	id,
	workspaces,
	onLeave,
}: {
	id: string;
	workspaces: WorkspaceAccess[];
	/** Back to the dashboard. */
	onLeave(): void;
}) {
	const fields = useId();
	const [signIn, setSignIn] = useState<OAuthSignIn | null>(null);
	/** Why the sign-in cannot be decided: expired, decided already, or unreachable. */
	const [gone, setGone] = useState("");
	useEffect(() => {
		let cancelled = false;
		fetchOAuthSignIn(id)
			.then((result) => {
				if (!cancelled) setSignIn(result);
			})
			.catch((cause) => {
				if (cancelled) return;
				// 410: it expired, or someone decided it already.
				setGone(
					cause instanceof ApiError
						? cause.message
						: "The gateway could not be reached. Reload to try again.",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [id]);

	// Approving makes or picks an agent, which a workspace's admins do.
	const eligible = workspaces.filter(
		(workspace) => workspace.role === "admin" && !workspace.archivedAt,
	);
	const [workspaceId, setWorkspaceId] = useState(() => {
		let remembered: string | null = null;
		try {
			remembered = window.localStorage.getItem(WORKSPACE_KEY);
		} catch {}
		return (
			eligible.find((workspace) => workspace.id === remembered) ??
			eligible.find((workspace) => workspace.isDefault) ??
			eligible[0]
		)?.id;
	});
	const workspace = eligible.find((item) => item.id === workspaceId);
	/** The workspace's agents an app can sign in to; `null` while they load. */
	const [agents, setAgents] = useState<AgentSummary[] | null>(null);
	const [choice, setChoice] = useState<"existing" | "new">("new");
	const [agentId, setAgentId] = useState("");
	const [name, setName] = useState<string | null>(null);
	const [description, setDescription] = useState("");
	const [permissions, setPermissions] = useState<AgentTokenPermission[]>([
		"mcp:read",
		"mcp:call",
	]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [outcome, setOutcome] = useState<Outcome | null>(null);
	useEffect(() => {
		if (!workspaceId) return;
		let cancelled = false;
		setAgents(null);
		setAgentId("");
		fetchAgents(workspaceId)
			.then((result) => {
				if (cancelled) return;
				const found = result.agents.filter(
					(agent) => agent.kind === "oauth" && agent.status === "active",
				);
				setAgents(found);
				// With agents to choose from, the person picks one or asks for a new one.
				setChoice(found.length ? "existing" : "new");
			})
			.catch((cause) => {
				if (cancelled) return;
				setAgents([]);
				setChoice("new");
				setError(errorText(cause, "Could not load this workspace's agents."));
			});
		return () => {
			cancelled = true;
		};
	}, [workspaceId]);

	const finish = (decision: OAuthSignInDecision, result: Outcome) => {
		if (!signIn || !safeReturn(decision.redirectTo, signIn.redirectUri)) {
			setError(
				"The gateway answered with an address this dashboard will not open. Start the sign-in again from the app.",
			);
			return;
		}
		setOutcome(result);
		browser.assign(decision.redirectTo);
	};
	const decide = async (
		run: () => Promise<OAuthSignInDecision>,
		result: Outcome,
	) => {
		if (busy) return;
		setBusy(true);
		setError("");
		try {
			finish(await run(), result);
		} catch (cause) {
			if (cause instanceof ApiError && cause.status === 410)
				setGone(cause.message);
			else setError(errorText(cause, "The decision could not be saved."));
		} finally {
			setBusy(false);
		}
	};
	const agentName = name ?? signIn?.clientName ?? "";
	const dashboard = (
		<p className="auth-intro">
			<a
				href={`${window.location.pathname}${window.location.search}#/dashboard`}
				onClick={onLeave}
			>
				Open the dashboard
			</a>
		</p>
	);

	if (outcome)
		return (
			<AuthLayout labelledBy="authorize-heading">
				<h1 id="authorize-heading">
					{outcome === "approved" ? "Sign-in approved" : "Sign-in refused"}
				</h1>
				<p className="auth-intro" role="status">
					{outcome === "approved"
						? `${signIn?.clientName} is being sent back to finish signing in. Return to the app; you can close this tab.`
						: `${signIn?.clientName} was told the sign-in was refused. You can close this tab.`}
				</p>
				{dashboard}
			</AuthLayout>
		);
	if (gone)
		return (
			<AuthLayout labelledBy="authorize-heading">
				<h1 id="authorize-heading">This sign-in can't be decided</h1>
				<p className="banner-error" role="alert">
					{gone}
				</p>
				{dashboard}
			</AuthLayout>
		);
	if (!signIn)
		return (
			<AuthLayout labelledBy="authorize-heading">
				<h1 id="authorize-heading">An app wants to sign in</h1>
				<p className="auth-intro" role="status">
					Loading…
				</p>
			</AuthLayout>
		);
	const ready =
		Boolean(workspace) &&
		agents !== null &&
		(choice === "existing" ? Boolean(agentId) : Boolean(agentName.trim()));
	return (
		<AuthLayout labelledBy="authorize-heading" wide>
			<h1 id="authorize-heading">An app wants to sign in</h1>
			<p className="auth-intro">
				An MCP app asks to connect to this gateway as an agent. Approve it only
				if you started this sign-in yourself, just now, in that app.
			</p>
			<dl className="bot-facts authorize-facts">
				<dt>App</dt>
				<dd>
					<strong>{signIn.clientName}</strong>
					<span className="field-hint authorize-hint">
						The app chose this name itself. Nobody verified it.
						{signIn.clientUri && ` It says its site is ${signIn.clientUri}`}
					</span>
				</dd>
				<dt>Sent back to</dt>
				<dd>
					<strong>{signIn.redirectHost}</strong>
					<span className="field-hint authorize-hint">
						After you approve, the sign-in goes to{" "}
						<code>{signIn.redirectUri}</code>. Whoever controls that address
						acts as the agent.
					</span>
				</dd>
				<dt>Seen before</dt>
				<dd>
					{signIn.knownClient
						? "A sign-in from this app registration was approved before."
						: "No. This app registration has never been approved here."}
				</dd>
				<dt>Expires</dt>
				<dd>{new Date(signIn.expiresAt).toLocaleString()}</dd>
			</dl>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{eligible.length ? (
				<form
					className="bot-form"
					onSubmit={(event) => {
						event.preventDefault();
						if (!workspace || !ready) return;
						void decide(
							() =>
								approveOAuthSignIn(
									workspace.id,
									id,
									choice === "existing"
										? { agentId }
										: {
												agent: {
													name: agentName.trim(),
													description: description.trim(),
													permissions,
												},
											},
								),
							"approved",
						);
					}}
				>
					<fieldset className="routing-fields" disabled={busy}>
						<div className="form-field">
							<label htmlFor={`${fields}-workspace`}>Workspace</label>
							<select
								id={`${fields}-workspace`}
								value={workspaceId}
								onChange={(event) => setWorkspaceId(event.target.value)}
							>
								{eligible.map((item) => (
									<option key={item.id} value={item.id}>
										{item.name}
									</option>
								))}
							</select>
							<span className="field-hint">
								The agent works in this workspace only. You can approve in
								workspaces you are an admin of.
							</span>
						</div>
						<fieldset className="token-permission-fields">
							<legend>Agent</legend>
							{agents === null ? (
								<p className="card-note" role="status">
									Loading agents…
								</p>
							) : (
								<>
									{agents.length > 0 && (
										<div className="authorize-choice">
											<label className="token-permission-choice">
												<input
													type="radio"
													name={`${fields}-choice`}
													checked={choice === "existing"}
													onChange={() => setChoice("existing")}
												/>
												An existing agent
											</label>
											<label className="token-permission-choice">
												<input
													type="radio"
													name={`${fields}-choice`}
													checked={choice === "new"}
													onChange={() => setChoice("new")}
												/>
												A new agent
											</label>
										</div>
									)}
									{choice === "existing" ? (
										<div className="form-field">
											<label htmlFor={`${fields}-agent`}>Sign in as</label>
											<select
												id={`${fields}-agent`}
												required
												value={agentId}
												onChange={(event) => setAgentId(event.target.value)}
											>
												<option value="">Choose an agent…</option>
												{agents.map((agent) => (
													<option key={agent.id} value={agent.id}>
														{agent.name} ({grantsText(agent.permissions)})
													</option>
												))}
											</select>
											<span className="field-hint">
												Agents of this workspace that sign in with OAuth. The
												app gets the agent's grants and its channels.
											</span>
										</div>
									) : (
										<>
											<div className="form-field">
												<label htmlFor={`${fields}-name`}>Agent name</label>
												<input
													id={`${fields}-name`}
													required
													maxLength={100}
													value={agentName}
													onChange={(event) => setName(event.target.value)}
												/>
												<span className="field-hint">
													What people see in channels and type after @ to
													mention it.
												</span>
											</div>
											<div className="form-field">
												<label htmlFor={`${fields}-description`}>
													Description
												</label>
												<textarea
													id={`${fields}-description`}
													rows={2}
													maxLength={1000}
													value={description}
													placeholder="What is this agent for?"
													onChange={(event) =>
														setDescription(event.target.value)
													}
												/>
											</div>
											<PermissionFields
												config={agentTokenConfig}
												value={permissions}
												onChange={setPermissions}
											/>
										</>
									)}
								</>
							)}
						</fieldset>
						<div className="form-actions authorize-actions">
							<button
								className="button"
								type="button"
								onClick={() => void decide(() => denyOAuthSignIn(id), "denied")}
							>
								Deny
							</button>
							<button
								className="button primary"
								type="submit"
								disabled={!ready}
							>
								{busy ? "Saving…" : "Approve"}
							</button>
						</div>
					</fieldset>
				</form>
			) : (
				<>
					<p className="banner-warning" role="status">
						Approving needs a workspace admin, and you are not an admin of any
						workspace. Ask one to start the sign-in from the app, or deny it.
					</p>
					<div className="form-actions authorize-actions">
						<button
							className="button"
							type="button"
							disabled={busy}
							onClick={() => void decide(() => denyOAuthSignIn(id), "denied")}
						>
							Deny
						</button>
					</div>
				</>
			)}
		</AuthLayout>
	);
}
