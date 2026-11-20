import {
	type AgentSummary,
	agentNamesText,
	type BudgetAppliesTo,
	type UpdateVideoLimitRequest,
	VIDEO_KIND_LABELS,
	VIDEO_KINDS,
	VIDEO_LIMITS,
	VIDEO_MODELS,
	type VideoKind,
	type VideoLimit,
	type VideoLimitCovers,
	type VideoLimitInput,
	videoLimitProblem,
	videoModelLabel,
} from "@autonomo.us/common";
import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { AppliesToFields } from "./AppliesToFields.js";
import { createVideoLimit, deleteVideoLimit, updateVideoLimit } from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";

/**
 * Video limits, a kind of policy on the Models page's Policies tab: how many
 * videos each person, API token, or agent may start in a UTC day, and how
 * long a video may be, for everyone or chosen agents, on every video model
 * or one.
 */

const count = (value: number) => value.toLocaleString();
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

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

/** Adds a video limit, or changes one. */
export function VideoLimitForm({
	existing,
	agents,
	names,
	connected,
	typePicker,
	onSaved,
	onClose,
}: {
	existing?: VideoLimit;
	agents: AgentSummary[];
	names: Names;
	/** Provider kinds this workspace has a connection for: their models come first. */
	connected: VideoKind[];
	/** Shown under the heading when adding: which kind of policy this is. It takes the focus. */
	typePicker?: ReactNode;
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
	const pickerShown = Boolean(typePicker);
	useEffect(() => {
		if (!pickerShown) first.current?.focus();
	}, [pickerShown]);
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
					{/* Inside the fieldset, so the kind cannot change while a save is on its way. */}
					{typePicker}
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
 * everyone or chosen agents, on every video model or one. Admins change,
 * switch off, and delete them here, and add them with Add policy; members
 * see them.
 */
export function VideoLimitsCard({
	limits,
	agents,
	connected,
	canEdit,
	available,
	loading,
	failed,
	onChange,
	onNotice,
	onAdd,
	onRetry,
	editingId,
	onEdit,
}: {
	/** Null until read. */
	limits: VideoLimit[] | null;
	agents: AgentSummary[];
	connected: VideoKind[];
	/** Whether the caller is a workspace admin. */
	canEdit: boolean;
	/** False when the gateway's operator turned video off: limits cannot change then. */
	available: boolean;
	loading: boolean;
	/** The video settings could not be read. */
	failed: boolean;
	/** Shows a change made here at once; a fresh read follows. */
	onChange(update: (limits: VideoLimit[]) => VideoLimit[]): void;
	/** Says what was just done, at the top of the tab. */
	onNotice(text: string): void;
	/** Opens Add policy on a video limit. */
	onAdd(): void;
	onRetry(): void;
	/** The limit whose edit form is open. The tab keeps one form open at a time. */
	editingId: string | null;
	onEdit(id: string | null): void;
}) {
	const canChange = canEdit && available;
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
	// Closing an edit returns focus to the row's Edit, or the heading if the row is gone.
	const heading = useRef<HTMLHeadingElement>(null);
	const editButtons = useRef(new Map<string, HTMLButtonElement>());
	const focusAfterClose = useRef<string | null>(null);
	useEffect(() => {
		if (editingId || !focusAfterClose.current) return;
		const target = focusAfterClose.current;
		focusAfterClose.current = null;
		(editButtons.current.get(target) ?? heading.current)?.focus();
	}, [editingId]);
	const closePanel = () => {
		focusAfterClose.current = editingId;
		onEdit(null);
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
	const editing = editingId
		? limits?.find((limit) => limit.id === editingId)
		: undefined;

	return (
		<>
			{editing && canChange && (
				<VideoLimitForm
					key={editing.id}
					existing={editing}
					agents={agents}
					names={names}
					connected={connected}
					onClose={closePanel}
					onSaved={(saved) => {
						onChange((current) =>
							current.map((item) => (item.id === saved.id ? saved : item)),
						);
						onNotice("Limit saved.");
						closePanel();
					}}
				/>
			)}
			<section
				className="card active-models"
				aria-labelledby="video-limits-heading"
				aria-busy={loading && Boolean(limits)}
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
				</div>
				{canEdit && !available && (
					<p className="field-hint">
						Video generation is turned off on this gateway, so video limits
						cannot be changed.
					</p>
				)}
				{rowError && (
					<div className="banner-error" role="alert">
						{rowError}
					</div>
				)}
				{!limits ? (
					<div className="models-empty">
						{loading ? (
							<LoadingBanner>Loading video limits…</LoadingBanner>
						) : failed ? (
							<>
								<p>Video limits could not be loaded.</p>
								<button className="button" type="button" onClick={onRetry}>
									Retry
								</button>
							</>
						) : (
							"Video limits could not be loaded."
						)}
					</div>
				) : limits.length === 0 ? (
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="video" />
						</span>
						<h3>No video limits</h3>
						<p>
							Videos are limited only by budgets and the longest each model can
							make.
						</p>
						{canChange && (
							<button type="button" className="button" onClick={onAdd}>
								<Icon name="plus" /> Add a video limit
							</button>
						)}
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
									{canChange && (
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
												{canChange ? (
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
											{canChange && (
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
																onEdit(limit.id);
																onNotice("");
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
																			if (editingId === limit.id) onEdit(null);
																			onChange((current) =>
																				current.filter(
																					(item) => item.id !== limit.id,
																				),
																			);
																			onNotice("Limit deleted.");
																			// Its row is gone: focus goes to the heading.
																			heading.current?.focus();
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
					What videos may cost is set with a budget, above.
				</p>
			</section>
		</>
	);
}
