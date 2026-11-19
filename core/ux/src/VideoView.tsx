import {
	type CreateVideoConnectionRequest,
	DEFAULT_VIDEO_MODEL,
	type UpdateVideoConnectionRequest,
	VIDEO_KIND_LABELS,
	VIDEO_KINDS,
	VIDEO_LIMITS,
	VIDEO_MODELS,
	VIDEO_NAME_PATTERN,
	type VideoConnection,
	type VideoKind,
	type VideoModelList,
	type VideoPolicy,
	type VideoSettings,
	videoModel,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	ApiError,
	createVideoConnection,
	deleteVideoConnection,
	fetchVideoModels,
	fetchVideoSettings,
	updateVideoConnection,
	updateVideoPolicy,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { PageTabs } from "./PageTabs.js";
import { usd } from "./ProxiesView.js";
import { VideoJobsPanel } from "./VideoJobs.js";
import { parseVideoTab, type VideoTab, videoHash } from "./video-route.js";

export { formChoices, videoRequestProblem } from "./VideoJobs.js";

const VIDEO_TABS: readonly { id: VideoTab; label: string }[] = [
	{ id: "videos", label: "Videos" },
	{ id: "settings", label: "Settings" },
];
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

/** Why the limits cannot be saved, checked against the gateway's own bounds. */
export function videoPolicyProblem(policy: VideoPolicy): string | null {
	const perDay = policy.callerVideosPerDay;
	if (
		!Number.isInteger(perDay) ||
		perDay < 0 ||
		perDay > VIDEO_LIMITS.maxCallerVideosPerDay
	)
		return `Videos a day is a whole number from 0 to ${count(VIDEO_LIMITS.maxCallerVideosPerDay)}.`;
	const budget = policy.monthlyBudgetUsd;
	if (
		!Number.isFinite(budget) ||
		budget < 0 ||
		budget > VIDEO_LIMITS.maxMonthlyBudgetUsd
	)
		return `The monthly budget is from $0 to $${count(VIDEO_LIMITS.maxMonthlyBudgetUsd)}.`;
	const longest = policy.maxDurationSeconds;
	if (
		!Number.isInteger(longest) ||
		longest < VIDEO_LIMITS.minDurationSeconds ||
		longest > VIDEO_LIMITS.maxDurationSeconds
	)
		return `The longest video is a whole number of seconds from ${VIDEO_LIMITS.minDurationSeconds} to ${VIDEO_LIMITS.maxDurationSeconds}.`;
	return null;
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

/** The order connections are tried in, and the workspace's limits. */
function VideoPolicyEditor({
	policy,
	connections,
	budget,
	canEdit,
	dirty,
	saving,
	error,
	saved,
	onChange,
	onSave,
	onReload,
}: {
	policy: VideoPolicy;
	connections: VideoConnection[];
	budget: VideoSettings["budget"];
	canEdit: boolean;
	dirty: boolean;
	saving: boolean;
	error: { message: string; stale: boolean } | null;
	saved: boolean;
	onChange(policy: VideoPolicy): void;
	onSave(): void;
	onReload(): void;
}) {
	const id = useId();
	const problem = videoPolicyProblem(policy);
	const order = displayOrder(policy, connections);
	const move = (index: number, by: number) => {
		const next = [...order];
		const [item] = next.splice(index, 1);
		next.splice(index + by, 0, item);
		onChange({ ...policy, order: next });
	};
	return (
		<form
			className="card"
			aria-labelledby={`${id}-title`}
			onSubmit={(event) => {
				event.preventDefault();
				if (canEdit && dirty && !problem && !saving) onSave();
			}}
		>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>Limits and order</h2>
					<p className="card-note">
						A video starts on the first connection in this order that can make
						it. If that provider fails without charging, the next one is tried.
					</p>
				</div>
			</div>
			<fieldset className="routing-fields" disabled={!canEdit || saving}>
				{order.length === 0 ? (
					<p className="card-note">Add a provider to set the order.</p>
				) : (
					<ol className="routing-list" aria-label="Connection order">
						{order.map((name, index) => {
							const item = connections.find((other) => other.name === name);
							const hint = !item?.keyConfigured
								? "key missing"
								: !item.enabled
									? "switched off"
									: VIDEO_KIND_LABELS[item.kind];
							return (
								<li key={name}>
									<code>{name}</code> <span className="field-hint">{hint}</span>
									{canEdit && order.length > 1 && (
										<div className="routing-row-actions">
											<button
												className="button"
												type="button"
												aria-label={`Move ${name} up`}
												disabled={index === 0}
												onClick={() => move(index, -1)}
											>
												↑
											</button>
											<button
												className="button"
												type="button"
												aria-label={`Move ${name} down`}
												disabled={index === order.length - 1}
												onClick={() => move(index, 1)}
											>
												↓
											</button>
										</div>
									)}
								</li>
							);
						})}
					</ol>
				)}
				<h3>Limits</h3>
				<div className="model-form-grid">
					<div className="form-field">
						<label htmlFor={`${id}-per-day`}>Videos a day</label>
						<input
							id={`${id}-per-day`}
							type="number"
							required
							min={0}
							max={VIDEO_LIMITS.maxCallerVideosPerDay}
							step={1}
							value={policy.callerVideosPerDay}
							onChange={(event) =>
								onChange({
									...policy,
									callerVideosPerDay: Number(event.target.value),
								})
							}
						/>
						<span className="field-hint">
							For each person, API token, and agent, counted from 00:00 UTC.
						</span>
					</div>
					<div className="form-field">
						<label htmlFor={`${id}-budget`}>Monthly budget (USD)</label>
						<input
							id={`${id}-budget`}
							type="number"
							required
							min={0}
							max={VIDEO_LIMITS.maxMonthlyBudgetUsd}
							step={0.01}
							value={policy.monthlyBudgetUsd}
							onChange={(event) =>
								onChange({
									...policy,
									monthlyBudgetUsd: Number(event.target.value),
								})
							}
						/>
						<span className="field-hint">
							What every video together may cost in a calendar month (UTC),
							estimated from list prices. New videos stop once it is reached.{" "}
							{usd(budget.spentUsd)} of {usd(budget.limitUsd)} used in{" "}
							{budget.month}.
						</span>
					</div>
					<div className="form-field">
						<label htmlFor={`${id}-longest`}>Longest video (seconds)</label>
						<input
							id={`${id}-longest`}
							type="number"
							required
							min={VIDEO_LIMITS.minDurationSeconds}
							max={VIDEO_LIMITS.maxDurationSeconds}
							step={1}
							value={policy.maxDurationSeconds}
							onChange={(event) =>
								onChange({
									...policy,
									maxDurationSeconds: Number(event.target.value),
								})
							}
						/>
						<span className="field-hint">
							Requests for longer videos are refused, whatever the model can
							make.
						</span>
					</div>
				</div>
				{error && (
					<div className="banner-error" role="alert">
						{error.message}{" "}
						{error.stale && (
							<button className="button" type="button" onClick={onReload}>
								Reload
							</button>
						)}
					</div>
				)}
				{canEdit && (
					<div className="routing-save">
						<button
							className="button primary"
							type="submit"
							disabled={!dirty || Boolean(problem)}
						>
							{saving ? "Saving…" : "Save limits and order"}
						</button>
						<span role="status">
							{dirty && problem
								? problem
								: saved
									? "Saved"
									: dirty
										? "Unsaved changes"
										: ""}
						</span>
					</div>
				)}
			</fieldset>
		</form>
	);
}

export function VideoView({
	workspace,
}: {
	workspace?: { isDefault: boolean; role?: "admin" | "member" };
} = {}) {
	// Members see providers and limits; admins change them, make videos, and see every job.
	const canEdit = workspace?.role !== "member";
	const [tab, setTab] = useState<VideoTab>(() =>
		parseVideoTab(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setTab(parseVideoTab(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const showTab = useCallback((next: VideoTab) => {
		const hash = videoHash(next);
		if (window.location.hash !== hash) window.history.pushState(null, "", hash);
		setTab(next);
	}, []);
	const shownTab: VideoTab = canEdit ? tab : "settings";

	const [settings, setSettings] = useState<VideoSettings | null>(null);
	const [models, setModels] = useState<VideoModelList | null>(null);
	const [modelsError, setModelsError] = useState("");
	const [draft, setDraft] = useState<VideoPolicy | null>(null);
	const [dirty, setDirty] = useState(false);
	const dirtyRef = useRef(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [panel, setPanel] = useState<
		{ kind: "add" } | { kind: "edit"; name: string } | null
	>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [rowError, setRowError] = useState("");
	const [saving, setSaving] = useState(false);
	const [saved, setSaved] = useState(false);
	const [saveError, setSaveError] = useState<{
		message: string;
		stale: boolean;
	} | null>(null);
	const addButton = useRef<HTMLButtonElement>(null);
	const sequence = useRef(0);
	const modelSequence = useRef(0);

	const editDraft = (next: VideoPolicy) => {
		setDraft(next);
		setDirty(true);
		dirtyRef.current = true;
		setSaved(false);
		setSaveError(null);
	};
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
	const refresh = useCallback(
		async (discard = false) => {
			const request = ++sequence.current;
			setLoading(true);
			try {
				const next = await fetchVideoSettings();
				if (request !== sequence.current) return;
				setSettings(next);
				setError("");
				// Unsaved edits to the limits survive a refresh unless they are thrown away.
				if (discard || !dirtyRef.current) {
					setDraft(next.policy);
					setDirty(false);
					dirtyRef.current = false;
				}
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
		},
		[canEdit, loadModels],
	);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
			modelSequence.current++;
		};
	}, [refresh]);

	const savePolicy = async (policy: VideoPolicy) => {
		setSaving(true);
		setSaveError(null);
		try {
			const next = await updateVideoPolicy(policy);
			setSettings((current) =>
				current ? { ...current, policy: next } : current,
			);
			setDraft(next);
			setDirty(false);
			dirtyRef.current = false;
			setSaved(true);
			void refresh();
		} catch (cause) {
			setSaveError(
				cause instanceof ApiError && cause.status === 409
					? {
							message:
								"The video settings changed elsewhere since you opened them. Reload to see the latest, then make your change again.",
							stale: true,
						}
					: {
							message: errorText(cause, "Could not save the video settings."),
							stale: false,
						},
			);
		} finally {
			setSaving(false);
		}
	};
	const closePanel = () => {
		setPanel(null);
		addButton.current?.focus();
	};
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
						{settings
							? `${usd(settings.budget.spentUsd)} / ${usd(settings.budget.limitUsd)}`
							: "—"}
					</span>
					<span>Estimated spend this month</span>
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
					<span>Connections</span>
				</div>
			</section>
			{!canEdit && (
				<p className="card-note">Only workspace admins see and make videos.</p>
			)}
			<section
				className="card active-models"
				aria-labelledby="video-connections-heading"
				aria-busy={loading && Boolean(settings)}
			>
				<div className="section-heading">
					<div>
						<h2 id="video-connections-heading">Connections</h2>
						<p className="card-note">
							Keys stay on the server. A video uses the first connection in the
							order that can make it.
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
									<th>Connection</th>
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
																className="button danger"
																type="button"
																aria-label={`Confirm delete ${item.name}`}
																onClick={async () => {
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
																		await refresh(true);
																	} catch (cause) {
																		setRowError(
																			errorText(cause, "Could not delete it."),
																		);
																	}
																}}
															>
																Delete
															</button>
															<button
																className="button"
																type="button"
																onClick={() => setConfirming(null)}
															>
																Cancel
															</button>
														</>
													) : (
														<button
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
			{draft && settings && (
				<VideoPolicyEditor
					policy={draft}
					connections={connections}
					budget={settings.budget}
					canEdit={canChange}
					dirty={dirty}
					saving={saving}
					error={saveError}
					saved={saved}
					onChange={editDraft}
					onSave={() => void savePolicy(draft)}
					onReload={() => {
						setSaveError(null);
						void refresh(true);
					}}
				/>
			)}
		</>
	);

	return (
		<div className="dashboard models-page proxies-page video-page">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">Gateway</p>
					<h1>Video</h1>
					<p className="page-description">
						Providers that make short videos for agents and scripts, and the
						limits on what they spend.
					</p>
				</div>
				{canEdit ? (
					<button
						ref={addButton}
						className="button primary"
						type="button"
						disabled={!settings || !available || panel?.kind === "add"}
						onClick={() => {
							showTab("settings");
							setPanel({ kind: "add" });
							setNotice("");
						}}
					>
						<Icon name="plus" /> Add provider
					</button>
				) : (
					<p className="card-note">
						Ask a workspace admin to add video providers, change the limits, or
						make videos.
					</p>
				)}
			</header>
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
			{settings && (
				<p className="card-note">
					{settings.persistence === "mongodb"
						? "Video settings are saved in MongoDB."
						: "Video settings are temporary and last until the API restarts. Connect MongoDB to keep them."}
				</p>
			)}
			{canEdit ? (
				<>
					<PageTabs
						label="Video sections"
						idPrefix="video"
						tabs={VIDEO_TABS}
						selected={shownTab}
						onSelect={showTab}
					/>
					<div
						role="tabpanel"
						id="video-panel"
						aria-labelledby={`video-tab-${shownTab}`}
					>
						{shownTab === "settings" ? (
							settingsPanel
						) : !settings ? null : !settings.available ? (
							<section className="card">
								<div className="models-empty">
									<span className="empty-icon">
										<Icon name="video" />
									</span>
									<p>{TURNED_OFF}</p>
								</div>
							</section>
						) : (
							<VideoJobsPanel
								models={models}
								modelsError={modelsError}
								onFinished={() => void refresh()}
								onShowSettings={() => showTab("settings")}
							/>
						)}
					</div>
				</>
			) : (
				settingsPanel
			)}
		</div>
	);
}
