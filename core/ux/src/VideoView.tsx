import {
	type AgentSummary,
	agentNamesText,
	type BudgetAppliesTo,
	type CreateVideoConnectionRequest,
	DEFAULT_VIDEO_MODEL,
	type UpdateVideoConnectionRequest,
	type UpdateVideoLimitRequest,
	VIDEO_KIND_LABELS,
	VIDEO_KINDS,
	VIDEO_LIMITS,
	VIDEO_MODELS,
	VIDEO_NAME_PATTERN,
	type VideoConnection,
	type VideoKind,
	type VideoLimit,
	type VideoLimitCovers,
	type VideoLimitInput,
	type VideoModelList,
	type VideoPolicy,
	type VideoSettings,
	videoLimitProblem,
	videoModel,
	videoModelLabel,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { AppliesToFields } from "./AppliesToFields.js";
import {
	ApiError,
	createVideoConnection,
	createVideoLimit,
	deleteVideoConnection,
	deleteVideoLimit,
	fetchAgents,
	fetchVideoModels,
	fetchVideoSettings,
	updateVideoConnection,
	updateVideoLimit,
	updateVideoPolicy,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { usd } from "./ProxiesView.js";
import { VideoJobsPanel } from "./VideoJobs.js";

export { formChoices, videoRequestProblem } from "./VideoJobs.js";

const SUGGESTED_NAMES: Record<VideoKind, string> = {
	google: "google-video",
	runway: "runway",
	luma: "luma",
};
const PROVIDER_HELP: Record<VideoKind, string> = {
	google:
		"Gemini Omni Flash through the Gemini API: text to video with sound. Use a key of its own, not the one for chat models.",
	runway:
		"Runway's developer API: Seedance 2.5 and Gen-4.5, from text or a start image. Credits cost $0.01.",
	luma: "Luma Ray through the Luma Agents API, from text or a start image. Priced in credits at your plan's rate.",
};
const TURNED_OFF =
	"Video generation is turned off on this gateway. Agents cannot make videos until its operator turns it back on.";

const count = (value: number) => value.toLocaleString();
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;
const modelLabel = (kind: VideoKind, id: string) =>
	videoModel(kind, id)?.label ?? id;

type Names = { agent(id: string): string | undefined };

const seconds = (value: number) =>
	`${value} ${value === 1 ? "second" : "seconds"}`;

/** Who a limit applies to, in words. */
function limitWho(appliesTo: BudgetAppliesTo, names: Names): string {
	if (appliesTo.kind === "everyone") return "Everyone in this workspace";
	return agentNamesText(
		appliesTo.agentIds.map((id) => names.agent(id) ?? "a removed agent"),
	);
}

/** What a limit covers, in words. */
function limitCovers(covers: VideoLimitCovers): string {
	return covers.kind === "video"
		? "all video models"
		: videoModelLabel(covers.model);
}

/** What a video limit does, as a sentence a person can check before saving. */
export function videoLimitSentence(
	input: VideoLimitInput,
	names: Names,
): string {
	const listed =
		input.appliesTo.kind === "agents"
			? input.appliesTo.agentIds.map(
					(id) => names.agent(id) ?? "a removed agent",
				)
			: [];
	const agents = agentNamesText(listed);
	const what =
		input.covers.kind === "video"
			? "any video model"
			: videoModelLabel(input.covers.model);
	const perDay = input.videosPerDay ?? null;
	const longest = input.maxDurationSeconds ?? null;
	if (perDay === 0)
		return `${listed.length ? `${agents} cannot` : "No one in this workspace can"} start videos on ${what}: a limit of 0 a day refuses every one.`;
	if (perDay !== null) {
		const who = !listed.length
			? "Each person, API token, and agent can"
			: listed.length === 1
				? `${agents} can`
				: `${agents} can each`;
		const videos = `${count(perDay)} ${perDay === 1 ? "video" : "videos"}`;
		const length =
			longest !== null ? `, each up to ${seconds(longest)} long` : "";
		return `${who} start up to ${videos} a day (UTC) on ${what}${length}.`;
	}
	const whose = listed.length
		? `${agents} ${listed.length === 1 ? "starts" : "start"}`
		: "anyone in this workspace starts";
	return `Videos ${whose} on ${what} can be up to ${seconds(longest ?? 0)} long.`;
}

/** The order videos try connections in: the policy's, then the rest as added. */
function displayOrder(policy: VideoPolicy, connections: VideoConnection[]) {
	const names = connections.map((item) => item.name);
	return [
		...policy.order.filter((name) => names.includes(name)),
		...names.filter((name) => !policy.order.includes(name)),
	];
}

/** Adds a video provider, or edits one saved in the dashboard. */
function ConnectionForm({
	existing,
	taken,
	persistence,
	onSaved,
	onClose,
}: {
	existing?: VideoConnection;
	taken: string[];
	persistence: VideoSettings["persistence"];
	onSaved(connection: VideoConnection): void;
	onClose(): void;
}) {
	const id = useId();
	const [kind, setKind] = useState<VideoKind>(existing?.kind ?? "runway");
	const [name, setName] = useState(existing?.name ?? SUGGESTED_NAMES.runway);
	const [nameTouched, setNameTouched] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [defaultModel, setDefaultModel] = useState(
		existing?.defaultModel ?? "",
	);
	const [creditPrice, setCreditPrice] = useState(
		existing?.creditPriceUsd !== undefined
			? String(existing.creditPriceUsd)
			: "",
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const kindInput = useRef<HTMLButtonElement>(null);
	const keyInput = useRef<HTMLInputElement>(null);
	useEffect(() => {
		(kindInput.current ?? keyInput.current)?.focus();
	}, []);
	const trimmedName = name.trim();
	const nameTaken = !existing && taken.includes(trimmedName);
	const problem = (() => {
		if (!existing && !VIDEO_NAME_PATTERN.test(trimmedName))
			return "Use a lowercase letter first, then up to 63 lowercase letters, numbers, dashes or underscores.";
		if (nameTaken) return "This name is already in use.";
		if (!existing && !apiKey.trim()) return "Enter the API key.";
		if (kind === "luma" && creditPrice.trim()) {
			const value = Number(creditPrice);
			if (
				!Number.isFinite(value) ||
				value < 0 ||
				value > VIDEO_LIMITS.maxCreditPriceUsd
			)
				return `A credit price is from $0 to $${VIDEO_LIMITS.maxCreditPriceUsd}.`;
		}
		return null;
	})();
	const providerDefault = modelLabel(kind, DEFAULT_VIDEO_MODEL[kind]);
	return (
		<section className="card add-model-card" aria-labelledby={`${id}-title`}>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>
						{existing ? `Edit ${existing.name}` : "Add a video provider"}
					</h2>
					<p className="card-note">{PROVIDER_HELP[kind]}</p>
				</div>
				<button
					className="icon-button"
					type="button"
					aria-label={
						existing ? "Close edit video provider" : "Close add video provider"
					}
					onClick={onClose}
					disabled={saving}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (saving || problem) return;
					setSaving(true);
					setError("");
					const price =
						kind === "luma" && creditPrice.trim()
							? { creditPriceUsd: Number(creditPrice) }
							: {};
					try {
						if (existing) {
							const input: UpdateVideoConnectionRequest = {
								...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
								// An empty default model clears it.
								defaultModel,
								...price,
							};
							onSaved(await updateVideoConnection(existing.name, input));
						} else {
							const input: CreateVideoConnectionRequest = {
								name: trimmedName,
								kind,
								apiKey: apiKey.trim(),
								...(defaultModel ? { defaultModel } : {}),
								...price,
							};
							onSaved(await createVideoConnection(input));
						}
						setApiKey("");
					} catch (cause) {
						setError(errorText(cause, "Could not save the video provider."));
					} finally {
						setSaving(false);
					}
				}}
			>
				<fieldset disabled={saving}>
					<div className="model-form-grid">
						{existing ? (
							<p className="field-hint">
								{VIDEO_KIND_LABELS[existing.kind]} · {existing.name}
							</p>
						) : (
							<>
								<div className="form-field">
									<label htmlFor={`${id}-kind`}>Provider</label>
									<Dropdown
										id={`${id}-kind`}
										ref={kindInput}
										value={kind}
										onValueChange={(value) => {
											const next = value as VideoKind;
											if (!nameTouched) setName(SUGGESTED_NAMES[next]);
											setKind(next);
											setDefaultModel("");
											setError("");
										}}
									>
										{VIDEO_KINDS.map((item) => (
											<option key={item} value={item}>
												{VIDEO_KIND_LABELS[item]}
											</option>
										))}
									</Dropdown>
								</div>
								<div className="form-field">
									<label htmlFor={`${id}-name`}>Name</label>
									<input
										id={`${id}-name`}
										value={name}
										required
										maxLength={64}
										onChange={(event) => {
											setName(event.target.value);
											setNameTouched(true);
											setError("");
										}}
										aria-describedby={`${id}-name-help`}
									/>
									<span className="field-hint" id={`${id}-name-help`}>
										{nameTaken
											? "This name is already in use."
											: "Lowercase letters, numbers, dashes or underscores. Agents can name it to choose this provider."}
									</span>
								</div>
							</>
						)}
						<div className="form-field key-field">
							<label htmlFor={`${id}-key`}>
								API key{" "}
								{existing && <span className="field-hint">(optional)</span>}
							</label>
							<input
								id={`${id}-key`}
								ref={keyInput}
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								value={apiKey}
								required={!existing}
								maxLength={VIDEO_LIMITS.keyLength}
								placeholder={
									existing
										? "Leave blank to keep the saved key"
										: `Enter your ${VIDEO_KIND_LABELS[kind]} API key`
								}
								onChange={(event) => {
									setApiKey(event.target.value);
									setError("");
								}}
								aria-describedby={`${id}-key-help`}
							/>
							<span className="field-hint" id={`${id}-key-help`}>
								Keys stay on the server and are never shown again.
							</span>
						</div>
						<div className="form-field">
							<label htmlFor={`${id}-model`}>Default model</label>
							<Dropdown
								id={`${id}-model`}
								value={defaultModel}
								onValueChange={(value) => setDefaultModel(value)}
							>
								<option value="">Provider default ({providerDefault})</option>
								{VIDEO_MODELS[kind].map((item) => (
									<option key={item.id} value={item.id}>
										{item.label}
									</option>
								))}
							</Dropdown>
							<span className="field-hint">
								Used when a request names no model.
							</span>
						</div>
						{kind === "luma" && (
							<div className="form-field">
								<label htmlFor={`${id}-credit`}>
									Credit price (USD){" "}
									<span className="field-hint">(optional)</span>
								</label>
								<input
									id={`${id}-credit`}
									type="number"
									min={0}
									max={VIDEO_LIMITS.maxCreditPriceUsd}
									step={0.001}
									placeholder="0.01"
									value={creditPrice}
									onChange={(event) => setCreditPrice(event.target.value)}
								/>
								<span className="field-hint">
									What one credit costs on your plan. Used to estimate spend
									against the monthly budget.
								</span>
							</div>
						)}
					</div>
					{persistence === "memory" && (
						<p className="field-hint">
							Changes in this session last until the API restarts. Connect
							MongoDB to keep them.
						</p>
					)}
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					{problem && <p className="field-hint">{problem}</p>}
					<div className="form-actions">
						<button className="button" type="button" onClick={onClose}>
							Cancel
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={Boolean(problem)}
						>
							{saving ? "Saving…" : existing ? "Save changes" : "Add provider"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/** The order providers are tried in. Each move is saved at once. */
function ProviderOrder({
	policy,
	connections,
	canEdit,
	onSaved,
	onStale,
}: {
	policy: VideoPolicy;
	connections: VideoConnection[];
	canEdit: boolean;
	onSaved(policy: VideoPolicy): void;
	/** The order changed elsewhere: read it again. */
	onStale(): void;
}) {
	const id = useId();
	// Shown while a move is saving, so the list answers at once.
	const [moving, setMoving] = useState<string[] | null>(null);
	const [status, setStatus] = useState("");
	const [error, setError] = useState("");
	const order = moving ?? displayOrder(policy, connections);
	// A moved row's buttons move with it: focus stays on the one pressed, or
	// its partner when the row reaches an end.
	const buttons = useRef(new Map<string, HTMLButtonElement>());
	const refocus = useRef<{ name: string; by: number } | null>(null);
	useEffect(() => {
		const want = refocus.current;
		if (!want) return;
		refocus.current = null;
		const pressed = buttons.current.get(`${want.name}:${want.by}`);
		const partner = buttons.current.get(`${want.name}:${-want.by}`);
		(pressed && !pressed.disabled ? pressed : partner)?.focus();
	});
	const move = async (index: number, by: number) => {
		if (moving) return;
		const next = [...order];
		const [name] = next.splice(index, 1);
		next.splice(index + by, 0, name);
		refocus.current = { name, by };
		setMoving(next);
		setStatus("Saving…");
		setError("");
		try {
			onSaved(
				await updateVideoPolicy({ order: next, revision: policy.revision }),
			);
			setStatus(`Saved. Videos try ${next[0]} first.`);
		} catch (cause) {
			setStatus("");
			if (cause instanceof ApiError && cause.status === 409) {
				setError(
					"The order was changed elsewhere, so this is the latest. Move it again if you need to.",
				);
				onStale();
			} else setError(errorText(cause, "Could not save the order."));
		} finally {
			setMoving(null);
		}
	};
	return (
		<section className="card" aria-labelledby={`${id}-title`}>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>Provider order</h2>
					<p className="card-note">
						A video starts on the first provider in this order that can make it.
						If that provider fails without charging, the next one is tried.
					</p>
				</div>
			</div>
			{/* role="list": Safari drops list semantics from a list without bullets. */}
			{/* biome-ignore lint/a11y/noRedundantRoles: see above */}
			<ol className="video-order" role="list" aria-label="Provider order">
				{order.map((name, index) => {
					const item = connections.find((other) => other.name === name);
					const hint = !item?.keyConfigured
						? "key missing"
						: !item.enabled
							? "switched off"
							: VIDEO_KIND_LABELS[item.kind];
					return (
						<li key={name}>
							<span className="video-order-name">
								<code>{name}</code> <span className="field-hint">{hint}</span>
							</span>
							{canEdit && (
								<div className="routing-row-actions">
									{[-1, 1].map((by) => (
										<button
											key={by}
											ref={(element) => {
												if (element)
													buttons.current.set(`${name}:${by}`, element);
												else buttons.current.delete(`${name}:${by}`);
											}}
											className="button"
											type="button"
											aria-label={`Move ${name} ${by < 0 ? "up" : "down"}`}
											disabled={
												by < 0 ? index === 0 : index === order.length - 1
											}
											aria-disabled={moving ? true : undefined}
											onClick={() => void move(index, by)}
										>
											{by < 0 ? "↑" : "↓"}
										</button>
									))}
								</div>
							)}
						</li>
					);
				})}
			</ol>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			<p className="field-hint video-order-status" role="status">
				{status}
			</p>
		</section>
	);
}

/** Adds a video limit, or changes one. */
function VideoLimitForm({
	existing,
	agents,
	names,
	connected,
	onSaved,
	onClose,
}: {
	existing?: VideoLimit;
	agents: AgentSummary[];
	names: Names;
	/** Provider kinds this workspace has a connection for: their models come first. */
	connected: VideoKind[];
	onSaved(limit: VideoLimit, added: boolean): void;
	onClose(): void;
}) {
	const id = useId();
	const kinds = [
		...VIDEO_KINDS.filter((kind) => connected.includes(kind)),
		...VIDEO_KINDS.filter((kind) => !connected.includes(kind)),
	];
	const [who, setWho] = useState<"everyone" | "agents">(
		existing?.appliesTo.kind ?? "everyone",
	);
	const [agentIds, setAgentIds] = useState<string[]>(
		existing?.appliesTo.kind === "agents" ? existing.appliesTo.agentIds : [],
	);
	const [covers, setCovers] = useState<VideoLimitCovers["kind"]>(
		existing?.covers.kind ?? "video",
	);
	const [model, setModel] = useState(
		existing?.covers.kind === "video-model"
			? existing.covers.model
			: VIDEO_MODELS[kinds[0]][0].id,
	);
	const [perDay, setPerDay] = useState(
		existing?.videosPerDay != null ? String(existing.videosPerDay) : "",
	);
	const [longest, setLongest] = useState(
		existing?.maxDurationSeconds != null
			? String(existing.maxDurationSeconds)
			: "",
	);
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState("");
	const first = useRef<HTMLInputElement>(null);
	useEffect(() => {
		first.current?.focus();
	}, []);
	const optional = (text: string) => (text.trim() === "" ? null : Number(text));
	const input: VideoLimitInput = {
		appliesTo:
			who === "everyone" ? { kind: "everyone" } : { kind: "agents", agentIds },
		covers:
			covers === "video" ? { kind: "video" } : { kind: "video-model", model },
		videosPerDay: optional(perDay),
		maxDurationSeconds: optional(longest),
	};
	const problem = videoLimitProblem(input);
	// An edit sends only what changed, so a limit on a model the gateway has
	// since dropped can still have its numbers changed.
	const changes = (limit: VideoLimit): UpdateVideoLimitRequest => {
		const same = (a: unknown, b: unknown) =>
			JSON.stringify(a) === JSON.stringify(b);
		return {
			...(same(input.appliesTo, limit.appliesTo)
				? {}
				: { appliesTo: input.appliesTo }),
			...(same(input.covers, limit.covers) ? {} : { covers: input.covers }),
			...(input.videosPerDay === limit.videosPerDay
				? {}
				: { videosPerDay: input.videosPerDay }),
			...(input.maxDurationSeconds === limit.maxDurationSeconds
				? {}
				: { maxDurationSeconds: input.maxDurationSeconds }),
		};
	};

	return (
		<section
			className="card add-model-card"
			aria-labelledby={`${id}-title`}
			onKeyDown={(event) => {
				// Escape closes the form, unless it is closing a list inside it.
				if (
					event.key !== "Escape" ||
					saving ||
					event.defaultPrevented ||
					(event.target as HTMLElement).closest('[role="listbox"]')
				)
					return;
				event.preventDefault();
				onClose();
			}}
		>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>
						{existing ? "Edit video limit" : "Add a video limit"}
					</h2>
					<p className="card-note">
						Every limit that covers a video applies, so the strictest wins.
					</p>
				</div>
				<button
					className="icon-button"
					type="button"
					aria-label={
						existing ? "Close edit video limit" : "Close add video limit"
					}
					onClick={onClose}
					disabled={saving}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (saving || problem) return;
					setSaving(true);
					setError("");
					try {
						if (!existing) {
							onSaved(await createVideoLimit(input), true);
							return;
						}
						const patch = changes(existing);
						onSaved(
							Object.keys(patch).length
								? await updateVideoLimit(existing.id, patch)
								: existing,
							false,
						);
					} catch (cause) {
						setError(errorText(cause, "Could not save the limit."));
					} finally {
						setSaving(false);
					}
				}}
			>
				<fieldset className="budget-form" disabled={saving}>
					<AppliesToFields
						id={id}
						who={who}
						onWho={setWho}
						agentIds={agentIds}
						onAgentIds={setAgentIds}
						agents={agents}
						maxAgents={VIDEO_LIMITS.agentsPerLimit}
						everyoneHint="Each person, API token, and agent is counted on their own."
						agentsHint="Each agent you pick is counted on its own."
						firstRef={first}
					/>
					<div className="model-form-grid">
						<div className="form-field">
							<label htmlFor={`${id}-covers`}>Covers</label>
							<Dropdown
								id={`${id}-covers`}
								value={covers}
								onValueChange={(value) =>
									setCovers(value as VideoLimitCovers["kind"])
								}
							>
								<option value="video">All video models</option>
								<option value="video-model">One video model</option>
							</Dropdown>
						</div>
						{covers === "video-model" && (
							<div className="form-field">
								<label htmlFor={`${id}-model`}>Video model</label>
								<Dropdown
									id={`${id}-model`}
									value={model}
									onValueChange={setModel}
								>
									{kinds.flatMap((kind) =>
										VIDEO_MODELS[kind].map((item) => (
											<option key={item.id} value={item.id}>
												{`${item.label} (${VIDEO_KIND_LABELS[kind]}${connected.includes(kind) ? "" : ", not connected"})`}
											</option>
										)),
									)}
								</Dropdown>
							</div>
						)}
					</div>
					<div className="model-form-grid">
						<div className="form-field">
							<label htmlFor={`${id}-per-day`}>
								Videos a day <span className="field-hint">(optional)</span>
							</label>
							<input
								id={`${id}-per-day`}
								type="number"
								inputMode="numeric"
								min={0}
								max={VIDEO_LIMITS.maxCallerVideosPerDay}
								step={1}
								placeholder="10"
								value={perDay}
								onChange={(event) => setPerDay(event.target.value)}
								aria-describedby={`${id}-per-day-help`}
							/>
							<span className="field-hint" id={`${id}-per-day-help`}>
								Counted from 00:00 UTC. Leave blank for no daily limit.
							</span>
						</div>
						<div className="form-field">
							<label htmlFor={`${id}-longest`}>
								Longest video (seconds){" "}
								<span className="field-hint">(optional)</span>
							</label>
							<input
								id={`${id}-longest`}
								type="number"
								inputMode="numeric"
								min={VIDEO_LIMITS.minDurationSeconds}
								max={VIDEO_LIMITS.maxDurationSeconds}
								step={1}
								placeholder="10"
								value={longest}
								onChange={(event) => setLongest(event.target.value)}
								aria-describedby={`${id}-longest-help`}
							/>
							<span className="field-hint" id={`${id}-longest-help`}>
								From {VIDEO_LIMITS.minDurationSeconds} to{" "}
								{VIDEO_LIMITS.maxDurationSeconds}. Leave blank for no length
								limit.
							</span>
						</div>
					</div>
					<p className="budget-preview" id={`${id}-preview`}>
						{problem ?? videoLimitSentence(input, names)}
					</p>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					<div className="form-actions">
						<button
							className="button"
							type="button"
							onClick={onClose}
							disabled={saving}
						>
							Cancel
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={Boolean(problem)}
							aria-describedby={`${id}-preview`}
						>
							{saving ? "Saving…" : existing ? "Save changes" : "Add limit"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/**
 * The workspace's video limits: how many videos a day and how long, for
 * everyone or chosen agents, on every video model or one. Admins add,
 * change, switch off, and delete them; members see them.
 */
function VideoLimitsCard({
	limits,
	agents,
	connected,
	canEdit,
	onChange,
	onShowBudget,
}: {
	limits: VideoLimit[];
	agents: AgentSummary[];
	connected: VideoKind[];
	canEdit: boolean;
	/** Shows a change made here at once; a fresh read follows. */
	onChange(update: (limits: VideoLimit[]) => VideoLimit[]): void;
	onShowBudget(): void;
}) {
	const [panel, setPanel] = useState<
		{ kind: "add" } | { kind: "edit"; id: string } | null
	>(null);
	const [notice, setNotice] = useState("");
	const [rowError, setRowError] = useState("");
	const [confirming, setConfirming] = useState<string | null>(null);
	const [busy, setBusy] = useState<ReadonlySet<string>>(new Set());
	const working = (limitId: string, on: boolean) =>
		setBusy((current) => {
			const next = new Set(current);
			if (on) next.add(limitId);
			else next.delete(limitId);
			return next;
		});
	const names: Names = {
		agent: (agentId) => agents.find((agent) => agent.id === agentId)?.name,
	};
	// Closing a form returns focus to what opened it: Add limit, or the row's Edit.
	const addButton = useRef<HTMLButtonElement>(null);
	const heading = useRef<HTMLHeadingElement>(null);
	const editButtons = useRef(new Map<string, HTMLButtonElement>());
	const focusAfterClose = useRef<string | null>(null);
	useEffect(() => {
		if (panel || !focusAfterClose.current) return;
		const target = focusAfterClose.current;
		focusAfterClose.current = null;
		(editButtons.current.get(target) ?? addButton.current)?.focus();
	}, [panel]);
	const closePanel = () => {
		focusAfterClose.current = panel?.kind === "edit" ? panel.id : "add";
		setPanel(null);
	};
	// Delete and Cancel replace themselves: focus follows to what took their place.
	const confirmDelete = useRef<HTMLButtonElement>(null);
	const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
	const refocusDelete = useRef<string | null>(null);
	useEffect(() => {
		if (confirming) {
			confirmDelete.current?.focus();
			return;
		}
		const limitId = refocusDelete.current;
		refocusDelete.current = null;
		if (limitId) deleteButtons.current.get(limitId)?.focus();
	}, [confirming]);
	const editing =
		panel?.kind === "edit"
			? limits.find((limit) => limit.id === panel.id)
			: undefined;
	const form = (existing?: VideoLimit) => (
		<VideoLimitForm
			key={existing?.id ?? "add"}
			existing={existing}
			agents={agents}
			names={names}
			connected={connected}
			onClose={closePanel}
			onSaved={(saved, added) => {
				onChange((current) =>
					added
						? [...current, saved]
						: current.map((item) => (item.id === saved.id ? saved : item)),
				);
				setNotice(added ? "Limit added." : "Limit saved.");
				closePanel();
			}}
		/>
	);

	return (
		<>
			{panel?.kind === "add" && form()}
			{editing && form(editing)}
			<section
				className="card active-models"
				aria-labelledby="video-limits-heading"
			>
				<div className="section-heading">
					<div>
						<h2 id="video-limits-heading" ref={heading} tabIndex={-1}>
							Video limits
						</h2>
						<p className="card-note">
							How many videos each person, API token, or agent may start in a
							day, and how long a video may be. When several limits cover a
							video, the strictest applies.
						</p>
					</div>
					{canEdit && (
						<button
							ref={addButton}
							type="button"
							className="button"
							disabled={panel?.kind === "add"}
							onClick={() => {
								setPanel({ kind: "add" });
								setNotice("");
								setRowError("");
							}}
						>
							<Icon name="plus" /> Add limit
						</button>
					)}
				</div>
				{notice && (
					<p className="success-notice" role="status">
						{notice}
					</p>
				)}
				{rowError && (
					<div className="banner-error" role="alert">
						{rowError}
					</div>
				)}
				{limits.length === 0 ? (
					<div className="models-empty">
						<h3>No video limits</h3>
						<p>
							Videos are limited only by budgets and the longest each model can
							make.
						</p>
					</div>
				) : (
					<div className="table-scroll">
						<table className="models-table budget-table">
							<thead>
								<tr>
									<th>Applies to</th>
									<th>Covers</th>
									<th>Videos a day</th>
									<th>Longest video</th>
									<th>Status</th>
									{canEdit && (
										<th>
											<span className="visually-hidden">Actions</span>
										</th>
									)}
								</tr>
							</thead>
							<tbody>
								{limits.map((limit) => {
									const who = limitWho(limit.appliesTo, names);
									const label = `${who} on ${limitCovers(limit.covers)}`;
									return (
										<tr key={limit.id}>
											<td className="budget-who">
												<strong>{who}</strong>
											</td>
											<td data-label="Covers">
												{limit.covers.kind === "video" ? (
													"All video models"
												) : (
													<>
														{videoModelLabel(limit.covers.model)}
														<span className="field-hint">Video model</span>
													</>
												)}
											</td>
											<td data-label="Videos a day">
												{limit.videosPerDay === null ? (
													<span className="field-hint">No limit</span>
												) : limit.videosPerDay === 0 ? (
													<span className="budget-blocked">
														None: blocks every video it covers
													</span>
												) : (
													<>
														{count(limit.videosPerDay)}
														{limit.appliesTo.kind === "everyone" ? (
															<span className="field-hint">
																per person, token, or agent
															</span>
														) : limit.appliesTo.agentIds.length > 1 ? (
															<span className="field-hint">per agent</span>
														) : null}
													</>
												)}
											</td>
											<td data-label="Longest video">
												{limit.maxDurationSeconds === null ? (
													<span className="field-hint">No limit</span>
												) : (
													seconds(limit.maxDurationSeconds)
												)}
											</td>
											<td data-label="Status">
												{canEdit ? (
													<label className="failover-enable">
														<input
															type="checkbox"
															aria-label={`Use the limit for ${label}`}
															checked={limit.enabled}
															disabled={busy.has(limit.id)}
															onChange={async (event) => {
																setRowError("");
																working(limit.id, true);
																try {
																	const saved = await updateVideoLimit(
																		limit.id,
																		{
																			enabled: event.target.checked,
																		},
																	);
																	onChange((current) =>
																		current.map((item) =>
																			item.id === saved.id ? saved : item,
																		),
																	);
																} catch (cause) {
																	setRowError(
																		errorText(cause, "Could not change it."),
																	);
																} finally {
																	working(limit.id, false);
																}
															}}
														/>
														{limit.enabled ? "On" : "Off"}
													</label>
												) : (
													<span className="chip">
														<span
															className={`dot ${limit.enabled ? "dot-good" : "dot-muted"}`}
														/>
														{limit.enabled ? "On" : "Off"}
													</span>
												)}
											</td>
											{canEdit && (
												<td className="budget-actions">
													<div className="proxy-actions">
														<button
															ref={(element) => {
																if (element)
																	editButtons.current.set(limit.id, element);
																else editButtons.current.delete(limit.id);
															}}
															className="button"
															type="button"
															aria-label={`Edit the limit for ${label}`}
															onClick={() => {
																setPanel({ kind: "edit", id: limit.id });
																setNotice("");
																setRowError("");
															}}
														>
															Edit
														</button>
														{confirming === limit.id ? (
															<>
																<button
																	ref={confirmDelete}
																	className="button danger"
																	type="button"
																	aria-label={`Confirm delete the limit for ${label}`}
																	disabled={busy.has(limit.id)}
																	onClick={async () => {
																		setRowError("");
																		working(limit.id, true);
																		try {
																			await deleteVideoLimit(limit.id);
																			setConfirming(null);
																			if (
																				panel?.kind === "edit" &&
																				panel.id === limit.id
																			)
																				setPanel(null);
																			onChange((current) =>
																				current.filter(
																					(item) => item.id !== limit.id,
																				),
																			);
																			setNotice("Limit deleted.");
																			// Its row is gone: focus goes to Add limit,
																			// or the heading while the add form has it off.
																			const add = addButton.current;
																			(add && !add.disabled
																				? add
																				: heading.current
																			)?.focus();
																		} catch (cause) {
																			setRowError(
																				errorText(
																					cause,
																					"Could not delete it.",
																				),
																			);
																		} finally {
																			working(limit.id, false);
																		}
																	}}
																>
																	{busy.has(limit.id) ? "Deleting…" : "Delete"}
																</button>
																<button
																	className="button"
																	type="button"
																	onClick={() => {
																		refocusDelete.current = limit.id;
																		setConfirming(null);
																	}}
																>
																	Cancel
																</button>
															</>
														) : (
															<button
																ref={(element) => {
																	if (element)
																		deleteButtons.current.set(
																			limit.id,
																			element,
																		);
																	else deleteButtons.current.delete(limit.id);
																}}
																className="button"
																type="button"
																aria-label={`Delete the limit for ${label}`}
																onClick={() => setConfirming(limit.id)}
															>
																Delete
															</button>
														)}
													</div>
												</td>
											)}
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
				)}
				<p className="card-note budget-footnote">
					What videos may cost is set on the Budget tab.{" "}
					<button className="link-button" type="button" onClick={onShowBudget}>
						See video budgets
					</button>
				</p>
			</section>
		</>
	);
}

/**
 * The Models page's Video tab: providers, the order they are tried in, the
 * video limits, and, for admins, making videos and every video made.
 * Members see providers and limits; admins change them, make videos, and
 * see every job.
 */
export function VideoPanel({
	workspace,
	active = true,
	onShowBudget,
}: {
	workspace?: { isDefault: boolean; role?: "admin" | "member" };
	/** Whether the tab is showing: coming back to it reads spend afresh. */
	active?: boolean;
	onShowBudget(): void;
}) {
	const canEdit = workspace?.role !== "member";
	const [settings, setSettings] = useState<VideoSettings | null>(null);
	const [models, setModels] = useState<VideoModelList | null>(null);
	const [modelsError, setModelsError] = useState("");
	const [agents, setAgents] = useState<AgentSummary[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [panel, setPanel] = useState<
		{ kind: "add" } | { kind: "edit"; name: string } | null
	>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState(false);
	const [rowError, setRowError] = useState("");
	const addButton = useRef<HTMLButtonElement>(null);
	const sequence = useRef(0);
	const modelSequence = useRef(0);

	const loadModels = useCallback(async () => {
		const request = ++modelSequence.current;
		try {
			const next = await fetchVideoModels();
			if (request !== modelSequence.current) return;
			setModels(next);
			setModelsError("");
		} catch (cause) {
			if (request !== modelSequence.current) return;
			setModelsError(errorText(cause, "Could not load the video models."));
		}
	}, []);
	/** Reads the settings again, and the agents limits can name. */
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		// Without the agents, limits still show; agents show as removed.
		fetchAgents().then(
			(list) => {
				if (request === sequence.current) setAgents(list.agents);
			},
			() => undefined,
		);
		try {
			const next = await fetchVideoSettings();
			if (request !== sequence.current) return;
			setSettings(next);
			setError("");
			// Models and jobs answer 503 when video is off, and 403 to members.
			if (canEdit && next.available) void loadModels();
		} catch (cause) {
			if (request !== sequence.current) return;
			setError(
				errorText(
					cause,
					"Could not load video settings. Check the API connection and try again.",
				),
			);
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [canEdit, loadModels]);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
			modelSequence.current++;
		};
	}, [refresh]);
	const shownBefore = useRef(active);
	useEffect(() => {
		if (active && !shownBefore.current) void refresh();
		shownBefore.current = active;
	}, [active, refresh]);

	// The Add button is still disabled until the closed panel renders, so focus it after.
	const focusAdd = useRef(false);
	const closePanel = () => {
		focusAdd.current = true;
		setPanel(null);
	};
	useEffect(() => {
		if (panel || !focusAdd.current) return;
		focusAdd.current = false;
		addButton.current?.focus();
	}, [panel]);
	// Delete and Cancel replace themselves: focus follows to what took their place.
	const confirmDelete = useRef<HTMLButtonElement>(null);
	const deleteButtons = useRef(new Map<string, HTMLButtonElement>());
	const refocusDelete = useRef<string | null>(null);
	useEffect(() => {
		if (confirming) {
			confirmDelete.current?.focus();
			return;
		}
		const name = refocusDelete.current;
		refocusDelete.current = null;
		if (name) deleteButtons.current.get(name)?.focus();
	}, [confirming]);
	const available = settings?.available ?? true;
	const canChange = canEdit && available;
	const connections = settings?.connections ?? [];
	const editing =
		panel?.kind === "edit"
			? connections.find((item) => item.name === panel.name)
			: undefined;
	const videos = connections.reduce(
		(total, item) => total + item.usage.videos,
		0,
	);

	const settingsPanel = (
		<>
			{panel?.kind === "add" && settings && (
				<ConnectionForm
					taken={connections.map((item) => item.name)}
					persistence={settings.persistence}
					onClose={closePanel}
					onSaved={async (connection) => {
						closePanel();
						setNotice(`Added ${connection.name}.`);
						await refresh();
					}}
				/>
			)}
			{editing && settings && (
				<ConnectionForm
					key={editing.name}
					existing={editing}
					taken={[]}
					persistence={settings.persistence}
					onClose={closePanel}
					onSaved={async (connection) => {
						closePanel();
						setNotice(`Saved ${connection.name}.`);
						await refresh();
					}}
				/>
			)}
			<section className="models-overview" aria-label="Video overview">
				<div>
					<span className="overview-value">
						{settings ? usd(settings.spend.spentUsd) : "—"}
					</span>
					<span>Estimated video spend this month</span>
				</div>
				<div>
					<span className="overview-value">
						{settings ? count(videos) : "—"}
					</span>
					<span>Videos this month</span>
				</div>
				<div>
					<span className="overview-value">
						{settings ? connections.length : "—"}
					</span>
					<span>Video providers</span>
				</div>
			</section>
			<section
				className="card active-models"
				aria-labelledby="video-connections-heading"
				aria-busy={loading && Boolean(settings)}
			>
				<div className="section-heading">
					<div>
						<h2 id="video-connections-heading">Video providers</h2>
						<p className="card-note">
							Keys stay on the server and are never shown again.
						</p>
					</div>
					<button
						type="button"
						className="button"
						disabled={loading}
						onClick={() => void refresh()}
					>
						{loading ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				{rowError && (
					<div className="banner-error" role="alert">
						{rowError}
					</div>
				)}
				{!settings ? (
					<div className="models-empty">
						{loading ? (
							<LoadingBanner>Loading video settings…</LoadingBanner>
						) : (
							"Video settings could not be loaded."
						)}
					</div>
				) : connections.length === 0 ? (
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="video" />
						</span>
						<h3>No video providers yet</h3>
						<p>
							Add a Google Gemini Omni, Runway, or Luma key and agents with the
							video grant can make videos.
						</p>
						{workspace && !workspace.isDefault && (
							<p className="field-hint">
								This workspace starts with no video providers. Keys set as
								environment variables belong to the Default workspace.
							</p>
						)}
					</div>
				) : (
					<div className="table-scroll">
						<table className="models-table proxy-table video-table">
							<thead>
								<tr>
									<th>Provider</th>
									<th>Key</th>
									<th>Default model</th>
									<th>Credit price</th>
									<th>This month</th>
									<th>Status</th>
								</tr>
							</thead>
							<tbody>
								{connections.map((item) => (
									<tr key={item.name}>
										<td>
											<div className="model-title">
												<span className="model-avatar">
													<Icon name="video" />
												</span>
												<span>
													<strong>{item.name}</strong>
													<span className="field-hint">
														{VIDEO_KIND_LABELS[item.kind]}
														{item.source === "environment" &&
															" · environment variable"}
													</span>
													{item.source === "environment" && canEdit && (
														<span className="field-hint">
															Set on the server, so it is changed there. Move it
															down the order, or remove its variable, to stop
															using it.
														</span>
													)}
													{item.problem && (
														<span className="proxy-problem" role="note">
															{item.problem.detail}
														</span>
													)}
												</span>
											</div>
										</td>
										<td>{item.keyConfigured ? "Saved" : "Missing"}</td>
										<td>
											{item.defaultModel
												? modelLabel(item.kind, item.defaultModel)
												: `Provider default (${modelLabel(item.kind, DEFAULT_VIDEO_MODEL[item.kind])})`}
										</td>
										<td>
											{item.kind === "luma"
												? item.creditPriceUsd !== undefined
													? usd(item.creditPriceUsd)
													: "Default"
												: "—"}
										</td>
										<td>
											{count(item.usage.videos)}{" "}
											{item.usage.videos === 1 ? "video" : "videos"} ·{" "}
											{usd(item.usage.costUsd)}
										</td>
										<td>
											{canChange && item.source === "saved" ? (
												<div className="proxy-actions">
													<label className="failover-enable">
														<input
															type="checkbox"
															aria-label={`Use ${item.name}`}
															checked={item.enabled}
															onChange={async (event) => {
																setRowError("");
																try {
																	await updateVideoConnection(item.name, {
																		enabled: event.target.checked,
																	});
																	await refresh();
																} catch (cause) {
																	setRowError(
																		errorText(cause, "Could not change it."),
																	);
																}
															}}
														/>
														{item.enabled ? "On" : "Off"}
													</label>
													<button
														className="button"
														type="button"
														aria-label={`Edit ${item.name}`}
														onClick={() => {
															setPanel({ kind: "edit", name: item.name });
															setNotice("");
														}}
													>
														Edit
													</button>
													{confirming === item.name ? (
														<>
															<button
																ref={confirmDelete}
																className="button danger"
																type="button"
																aria-label={`Confirm delete ${item.name}`}
																disabled={deleting}
																onClick={async () => {
																	if (deleting) return;
																	setDeleting(true);
																	setRowError("");
																	try {
																		await deleteVideoConnection(item.name);
																		setConfirming(null);
																		setNotice(`Deleted ${item.name}.`);
																		if (
																			panel?.kind === "edit" &&
																			panel.name === item.name
																		)
																			setPanel(null);
																		await refresh();
																	} catch (cause) {
																		setRowError(
																			errorText(cause, "Could not delete it."),
																		);
																	} finally {
																		setDeleting(false);
																	}
																}}
															>
																{deleting ? "Deleting…" : "Delete"}
															</button>
															<button
																className="button"
																type="button"
																onClick={() => {
																	refocusDelete.current = item.name;
																	setConfirming(null);
																}}
															>
																Cancel
															</button>
														</>
													) : (
														<button
															ref={(element) => {
																if (element)
																	deleteButtons.current.set(item.name, element);
																else deleteButtons.current.delete(item.name);
															}}
															className="button"
															type="button"
															aria-label={`Delete ${item.name}`}
															onClick={() => setConfirming(item.name)}
														>
															Delete
														</button>
													)}
												</div>
											) : (
												<span className="chip">
													<span
														className={`dot ${item.enabled ? "dot-good" : "dot-muted"}`}
													/>
													{item.enabled ? "On" : "Off"}
												</span>
											)}
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
			{settings && connections.length > 1 && (
				<ProviderOrder
					policy={settings.policy}
					connections={connections}
					canEdit={canChange}
					onSaved={(policy) => {
						setSettings((current) =>
							current ? { ...current, policy } : current,
						);
						void refresh();
					}}
					onStale={() => void refresh()}
				/>
			)}
			{settings && (
				<VideoLimitsCard
					limits={settings.limits}
					agents={agents}
					connected={[...new Set(connections.map((item) => item.kind))]}
					canEdit={canChange}
					onChange={(update) => {
						setSettings((current) =>
							current
								? { ...current, limits: update(current.limits) }
								: current,
						);
						// A read started before this change would undo it on screen.
						void refresh();
					}}
					onShowBudget={onShowBudget}
				/>
			)}
		</>
	);

	return (
		<div className="video-page">
			<div className="tab-intro">
				{canEdit ? (
					<button
						ref={addButton}
						className="button primary"
						type="button"
						disabled={!settings || !available || panel?.kind === "add"}
						onClick={() => {
							setPanel({ kind: "add" });
							setNotice("");
						}}
					>
						<Icon name="plus" /> Add video provider
					</button>
				) : (
					<p className="page-note">
						Only workspace admins change video settings, make videos, and see
						the videos made.
					</p>
				)}
				{settings?.persistence === "memory" && (
					<p className="page-note">
						Video settings are temporary and last until the API restarts.
						Connect MongoDB to keep them.
					</p>
				)}
			</div>
			{settings && !settings.available && (
				<p className="banner-warning" role="status">
					{TURNED_OFF}
				</p>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}{" "}
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => void refresh()}
					>
						Retry
					</button>
				</div>
			)}
			{settingsPanel}
			{canEdit && settings?.available && (
				<VideoJobsPanel
					models={models}
					modelsError={modelsError}
					onFinished={() => void refresh()}
					onRetryModels={() => void loadModels()}
				/>
			)}
		</div>
	);
}
