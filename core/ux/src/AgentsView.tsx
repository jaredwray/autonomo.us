import type {
	AgentKind,
	AgentList,
	AgentSummary,
	AgentToken,
	AgentTokenSecret,
	AgentTokenSettings,
	ChannelSummary,
	WorkspaceAccess,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	InstructionsAgent,
	InstructionsForm,
	loadModelChoices,
	type ModelChoice,
} from "./AgentInstructions.js";
import {
	AgentChips,
	agentTokenConfig,
	grantsText,
	McpAgentFacts,
	OAuthAgent,
	OAuthAgentForm,
	TokenAgent,
} from "./AgentMcp.js";
import { agentsHash, parseAgentsRoute } from "./agents-route.js";
import { fetchAgents, fetchAgentTokens } from "./api.js";
import { Icon } from "./Icons.js";
import { TokenForm } from "./TokensView.js";

const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/** The three ways an agent is made; the choice is permanent. */
const KIND_CHOICES: ReadonlyArray<{
	kind: AgentKind;
	title: string;
	text: string;
}> = [
	{
		kind: "instructions",
		title: "With instructions",
		text: "The gateway runs it. It answers in channels when someone mentions it, using a model from this workspace.",
	},
	{
		kind: "oauth",
		title: "OAuth sign-in",
		text: "An MCP app such as Claude or Cursor signs in, and you approve it here. There is no token to copy.",
	},
	{
		kind: "token",
		title: "Token",
		text: "You copy an agent token into an MCP app or a script.",
	},
];

const summaryOf = (token: AgentToken): AgentSummary => ({
	id: token.id,
	kind: token.auth,
	name: token.name,
	description: token.description,
	status: token.status,
	permissions: token.permissions,
	model: null,
	connections: 0,
	createdAt: token.createdAt,
});

/** One line under an agent's name in the list. */
function summaryLine(agent: AgentSummary) {
	if (agent.kind === "instructions") return agent.model ?? "";
	const grants = grantsText(agent.permissions);
	return agent.kind === "oauth"
		? `${grants} · ${agent.connections} ${agent.connections === 1 ? "app" : "apps"} signed in`
		: grants;
}

export function AgentsView({
	workspace,
	channels,
}: {
	workspace: WorkspaceAccess;
	/** The workspace's open channels, to name the channel a run was in. */
	channels: ChannelSummary[] | null;
}) {
	// An agent acts in this workspace, so its admins manage every kind.
	const admin = workspace.role === "admin";
	const [route, setRoute] = useState(() =>
		parseAgentsRoute(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setRoute(parseAgentsRoute(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const navigate = useCallback((id: string | null) => {
		const hash = agentsHash(id);
		if (window.location.hash !== hash) window.history.pushState(null, "", hash);
		setRoute({ id });
	}, []);
	const { id } = route;
	const [list, setList] = useState<AgentList | null>(null);
	/** Token records and history, which only people who manage agents may read. */
	const [settings, setSettings] = useState<AgentTokenSettings | null>(null);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	/** `choose` asks how the agent is made; a kind shows that kind's form. */
	const [creating, setCreating] = useState<"choose" | AgentKind | null>(null);
	/** The agent made in this visit, which gets the "what next" line. */
	const [created, setCreated] = useState<string | null>(null);
	/** A token value made in this visit. It is shown once and never stored. */
	const [secret, setSecret] = useState<AgentTokenSecret | null>(null);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const [agents, tokens] = await Promise.all([
				fetchAgents(),
				admin ? fetchAgentTokens() : null,
			]);
			if (request !== sequence.current) return;
			setList(agents);
			setSettings(tokens);
			setError("");
		} catch (cause) {
			if (request === sequence.current)
				setError(errorText(cause, "Could not load the agents."));
		}
	}, [admin]);
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => {
			if (!document.hidden) void refresh();
		}, 30_000);
		return () => {
			sequence.current++;
			clearInterval(timer);
		};
	}, [refresh]);
	const [choices, setChoices] = useState<ModelChoice[] | null>(null);
	useEffect(() => {
		if (!admin) return;
		let cancelled = false;
		loadModelChoices()
			.then((result) => {
				if (!cancelled) setChoices(result);
			})
			.catch(() => {
				if (!cancelled) setChoices([]);
			});
		return () => {
			cancelled = true;
		};
	}, [admin]);

	/** Shows a new agent at once; the next read replaces what was guessed. */
	const added = (agent: AgentSummary, token?: AgentToken) => {
		setList(
			(current) =>
				current && {
					...current,
					agents: [
						...current.agents.filter((item) => item.id !== agent.id),
						agent,
					].sort((a, b) => a.name.localeCompare(b.name)),
				},
		);
		if (token)
			setSettings(
				(current) =>
					current && { ...current, tokens: [token, ...current.tokens] },
			);
		setCreating(null);
		setCreated(agent.id);
		setNotice(`Created ${agent.name}.`);
		navigate(agent.id);
		void refresh();
	};
	const changed = useCallback(
		(message: string) => {
			setNotice(message);
			void refresh();
		},
		[refresh],
	);
	const open = (next: string | null) => {
		setCreating(null);
		setNotice("");
		// A token value is for the person who made it, on the page where they did.
		setSecret(null);
		navigate(next);
	};

	const channelNames = new Map(
		channels?.map((channel) => [channel.id, channel.name]),
	);
	const agent = list?.agents.find((item) => item.id === id) ?? null;
	const token = settings?.tokens.find((item) => item.id === id) ?? null;
	const history =
		settings?.actions.filter((action) => action.tokenId === id) ?? [];
	const kindTitle = (kind: AgentKind) =>
		KIND_CHOICES.find((choice) => choice.kind === kind)?.title ?? "";
	return (
		<div className="dashboard agents-view">
			<header className="dashboard-header">
				<div>
					<h1>Agents</h1>
					<p className="page-description">
						An agent takes part in this workspace's channels and has its own
						Synapse space. The gateway runs one from instructions, or an MCP app
						connects as one by signing in or with a token.
					</p>
					{!admin && (
						<p className="page-description">
							A workspace admin manages agents. You can see them and what the
							gateway's own agents have answered.
						</p>
					)}
				</div>
				{admin && (
					<div className="header-actions">
						<button
							className="button primary"
							type="button"
							disabled={creating !== null}
							onClick={() => {
								setNotice("");
								setSecret(null);
								setCreating("choose");
							}}
						>
							<Icon name="plus" />
							New agent
						</button>
					</div>
				)}
			</header>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{notice && (
				<p className="success-notice agents-notice" role="status">
					{notice}
				</p>
			)}
			{list?.persistence === "memory" && (
				<p className="card-note">
					Agents are temporary until MongoDB is connected. They are lost when
					the API restarts.
				</p>
			)}
			<div className="agents-layout">
				<aside className="card agents-list" aria-label="Agent list">
					{list?.agents.length ? (
						<ul>
							{list.agents.map((item) => (
								<li key={item.id}>
									<a
										href={agentsHash(item.id)}
										aria-current={
											item.id === id && !creating ? "page" : undefined
										}
										onClick={(event) => {
											event.preventDefault();
											open(item.id);
										}}
									>
										<strong>
											{item.name}
											<AgentChips kind={item.kind} status={item.status} />
										</strong>
										<span className="bot-meta">{summaryLine(item)}</span>
									</a>
								</li>
							))}
						</ul>
					) : (
						<p className="card-note" role={list ? undefined : "status"}>
							{list
								? admin
									? "No agents yet. Create one to take part in your channels."
									: "No agents yet. A workspace admin can create one."
								: error
									? "Agents could not be loaded."
									: "Loading agents…"}
						</p>
					)}
				</aside>
				<div className="agents-main">
					{creating === "choose" ? (
						<section
							className="card agents-card"
							aria-labelledby="agent-new-heading"
						>
							<div className="section-heading">
								<h2 id="agent-new-heading">New agent</h2>
								<button
									type="button"
									className="icon-button"
									aria-label="Close new agent form"
									onClick={() => setCreating(null)}
								>
									<Icon name="close" />
								</button>
							</div>
							<p className="card-note">
								How is this agent made? This cannot be changed afterwards.
							</p>
							<ul className="agent-kind-list">
								{KIND_CHOICES.map((choice) => (
									<li key={choice.kind}>
										<button
											type="button"
											className="agent-kind-choice"
											onClick={() => setCreating(choice.kind)}
										>
											<strong>{choice.title}</strong>
											<span>{choice.text}</span>
										</button>
									</li>
								))}
							</ul>
						</section>
					) : creating === "token" ? (
						<TokenForm
							config={agentTokenConfig}
							panel={{ kind: "create" }}
							onClose={() => setCreating("choose")}
							onSaved={(_message, value) => {
								if (!value) return;
								setSecret(value);
								added(summaryOf(value.token), value.token);
							}}
						/>
					) : creating ? (
						<section
							className="card agents-card"
							aria-labelledby="agent-new-heading"
						>
							<div className="section-heading">
								<h2 id="agent-new-heading">
									New agent: {kindTitle(creating).toLowerCase()}
								</h2>
								<button
									type="button"
									className="icon-button"
									aria-label="Close new agent form"
									onClick={() => setCreating(null)}
								>
									<Icon name="close" />
								</button>
							</div>
							{creating === "instructions" ? (
								<InstructionsForm
									choices={choices}
									onCancel={() => setCreating("choose")}
									onSaved={(bot) =>
										added({
											id: bot.id,
											kind: "instructions",
											name: bot.name,
											description: "",
											status: bot.enabled ? "active" : "paused",
											permissions: [],
											model: bot.model,
											connections: 0,
											createdAt: bot.createdAt,
										})
									}
								/>
							) : (
								<>
									<p className="card-note">
										After this, give the app this gateway's MCP address. It
										signs in, and you approve it and choose this agent.
									</p>
									<OAuthAgentForm
										onCancel={() => setCreating("choose")}
										onSaved={(next) => added(summaryOf(next), next)}
									/>
								</>
							)}
						</section>
					) : agent?.kind === "instructions" ? (
						<InstructionsAgent
							key={agent.id}
							id={agent.id}
							admin={admin}
							choices={choices}
							channels={channelNames}
							created={created === agent.id}
							onError={setError}
							onSaved={(name) => changed(`Saved ${name}.`)}
							onDeleted={(name) => {
								navigate(null);
								changed(`Deleted ${name}.`);
							}}
						/>
					) : agent && token?.auth === "token" ? (
						<TokenAgent
							key={agent.id}
							token={token}
							actions={history}
							secret={secret?.token.id === agent.id ? secret : null}
							onSecret={setSecret}
							onChanged={changed}
						/>
					) : agent && token?.auth === "oauth" ? (
						<OAuthAgent
							key={agent.id}
							token={token}
							actions={history}
							created={created === agent.id}
							onChanged={changed}
						/>
					) : agent && (!admin || error) ? (
						<McpAgentFacts agent={agent} />
					) : (
						<section
							className="card agents-card agents-intro"
							aria-label="Agent"
						>
							{id && list && !agent ? (
								<>
									<h2>Agent not found</h2>
									<p className="card-note">
										It may have been deleted. Pick an agent from the list.
									</p>
								</>
							) : id ? (
								<p className="card-note" role="status">
									{error ? "This agent could not be loaded." : "Loading…"}
								</p>
							) : (
								<>
									<h2>
										{list?.agents.length ? "Pick an agent" : "How agents work"}
									</h2>
									<p className="card-note">
										An agent is a participant with a name: people add it to
										channels and mention it there, and it keeps notes in its own
										Synapse space. There are three ways to make one.
									</p>
									<dl className="agent-kinds">
										{KIND_CHOICES.map((choice) => (
											<div key={choice.kind}>
												<dt>{choice.title}</dt>
												<dd>{choice.text}</dd>
											</div>
										))}
									</dl>
								</>
							)}
						</section>
					)}
				</div>
			</div>
		</div>
	);
}
