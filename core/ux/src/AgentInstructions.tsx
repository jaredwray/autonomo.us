import {
	BOT_LIMITS,
	BOT_WEB_FOLLOW_UPS,
	BOT_WEB_SCOPES,
	type BotDetails,
	type BotLimits,
	type BotRun,
	type BotSummary,
	type BotWebFollowUps,
	type BotWebRequest,
	type BotWebScope,
	type CreateBotRequest,
	DEFAULT_BOT_LIMITS,
} from "@autonomo.us/common";
import {
	Fragment,
	useCallback,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	ApiError,
	createBot,
	decideBotWebRequest,
	deleteBot,
	fetchBot,
	fetchBotWebRequests,
	fetchModels,
	fetchRouting,
	updateBot,
} from "./api.js";
import { channelsHash } from "./channels-route.js";

const date = (value: string) => new Date(value).toLocaleString();
const count = (value: number) => value.toLocaleString();
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

export type ModelChoice = { value: string; label: string; disabled?: boolean };
/** What an agent can answer with: the workspace's chat models, `auto`, and its pools. */
export async function loadModelChoices(): Promise<ModelChoice[]> {
	const [models, routing] = await Promise.all([
		fetchModels(),
		fetchRouting().catch(() => null),
	]);
	return [
		...models.models
			.filter((model) => model.capability !== "decisions")
			.map((model) => ({ value: model.id, label: model.id })),
		...(routing
			? [
					{
						value: "auto",
						label: routing.config.auto.enabled
							? "auto (Auto routing)"
							: "auto (Auto routing is off)",
						disabled: !routing.config.auto.enabled,
					},
					...routing.config.pools.map((pool) => ({
						value: `pool/${pool.id}`,
						label: `pool/${pool.id}`,
					})),
				]
			: []),
	];
}

const LIMIT_FIELDS: ReadonlyArray<{
	key: keyof BotLimits;
	label: string;
	min?: number;
	max: number;
	hint: string;
}> = [
	{
		key: "repliesPerHour",
		label: "Replies an hour",
		max: BOT_LIMITS.maxRepliesPerHour,
		hint: "A mention past this is skipped, not queued.",
	},
	{
		key: "tokensPerDay",
		label: "Tokens a day",
		max: 1_000_000_000,
		hint: "Input and output together, counted from 00:00 UTC.",
	},
	{
		key: "maxOutputTokens",
		label: "Output tokens per reply",
		max: BOT_LIMITS.maxOutputTokens,
		hint: "The longest one reply can be.",
	},
	{
		key: "contextMessages",
		label: "Context messages",
		max: BOT_LIMITS.maxContextMessages,
		hint: "How many recent messages a reply sees.",
	},
	{
		key: "proxyRequestsPerDay",
		label: "Proxied requests a day",
		min: 0,
		max: BOT_LIMITS.maxProxyRequestsPerDay,
		hint: "Web fetches through the workspace's paid proxies, counted from 00:00 UTC. 0 allows plain requests only.",
	},
];

const RUN_STATUS: Record<BotRun["status"], string> = {
	pending: "Queued",
	running: "Replying",
	succeeded: "Succeeded",
	failed: "Failed",
	skipped: "Skipped",
};

/** What a new agent may fetch, and an agent saved before web scopes. */
const DEFAULT_WEB_SCOPE: BotWebScope = "mentioned";
const DEFAULT_WEB_FOLLOW_UPS: BotWebFollowUps = "same-site";

export const WEB_SCOPE_LABELS: Record<
	BotWebScope,
	{ label: string; hint: string }
> = {
	any: {
		label: "Any page",
		hint: "Whatever this workspace's domain rules allow.",
	},
	mentioned: {
		label: "Only links people post in the conversation, plus approved sites",
		hint: "Sites linked in the messages a reply sees. Any other site waits for a workspace admin to approve it.",
	},
	approved: {
		label: "Only approved sites",
		hint: "Every other site waits for a workspace admin to approve it.",
	},
};
export const WEB_FOLLOW_UP_LABELS: Record<BotWebFollowUps, string> = {
	any: "Any within scope",
	"same-site": "Only the same site",
	none: "None",
};

const HOST_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A host as the gateway stores it: lower case, without a trailing dot. */
export function cleanHost(value: string): string {
	return value.trim().toLowerCase().replace(/\.+$/, "");
}

/** Why a site cannot be added to an agent's approved sites, or null. */
export function approvedSiteProblem(
	value: string,
	hosts: readonly string[],
): string | null {
	const host = cleanHost(value);
	if (!host) return "Enter a site such as example.com.";
	if (/[/:?#@\s]/.test(host))
		return "Enter only the site, such as example.com, without https:// or a path.";
	if (!HOST_PATTERN.test(host))
		return `${host} is not a site name. Enter one such as example.com.`;
	if (hosts.includes(host)) return `${host} is already approved.`;
	if (hosts.length >= BOT_LIMITS.maxWebHosts)
		return `An agent has at most ${BOT_LIMITS.maxWebHosts} approved sites.`;
	return null;
}

/** The web scope fields of a bot, with the defaults for one saved before them. */
const webScopeOf = (bot?: Partial<BotDetails>) => ({
	webScope: bot?.webScope ?? DEFAULT_WEB_SCOPE,
	webFollowUps: bot?.webFollowUps ?? DEFAULT_WEB_FOLLOW_UPS,
	webHosts: bot?.webHosts ?? [],
});

/**
 * What an agent with web access may fetch: its scope, fetches after the
 * first in a reply, and the sites approved for it.
 */
function WebScopeFields({
	id,
	scope,
	followUps,
	hosts,
	onScope,
	onFollowUps,
	onHosts,
}: {
	id: string;
	scope: BotWebScope;
	followUps: BotWebFollowUps;
	hosts: string[];
	onScope(scope: BotWebScope): void;
	onFollowUps(followUps: BotWebFollowUps): void;
	onHosts(hosts: string[]): void;
}) {
	const [draft, setDraft] = useState("");
	const [problem, setProblem] = useState("");
	const add = () => {
		const found = approvedSiteProblem(draft, hosts);
		if (found) {
			setProblem(found);
			return;
		}
		onHosts([...hosts, cleanHost(draft)]);
		setDraft("");
		setProblem("");
	};
	return (
		<fieldset className="token-permission-fields bot-web-scope">
			<legend>Web scope</legend>
			<fieldset className="bot-web-choices">
				<legend>What it may fetch</legend>
				{BOT_WEB_SCOPES.map((value) => (
					<label className="bot-web-choice" key={value}>
						<input
							type="radio"
							name={`${id}-web-scope`}
							value={value}
							checked={scope === value}
							onChange={() => onScope(value)}
						/>
						<span>
							{WEB_SCOPE_LABELS[value].label}
							<span className="field-hint">{WEB_SCOPE_LABELS[value].hint}</span>
						</span>
					</label>
				))}
			</fieldset>
			<div className="form-field bot-hops">
				<label htmlFor={`${id}-follow-ups`}>
					Follow-up fetches in one reply
				</label>
				<select
					id={`${id}-follow-ups`}
					value={followUps}
					onChange={(event) =>
						onFollowUps(event.target.value as BotWebFollowUps)
					}
				>
					{BOT_WEB_FOLLOW_UPS.map((value) => (
						<option key={value} value={value}>
							{WEB_FOLLOW_UP_LABELS[value]}
						</option>
					))}
				</select>
				<span className="field-hint">
					Fetches after a reply's first one. Limiting them keeps a page from
					steering the agent to other sites.
				</span>
			</div>
			<div className="form-field">
				<span className="bot-web-label" id={`${id}-sites-label`}>
					Approved sites
				</span>
				{hosts.length ? (
					<ul className="proxy-rules" aria-labelledby={`${id}-sites-label`}>
						{hosts.map((host) => (
							<li key={host}>
								<code>{host}</code>
								<button
									className="button"
									type="button"
									aria-label={`Remove ${host}`}
									onClick={() => onHosts(hosts.filter((item) => item !== host))}
								>
									Remove
								</button>
							</li>
						))}
					</ul>
				) : (
					<p className="card-note">No approved sites yet.</p>
				)}
				<div className="bot-web-add">
					<label className="visually-hidden" htmlFor={`${id}-site`}>
						Site to approve
					</label>
					<input
						id={`${id}-site`}
						value={draft}
						placeholder="example.com"
						onChange={(event) => {
							setDraft(event.target.value);
							setProblem("");
						}}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								add();
							}
						}}
					/>
					<button className="button" type="button" onClick={add}>
						Add site
					</button>
				</div>
				{problem ? (
					<span className="field-hint bot-web-problem" role="alert">
						{problem}
					</span>
				) : (
					<span className="field-hint">
						Each site also covers its subdomains. Approving a request below adds
						its site here.
					</span>
				)}
			</div>
		</fieldset>
	);
}

/**
 * Creates an agent the gateway runs, or edits one. Remounted when the
 * agent's revision changes.
 */
export function InstructionsForm({
	bot,
	choices,
	onSaved,
	onCancel,
}: {
	/** The agent to edit; absent to create one. */
	bot?: BotDetails;
	/** `null` while the workspace's models load. */
	choices: ModelChoice[] | null;
	onSaved(bot: BotDetails): void;
	onCancel?(): void;
}) {
	const id = useId();
	const [name, setName] = useState(bot?.name ?? "");
	const [instructions, setInstructions] = useState(bot?.instructions ?? "");
	const [model, setModel] = useState(bot?.model ?? "");
	const [enabled, setEnabled] = useState(bot?.enabled ?? true);
	const [tools, setTools] = useState(bot?.tools ?? false);
	const [web, setWeb] = useState(bot?.web ?? false);
	const [webScope, setWebScope] = useState(() => webScopeOf(bot).webScope);
	const [webFollowUps, setWebFollowUps] = useState(
		() => webScopeOf(bot).webFollowUps,
	);
	const [webHosts, setWebHosts] = useState(() => webScopeOf(bot).webHosts);
	const [agentHops, setAgentHops] = useState(bot?.agentHops ?? 0);
	const [limits, setLimits] = useState<Record<keyof BotLimits, string>>(() => {
		const from = bot?.limits ?? DEFAULT_BOT_LIMITS;
		return {
			repliesPerHour: String(from.repliesPerHour),
			tokensPerDay: String(from.tokensPerDay),
			maxOutputTokens: String(from.maxOutputTokens),
			contextMessages: String(from.contextMessages),
			proxyRequestsPerDay: String(
				from.proxyRequestsPerDay ?? DEFAULT_BOT_LIMITS.proxyRequestsPerDay,
			),
		};
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// The first model is the default for a new agent once the list arrives.
	useEffect(() => {
		if (bot || model || !choices) return;
		const first = choices.find((choice) => !choice.disabled);
		if (first) setModel(first.value);
	}, [bot, model, choices]);
	// An agent keeps a model that has since left the workspace until it is changed.
	const options =
		model && !choices?.some((choice) => choice.value === model)
			? [
					...(choices ?? []),
					{
						value: model,
						label: choices ? `${model} (not in this workspace now)` : model,
					},
				]
			: (choices ?? []);
	const input: CreateBotRequest = {
		name: name.trim(),
		instructions,
		model,
		enabled,
		tools,
		web,
		webScope,
		webFollowUps,
		webHosts,
		agentHops,
		limits: {
			repliesPerHour: Number(limits.repliesPerHour),
			tokensPerDay: Number(limits.tokensPerDay),
			maxOutputTokens: Number(limits.maxOutputTokens),
			contextMessages: Number(limits.contextMessages),
			proxyRequestsPerDay: Number(limits.proxyRequestsPerDay),
		},
	};
	const unchanged =
		bot !== undefined &&
		JSON.stringify(input) ===
			JSON.stringify({
				name: bot.name,
				instructions: bot.instructions,
				model: bot.model,
				enabled: bot.enabled,
				tools: bot.tools,
				web: bot.web ?? false,
				...webScopeOf(bot),
				agentHops: bot.agentHops,
				limits: {
					repliesPerHour: bot.limits.repliesPerHour,
					tokensPerDay: bot.limits.tokensPerDay,
					maxOutputTokens: bot.limits.maxOutputTokens,
					contextMessages: bot.limits.contextMessages,
					proxyRequestsPerDay:
						bot.limits.proxyRequestsPerDay ??
						DEFAULT_BOT_LIMITS.proxyRequestsPerDay,
				},
			} satisfies CreateBotRequest);
	return (
		<form
			className="bot-form"
			onSubmit={async (event) => {
				event.preventDefault();
				if (busy) return;
				setBusy(true);
				setError("");
				try {
					onSaved(
						bot
							? await updateBot(bot.id, { ...input, revision: bot.revision })
							: await createBot(input),
					);
				} catch (cause) {
					// The gateway says what is wrong: a taken name, a limit out of
					// range, or an agent that changed since it was read.
					setError(errorText(cause, "Could not save the agent."));
				} finally {
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
						maxLength={BOT_LIMITS.nameLength}
						value={name}
						placeholder="Helper"
						onChange={(event) => setName(event.target.value)}
					/>
					<span className="field-hint">
						What people type after @ to ask it. Unique in this workspace.
					</span>
				</div>
				<div className="form-field">
					<label htmlFor={`${id}-instructions`}>Instructions</label>
					<textarea
						id={`${id}-instructions`}
						rows={6}
						maxLength={BOT_LIMITS.instructionsLength}
						value={instructions}
						placeholder="What this agent is for and how it should answer."
						onChange={(event) => setInstructions(event.target.value)}
					/>
					<span className="field-hint">
						{count(instructions.length)} /{" "}
						{count(BOT_LIMITS.instructionsLength)} characters
					</span>
				</div>
				<div className="form-field">
					<label htmlFor={`${id}-model`}>Model</label>
					<select
						id={`${id}-model`}
						required
						value={model}
						onChange={(event) => setModel(event.target.value)}
					>
						{!model && (
							<option value="">
								{choices === null
									? "Loading models…"
									: options.length
										? "Choose a model…"
										: "No models in this workspace"}
							</option>
						)}
						{options.map((choice) => (
							<option
								key={choice.value}
								value={choice.value}
								disabled={choice.disabled && choice.value !== model}
							>
								{choice.label}
							</option>
						))}
					</select>
					<span className="field-hint">
						A model, a pool, or auto from this workspace's routing. Replies
						spend this workspace's provider keys.
					</span>
				</div>
				<div className="bot-switches">
					<label className="failover-enable">
						<input
							type="checkbox"
							aria-label="Active"
							checked={enabled}
							onChange={(event) => setEnabled(event.target.checked)}
						/>
						{enabled ? "Active" : "Paused"}
						<span className="field-hint">
							{enabled ? "Answers when mentioned." : "Answers nothing."}
						</span>
					</label>
					<label className="failover-enable">
						<input
							type="checkbox"
							checked={tools}
							onChange={(event) => setTools(event.target.checked)}
						/>
						Use tools
					</label>
					<span className="field-hint">
						Lets a reply search and write this agent's own Synapse space,
						propose changes to the shared space, and read its other channels.
					</span>
					<label className="failover-enable">
						<input
							type="checkbox"
							checked={web}
							onChange={(event) => setWeb(event.target.checked)}
						/>
						Web access
					</label>
					<span className="field-hint">
						Lets a reply read web pages with web_fetch: a plain request first,
						then the workspace's proxies when a site blocks it or needs a
						browser. Proxied requests are billed and limited below.
					</span>
				</div>
				{web && (
					<WebScopeFields
						id={id}
						scope={webScope}
						followUps={webFollowUps}
						hosts={webHosts}
						onScope={setWebScope}
						onFollowUps={setWebFollowUps}
						onHosts={setWebHosts}
					/>
				)}
				<div className="form-field bot-hops">
					<label htmlFor={`${id}-hops`}>Agent-to-agent replies</label>
					<select
						id={`${id}-hops`}
						value={agentHops}
						onChange={(event) => setAgentHops(Number(event.target.value))}
					>
						{Array.from({ length: BOT_LIMITS.maxAgentHops + 1 }, (_, hops) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: the options are the numbers themselves
							<option key={hops} value={hops}>
								{hops}
							</option>
						))}
					</select>
					<span className="field-hint">
						0 answers people only. Higher values let a chain of agents answer
						each other that many steps.
					</span>
				</div>
				<fieldset className="token-permission-fields bot-limits">
					<legend>Limits</legend>
					<div className="bot-limit-grid">
						{LIMIT_FIELDS.map((field) => (
							<div className="form-field" key={field.key}>
								<label htmlFor={`${id}-${field.key}`}>{field.label}</label>
								<input
									id={`${id}-${field.key}`}
									type="number"
									required
									min={field.min ?? 1}
									max={field.max}
									step={1}
									value={limits[field.key]}
									onChange={(event) =>
										setLimits({ ...limits, [field.key]: event.target.value })
									}
								/>
								<span className="field-hint">{field.hint}</span>
							</div>
						))}
					</div>
				</fieldset>
				{error && (
					<div className="banner-error" role="alert">
						{error}
					</div>
				)}
				<div className="form-actions">
					{onCancel && (
						<button className="button" type="button" onClick={onCancel}>
							Cancel
						</button>
					)}
					<button
						className="button primary"
						type="submit"
						disabled={!name.trim() || !model || unchanged}
					>
						{busy ? "Saving…" : bot ? "Save changes" : "Create agent"}
					</button>
				</div>
			</fieldset>
		</form>
	);
}

/** The settings of an agent with instructions, for someone who cannot change them. */
function BotFacts({ bot }: { bot: BotDetails }) {
	return (
		<dl className="bot-facts">
			<dt>Model</dt>
			<dd>{bot.model}</dd>
			<dt>Status</dt>
			<dd>{bot.enabled ? "Active" : "Paused"}</dd>
			<dt>Tools</dt>
			<dd>{bot.tools ? "On" : "Off"}</dd>
			<dt>Web access</dt>
			<dd>{bot.web ? "On" : "Off"}</dd>
			{bot.web && (
				<>
					<dt>What it may fetch</dt>
					<dd>{WEB_SCOPE_LABELS[webScopeOf(bot).webScope].label}</dd>
					<dt>Follow-up fetches</dt>
					<dd>{WEB_FOLLOW_UP_LABELS[webScopeOf(bot).webFollowUps]}</dd>
					<dt>Approved sites</dt>
					<dd>
						{webScopeOf(bot).webHosts.length
							? webScopeOf(bot).webHosts.join(", ")
							: "None"}
					</dd>
				</>
			)}
			<dt>Agent-to-agent replies</dt>
			<dd>{bot.agentHops}</dd>
			{LIMIT_FIELDS.map((field) => (
				<Fragment key={field.key}>
					<dt>{field.label}</dt>
					<dd>
						{count(bot.limits[field.key] ?? DEFAULT_BOT_LIMITS[field.key])}
					</dd>
				</Fragment>
			))}
			<dt>Instructions</dt>
			<dd className="bot-instructions">
				{bot.instructions || "No instructions."}
			</dd>
		</dl>
	);
}

const REQUEST_STATUS: Record<BotWebRequest["status"], string> = {
	pending: "Waiting",
	approved: "Approved",
	denied: "Denied",
};

/**
 * Sites the agent tried to fetch outside its web scope. Workspace admins
 * approve one, which adds its site to the agent's approved sites, or deny it.
 */
function WebRequests({
	botId,
	admin,
	version,
	onDecided,
	onError,
}: {
	botId: string;
	admin: boolean;
	/** Changes when the agent is read again, so the requests are too. */
	version: number;
	onDecided(): void;
	onError(message: string): void;
}) {
	const [requests, setRequests] = useState<BotWebRequest[] | null>(null);
	const [deciding, setDeciding] = useState<string | null>(null);
	const sequence = useRef(0);
	const load = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const list = await fetchBotWebRequests(botId);
			if (request === sequence.current) setRequests(list.requests);
		} catch (cause) {
			if (request === sequence.current)
				onError(
					errorText(cause, "Could not load the sites waiting for approval."),
				);
		}
	}, [botId, onError]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: version asks for a fresh read
	useEffect(() => {
		void load();
		return () => {
			sequence.current++;
		};
	}, [load, version]);
	const decide = async (item: BotWebRequest, approve: boolean) => {
		setDeciding(item.id);
		try {
			await decideBotWebRequest(botId, item.id, approve);
			await load();
			onDecided();
		} catch (cause) {
			onError(
				errorText(
					cause,
					approve ? "Could not approve the site." : "Could not deny the site.",
				),
			);
		} finally {
			setDeciding(null);
		}
	};
	const pending = (requests ?? [])
		.filter((item) => item.status === "pending")
		.sort((a, b) => b.requestedAt.localeCompare(a.requestedAt));
	const decided = (requests ?? [])
		.filter((item) => item.status !== "pending")
		.sort((a, b) =>
			(b.decidedAt ?? b.requestedAt).localeCompare(
				a.decidedAt ?? a.requestedAt,
			),
		)
		.slice(0, 5);
	return (
		<section
			className="bot-web-requests"
			aria-labelledby={`web-requests-${botId}`}
		>
			<h3 id={`web-requests-${botId}`}>Waiting for approval</h3>
			<p className="card-note">
				Sites this agent tried to fetch outside its web scope. The agent was
				told an admin was asked; once a site is approved, ask it again.
			</p>
			{requests === null ? (
				<p className="card-note" role="status">
					Loading…
				</p>
			) : pending.length ? (
				<div className="table-scroll">
					<table className="token-log-table bot-web-table">
						<thead>
							<tr>
								<th>Site</th>
								<th>Page</th>
								<th>Asked</th>
								<th>Last asked</th>
								{admin && <th>Decide</th>}
							</tr>
						</thead>
						<tbody>
							{pending.map((item) => (
								<tr key={item.id}>
									<td>
										<code>{item.host}</code>
									</td>
									<td className="bot-web-url">{item.url}</td>
									<td>
										{item.count === 1 ? "Once" : `${count(item.count)} times`}
									</td>
									<td>
										<time dateTime={item.requestedAt}>
											{date(item.requestedAt)}
										</time>
									</td>
									{admin && (
										<td className="bot-web-actions">
											<button
												className="button primary"
												type="button"
												disabled={deciding !== null}
												aria-label={`Approve ${item.host}`}
												onClick={() => void decide(item, true)}
											>
												{deciding === item.id ? "Saving…" : "Approve"}
											</button>
											<button
												className="button"
												type="button"
												disabled={deciding !== null}
												aria-label={`Deny ${item.host}`}
												onClick={() => void decide(item, false)}
											>
												Deny
											</button>
										</td>
									)}
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="card-note">No sites waiting for approval.</p>
			)}
			{decided.length > 0 && (
				<>
					<h4 className="bot-web-history-heading">Recently decided</h4>
					<ul
						className="proxy-rules bot-web-history"
						aria-label="Recently decided"
					>
						{decided.map((item) => (
							<li key={item.id}>
								<code>{item.host}</code>
								<span
									className={`bot-run-status ${item.status === "approved" ? "succeeded" : "failed"}`}
								>
									{REQUEST_STATUS[item.status]}
								</span>
								<span className="card-note">
									{item.decidedBy ? `by ${item.decidedBy}` : ""}
									{item.decidedAt ? ` · ${date(item.decidedAt)}` : ""}
								</span>
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

function RunsTable({
	runs,
	channels,
}: {
	runs: BotRun[];
	channels: ReadonlyMap<string, string>;
}) {
	if (!runs.length)
		return (
			<p className="card-note">
				No runs yet. Each mention of this agent in a channel becomes one.
			</p>
		);
	return (
		<div className="table-scroll">
			<table className="token-log-table bot-runs">
				<thead>
					<tr>
						<th>When</th>
						<th>Status</th>
						<th>Channel</th>
						<th>Model</th>
						<th>Tokens</th>
						<th>Details</th>
					</tr>
				</thead>
				<tbody>
					{runs.map((run) => {
						const channel = channels.get(run.channelId);
						return (
							<tr key={run.id}>
								<td>
									<time dateTime={run.createdAt}>{date(run.createdAt)}</time>
								</td>
								<td>
									<span className={`bot-run-status ${run.status}`}>
										{RUN_STATUS[run.status]}
									</span>
								</td>
								<td>{channel ? `#${channel}` : "—"}</td>
								<td>{run.model ?? "—"}</td>
								<td>{run.usage ? count(run.usage.totalTokens) : "—"}</td>
								<td>
									{[
										run.detail,
										run.depth > 0 ? "Asked by another agent." : "",
										run.attempts > 1 ? `Attempt ${run.attempts}.` : "",
									]
										.filter(Boolean)
										.join(" ")}
								</td>
							</tr>
						);
					})}
				</tbody>
			</table>
		</div>
	);
}

const usage = (bot: BotSummary) =>
	`${count(bot.repliesLastHour)} / ${count(bot.limits.repliesPerHour)} replies this hour · ${count(bot.tokensToday)} / ${count(bot.limits.tokensPerDay)} tokens today`;

/**
 * One agent the gateway runs: its settings, what it has answered, and
 * deleting it. Members who are not workspace admins see it read-only.
 */
export function InstructionsAgent({
	id,
	admin,
	choices,
	channels,
	created,
	onSaved,
	onDeleted,
	onError,
}: {
	id: string;
	/** Whether this person may change the agent. */
	admin: boolean;
	choices: ModelChoice[] | null;
	/** Channel names by id, to name the channel a run was in. */
	channels: ReadonlyMap<string, string>;
	/** The agent was made in this visit, so it gets the "what next" line. */
	created: boolean;
	onSaved(name: string): void;
	onDeleted(name: string): void;
	onError(message: string): void;
}) {
	const [bot, setBot] = useState<BotDetails | null>(null);
	const [missing, setMissing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [failed, setFailed] = useState(false);
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	/** Counts reads of the agent, so its web requests are read again with it. */
	const [reads, setReads] = useState(0);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const found = await fetchBot(id).catch((cause) => {
				if (cause instanceof ApiError && cause.status === 404) return null;
				throw cause;
			});
			if (request !== sequence.current) return;
			setBot(found);
			setMissing(!found);
			setFailed(false);
			setReads((value) => value + 1);
		} catch (cause) {
			if (request !== sequence.current) return;
			setFailed(true);
			onError(errorText(cause, "Could not load the agent."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [id, onError]);
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
	if (!bot)
		return (
			<section className="card agents-card agents-intro" aria-label="Agent">
				{missing ? (
					<>
						<h2>Agent not found</h2>
						<p className="card-note">
							It may have been deleted. Pick an agent from the list.
						</p>
					</>
				) : (
					<p className="card-note" role="status">
						{failed ? "This agent could not be loaded." : "Loading…"}
					</p>
				)}
			</section>
		);
	return (
		<section className="card agents-card" aria-label={bot.name}>
			<div className="bot-header">
				<h2>
					{bot.name}
					<span className="bot-chip">Instructions</span>
					{!bot.enabled && <span className="bot-chip paused">Paused</span>}
				</h2>
				<p className="card-note">
					Created {date(bot.createdAt)} by {bot.createdBy} · {usage(bot)}
				</p>
			</div>
			{created && (
				<p className="analytics-notice">
					Next: add it to a channel from the channel's Details, then mention it
					there. <a href={channelsHash(null)}>Open Channels</a>
				</p>
			)}
			{admin ? (
				<InstructionsForm
					key={`${bot.id}:${bot.revision}`}
					bot={bot}
					choices={choices}
					onSaved={(next) => {
						// A response to an earlier read must not put the old version back.
						sequence.current++;
						setBot(next);
						onSaved(next.name);
					}}
				/>
			) : (
				<BotFacts bot={bot} />
			)}
			{bot.web && (
				<WebRequests
					botId={bot.id}
					admin={admin}
					version={reads}
					onDecided={() => void refresh()}
					onError={onError}
				/>
			)}
			<div className="section-heading bot-runs-heading">
				<div>
					<h3>Recent runs</h3>
					<p className="card-note">
						The latest 50 mentions and what came of each, newest first.
					</p>
				</div>
				<button
					className="button"
					type="button"
					disabled={loading}
					onClick={() => void refresh()}
				>
					{loading ? "Loading…" : "Refresh"}
				</button>
			</div>
			<RunsTable runs={bot.runs} channels={channels} />
			{admin && (
				<div className="bot-delete">
					{confirming ? (
						<div className="synapse-inline-form">
							<p>
								Delete <strong>{bot.name}</strong>? It stays listed in channels
								it was added to until removed there, and answers nothing.
							</p>
							<div className="form-actions">
								<button
									className="button"
									type="button"
									disabled={deleting}
									onClick={() => setConfirming(false)}
								>
									Cancel
								</button>
								<button
									className="button danger"
									type="button"
									disabled={deleting}
									onClick={async () => {
										setDeleting(true);
										try {
											await deleteBot(bot.id);
											onDeleted(bot.name);
										} catch (cause) {
											onError(errorText(cause, "Could not delete the agent."));
											setDeleting(false);
										}
									}}
								>
									{deleting ? "Deleting…" : "Delete agent"}
								</button>
							</div>
						</div>
					) : (
						<button
							className="button danger"
							type="button"
							onClick={() => setConfirming(true)}
						>
							Delete
						</button>
					)}
				</div>
			)}
		</section>
	);
}
