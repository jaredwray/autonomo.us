import {
	BOT_LIMITS,
	type BotDetails,
	type BotLimits,
	type BotList,
	type BotRun,
	type BotSummary,
	type ChannelSummary,
	type CreateBotRequest,
	DEFAULT_BOT_LIMITS,
	type WorkspaceAccess,
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
	deleteBot,
	fetchBot,
	fetchBots,
	fetchModels,
	fetchRouting,
	updateBot,
} from "./api.js";
import { botsHash, parseBotsRoute } from "./bots-route.js";
import { channelsHash } from "./channels-route.js";
import { Icon } from "./Icons.js";

const date = (value: string) => new Date(value).toLocaleString();
const count = (value: number) => value.toLocaleString();
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

type ModelChoice = { value: string; label: string; disabled?: boolean };
/** What a bot can answer with: the workspace's chat models, `auto`, and its pools. */
async function loadModelChoices(): Promise<ModelChoice[]> {
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
];

const RUN_STATUS: Record<BotRun["status"], string> = {
	pending: "Queued",
	running: "Replying",
	succeeded: "Succeeded",
	failed: "Failed",
	skipped: "Skipped",
};

function PausedChip() {
	return <span className="bot-chip paused">Paused</span>;
}

/** Creates a bot, or edits one. Remounted when the bot's revision changes. */
function BotForm({
	bot,
	choices,
	onSaved,
	onCancel,
}: {
	/** The bot to edit; absent to create one. */
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
	const [agentHops, setAgentHops] = useState(bot?.agentHops ?? 0);
	const [limits, setLimits] = useState<Record<keyof BotLimits, string>>(() => {
		const from = bot?.limits ?? DEFAULT_BOT_LIMITS;
		return {
			repliesPerHour: String(from.repliesPerHour),
			tokensPerDay: String(from.tokensPerDay),
			maxOutputTokens: String(from.maxOutputTokens),
			contextMessages: String(from.contextMessages),
		};
	});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	// The first model is the default for a new bot once the list arrives.
	useEffect(() => {
		if (bot || model || !choices) return;
		const first = choices.find((choice) => !choice.disabled);
		if (first) setModel(first.value);
	}, [bot, model, choices]);
	// A bot keeps a model that has since left the workspace until it is changed.
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
		agentHops,
		limits: {
			repliesPerHour: Number(limits.repliesPerHour),
			tokensPerDay: Number(limits.tokensPerDay),
			maxOutputTokens: Number(limits.maxOutputTokens),
			contextMessages: Number(limits.contextMessages),
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
				agentHops: bot.agentHops,
				limits: {
					repliesPerHour: bot.limits.repliesPerHour,
					tokensPerDay: bot.limits.tokensPerDay,
					maxOutputTokens: bot.limits.maxOutputTokens,
					contextMessages: bot.limits.contextMessages,
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
					// range, or a bot that changed since it was read.
					setError(errorText(cause, "Could not save the bot."));
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
						placeholder="What this bot is for and how it should answer."
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
						Lets a reply search and write this bot's own Synapse space, propose
						changes to the shared space, and read its other channels.
					</span>
				</div>
				<div className="form-field bot-hops">
					<label htmlFor={`${id}-hops`}>Bot-to-bot replies</label>
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
						0 answers people only. Higher values let a chain of bots answer each
						other that many steps.
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
									min={1}
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
						{busy ? "Saving…" : bot ? "Save changes" : "Create bot"}
					</button>
				</div>
			</fieldset>
		</form>
	);
}

/** A bot's settings for someone who cannot change them. */
function BotFacts({ bot }: { bot: BotDetails }) {
	return (
		<dl className="bot-facts">
			<dt>Model</dt>
			<dd>{bot.model}</dd>
			<dt>Status</dt>
			<dd>{bot.enabled ? "Active" : "Paused"}</dd>
			<dt>Tools</dt>
			<dd>{bot.tools ? "On" : "Off"}</dd>
			<dt>Bot-to-bot replies</dt>
			<dd>{bot.agentHops}</dd>
			{LIMIT_FIELDS.map((field) => (
				<Fragment key={field.key}>
					<dt>{field.label}</dt>
					<dd>{count(bot.limits[field.key])}</dd>
				</Fragment>
			))}
			<dt>Instructions</dt>
			<dd className="bot-instructions">
				{bot.instructions || "No instructions."}
			</dd>
		</dl>
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
				No runs yet. Each mention of this bot in a channel becomes one.
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
										run.depth > 0 ? "Asked by another bot." : "",
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

export function BotsView({
	workspace,
	channels,
}: {
	workspace: WorkspaceAccess;
	/** The workspace's open channels, to name the channel a run was in. */
	channels: ChannelSummary[] | null;
}) {
	// A bot spends the workspace's provider keys, so its admins manage it.
	const admin = workspace.role === "admin";
	const [route, setRoute] = useState(() =>
		parseBotsRoute(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setRoute(parseBotsRoute(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const navigate = useCallback((id: string | null) => {
		const hash = botsHash(id);
		if (window.location.hash !== hash) window.history.pushState(null, "", hash);
		setRoute({ id });
	}, []);
	const { id } = route;
	const [list, setList] = useState<BotList | null>(null);
	const [details, setDetails] = useState<BotDetails | null>(null);
	const [missing, setMissing] = useState(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [creating, setCreating] = useState(false);
	/** The bot made in this visit, which gets the "what next" line. */
	const [created, setCreated] = useState<string | null>(null);
	const [confirming, setConfirming] = useState(false);
	const [deleting, setDeleting] = useState(false);
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const [bots, bot] = await Promise.all([
				fetchBots(),
				id
					? fetchBot(id).catch((cause) => {
							if (cause instanceof ApiError && cause.status === 404)
								return null;
							throw cause;
						})
					: null,
			]);
			if (request !== sequence.current) return;
			setList(bots);
			setDetails(bot);
			setMissing(Boolean(id && !bot));
			setError("");
		} catch (cause) {
			if (request === sequence.current)
				setError(errorText(cause, "Could not load the bots."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [id]);
	useEffect(() => {
		setConfirming(false);
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

	const saved = (bot: BotDetails, message: string) => {
		// A response to an earlier read must not put the old version back.
		sequence.current++;
		setDetails(bot);
		setMissing(false);
		setNotice(message);
		setList(
			(current) =>
				current && {
					...current,
					bots: [
						...current.bots.filter((item) => item.id !== bot.id),
						bot,
					].sort((a, b) => a.name.localeCompare(b.name)),
				},
		);
	};
	const channelNames = new Map(
		channels?.map((channel) => [channel.id, channel.name]),
	);
	const bot = details?.id === id ? details : null;
	return (
		<div className="dashboard bots-view">
			<header className="dashboard-header">
				<div>
					<h1>Bots</h1>
					<p className="page-description">
						A bot answers in channels when someone mentions it. The gateway
						calls a model from this workspace and posts the reply.
					</p>
					{!admin && (
						<p className="page-description">
							A workspace admin manages bots. You can see them and what they
							have answered.
						</p>
					)}
				</div>
				{admin && (
					<div className="header-actions">
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
							New bot
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
				<p className="success-notice bots-notice" role="status">
					{notice}
				</p>
			)}
			{list?.persistence === "memory" && (
				<p className="card-note">
					Bots are temporary until MongoDB is connected. They are lost when the
					API restarts.
				</p>
			)}
			<div className="bots-layout">
				<aside className="card bots-list" aria-label="Bot list">
					{list?.bots.length ? (
						<ul>
							{list.bots.map((item) => (
								<li key={item.id}>
									<a
										href={botsHash(item.id)}
										aria-current={
											item.id === id && !creating ? "page" : undefined
										}
										onClick={(event) => {
											event.preventDefault();
											setCreating(false);
											setNotice("");
											navigate(item.id);
										}}
									>
										<strong>
											{item.name}
											{!item.enabled && <PausedChip />}
										</strong>
										<span className="bot-meta">{item.model}</span>
										<span className="bot-meta">{usage(item)}</span>
									</a>
								</li>
							))}
						</ul>
					) : (
						<p className="card-note" role={list ? undefined : "status"}>
							{list
								? admin
									? "No bots yet. Create one to answer in your channels."
									: "No bots yet. A workspace admin can create one."
								: error
									? "Bots could not be loaded."
									: "Loading bots…"}
						</p>
					)}
				</aside>
				{creating ? (
					<section className="card bots-main" aria-labelledby="bot-new-heading">
						<div className="section-heading">
							<h2 id="bot-new-heading">New bot</h2>
							<button
								type="button"
								className="icon-button"
								aria-label="Close new bot form"
								onClick={() => setCreating(false)}
							>
								<Icon name="close" />
							</button>
						</div>
						<BotForm
							choices={choices}
							onCancel={() => setCreating(false)}
							onSaved={(next) => {
								setCreating(false);
								setCreated(next.id);
								saved(next, `Created ${next.name}.`);
								navigate(next.id);
							}}
						/>
					</section>
				) : bot ? (
					<section className="card bots-main" aria-label={bot.name}>
						<div className="bot-header">
							<h2>
								{bot.name}
								{!bot.enabled && <PausedChip />}
							</h2>
							<p className="card-note">
								Created {date(bot.createdAt)} by {bot.createdBy} · {usage(bot)}
							</p>
						</div>
						{created === bot.id && (
							<p className="analytics-notice">
								Next: add it to a channel from the channel's Details, then
								mention it there. <a href={channelsHash(null)}>Open Channels</a>
							</p>
						)}
						{admin ? (
							<BotForm
								key={`${bot.id}:${bot.revision}`}
								bot={bot}
								choices={choices}
								onSaved={(next) => saved(next, `Saved ${next.name}.`)}
							/>
						) : (
							<BotFacts bot={bot} />
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
						<RunsTable runs={bot.runs} channels={channelNames} />
						{admin && (
							<div className="bot-delete">
								{confirming ? (
									<div className="synapse-inline-form">
										<p>
											Delete <strong>{bot.name}</strong>? It stays listed in
											channels it was added to until removed there, and answers
											nothing.
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
													setError("");
													try {
														await deleteBot(bot.id);
														setNotice(`Deleted ${bot.name}.`);
														setConfirming(false);
														navigate(null);
													} catch (cause) {
														setError(
															errorText(cause, "Could not delete the bot."),
														);
													} finally {
														setDeleting(false);
													}
												}}
											>
												{deleting ? "Deleting…" : "Delete bot"}
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
				) : (
					<section className="card bots-main bots-intro" aria-label="Bot">
						{id && missing ? (
							<>
								<h2>Bot not found</h2>
								<p className="card-note">
									It may have been deleted. Pick a bot from the list.
								</p>
							</>
						) : id ? (
							<p className="card-note" role="status">
								{error ? "This bot could not be loaded." : "Loading…"}
							</p>
						) : (
							<>
								<h2>{list?.bots.length ? "Pick a bot" : "How bots work"}</h2>
								<p className="card-note">
									Give a bot a name, instructions, and a model, then add it to a
									channel from the channel's Details. When someone mentions it
									there, the gateway sends the recent conversation to the model
									and posts the answer under the bot's name. Its limits cap what
									it can spend, and every mention shows here as a run.
								</p>
							</>
						)}
					</section>
				)}
			</div>
		</div>
	);
}
