import {
	VIDEO_KIND_LABELS,
	VIDEO_LIMITS,
	type VideoAspectRatio,
	type VideoGenerateRequest,
	type VideoJob,
	type VideoModel,
	type VideoModelList,
	type VideoResolution,
	videoJobFinished,
	videoModelProblem,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	ApiError,
	cancelVideoJob,
	fetchVideoJob,
	fetchVideoJobs,
	generateVideo,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { ago, dateTime } from "./dashboard-format.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";
import { usd } from "./ProxiesView.js";

/** Jobs followed at once, so waits stay within the browser's connections to one host. */
const FOLLOWED = 3;
/** How long one status request may hold, in seconds. */
const WAIT_SECONDS = 10;
/** The shortest gap between status requests for one job, whatever the server does. */
const MIN_GAP_MS = 2000;
const FIRST_RETRY_MS = 5000;
const MAX_RETRY_MS = 30_000;

const STATUS_LABELS: Record<VideoJob["status"], string> = {
	queued: "Queued",
	running: "Running",
	succeeded: "Done",
	failed: "Failed",
	canceled: "Canceled",
	expired: "Expired",
};

const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/** What a model can make in this workspace: its own choices, capped by the longest video allowed. */
export function formChoices(model: VideoModel, maxDurationSeconds: number) {
	const { durations } = model;
	const allowed:
		| { kind: "range"; min: number; max: number }
		| { kind: "list"; values: number[] } =
		"min" in durations
			? {
					kind: "range",
					min: durations.min,
					max: Math.min(durations.max, maxDurationSeconds),
				}
			: {
					kind: "list",
					values: durations.filter((value) => value <= maxDurationSeconds),
				};
	const fits =
		allowed.kind === "range"
			? allowed.min <= allowed.max
			: allowed.values.length > 0;
	return {
		durations: allowed,
		fits,
		aspectRatios: [...model.aspectRatios],
		resolutions: [...model.resolutions],
		image: model.inputs.includes("image"),
	};
}

/** Why this request cannot be made, in words, or null when it can. */
export function videoRequestProblem(
	model: VideoModel,
	maxDurationSeconds: number,
	want: {
		prompt: string;
		durationSeconds: number;
		aspectRatio: VideoAspectRatio;
		resolution: VideoResolution;
		imageUrl: string;
	},
): string | null {
	const choices = formChoices(model, maxDurationSeconds);
	if (!choices.fits) {
		const shortest =
			"min" in model.durations
				? model.durations.min
				: Math.min(...model.durations);
		return `${model.label} makes videos of at least ${shortest} seconds, longer than this workspace allows (${maxDurationSeconds} s).`;
	}
	if (!want.prompt.trim()) return "Describe the video.";
	if (want.durationSeconds > maxDurationSeconds)
		return `This workspace allows videos of up to ${maxDurationSeconds} seconds.`;
	const image = want.imageUrl.trim();
	if (image) {
		if (!choices.image) return `${model.label} does not start from an image.`;
		if (image.length > VIDEO_LIMITS.urlLength)
			return `An image URL is at most ${VIDEO_LIMITS.urlLength} characters.`;
		try {
			if (new URL(image).protocol !== "https:")
				return "The image URL must start with https://.";
		} catch {
			return "Enter the image's full https:// URL.";
		}
	}
	return videoModelProblem(model, {
		durationSeconds: want.durationSeconds,
		aspectRatio: want.aspectRatio,
		resolution: want.resolution,
		image: Boolean(image),
		promptLength: want.prompt.trim().length,
	});
}

/** The model a request would most likely use: the one chosen, the provider's default, or the first provider's. */
function basisModel(
	models: VideoModelList,
	provider: string,
	model: string,
): VideoModel | undefined {
	const chosen =
		models.providers.find((item) => item.name === provider) ??
		models.providers[0];
	if (!chosen) return undefined;
	const id = (provider && model) || chosen.defaultModel;
	return (
		chosen.models.find((item) => item.id === id) ??
		chosen.models.find((item) => item.id === chosen.defaultModel) ??
		chosen.models[0]
	);
}

/** A value the model allows: the current one when it fits, otherwise its default or the nearest allowed. */
function fitDuration(
	model: VideoModel,
	maxDurationSeconds: number,
	current: number,
): number {
	const { durations } = formChoices(model, maxDurationSeconds);
	if (durations.kind === "range") {
		if (current >= durations.min && current <= durations.max) return current;
		const preferred = model.defaults.durationSeconds;
		return Math.max(durations.min, Math.min(preferred, durations.max));
	}
	if (durations.values.includes(current)) return current;
	return durations.values.includes(model.defaults.durationSeconds)
		? model.defaults.durationSeconds
		: (durations.values[0] ?? model.defaults.durationSeconds);
}

/** The form that starts a video, held to what the chosen model can make. */
function MakeVideo({
	models,
	onStarted,
}: {
	models: VideoModelList;
	onStarted(job: VideoJob): void;
}) {
	const id = useId();
	const cap = models.limits.maxDurationSeconds;
	const [prompt, setPrompt] = useState("");
	const [provider, setProvider] = useState("");
	const [model, setModel] = useState("");
	const first = basisModel(models, "", "");
	const [duration, setDuration] = useState(() =>
		first ? fitDuration(first, cap, first.defaults.durationSeconds) : 5,
	);
	const [aspectRatio, setAspectRatio] = useState<VideoAspectRatio>(
		first?.defaults.aspectRatio ?? "16:9",
	);
	const [resolution, setResolution] = useState<VideoResolution>(
		first?.defaults.resolution ?? "720p",
	);
	const [imageUrl, setImageUrl] = useState("");
	const [starting, setStarting] = useState(false);
	const [error, setError] = useState("");
	const basis = basisModel(models, provider, model);
	const chosenProvider = models.providers.find(
		(item) => item.name === provider,
	);

	// A different model keeps what it allows and resets the rest to its defaults.
	const refit = (nextProvider: string, nextModel: string) => {
		const next = basisModel(models, nextProvider, nextModel);
		if (!next) return;
		setDuration((current) => fitDuration(next, cap, current));
		setAspectRatio((current) =>
			next.aspectRatios.includes(current) ? current : next.defaults.aspectRatio,
		);
		setResolution((current) =>
			next.resolutions.includes(current) ? current : next.defaults.resolution,
		);
		if (!next.inputs.includes("image")) setImageUrl("");
	};

	if (!basis) return null;
	const choices = formChoices(basis, cap);
	// What is sent and shown: never a value the model does not offer.
	const shownAspect = basis.aspectRatios.includes(aspectRatio)
		? aspectRatio
		: basis.defaults.aspectRatio;
	const shownResolution = basis.resolutions.includes(resolution)
		? resolution
		: basis.defaults.resolution;
	const shownImage = choices.image ? imageUrl : "";
	const problem = videoRequestProblem(basis, cap, {
		prompt,
		durationSeconds: duration,
		aspectRatio: shownAspect,
		resolution: shownResolution,
		imageUrl: shownImage,
	});
	return (
		<section className="card video-make" aria-labelledby={`${id}-title`}>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>Make a video</h2>
					<p className="card-note">
						Starts a real video on the provider, billed to its account and
						counted against the monthly budget and your daily limit. It takes
						from half a minute to several minutes.
					</p>
				</div>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (starting || problem) return;
					setStarting(true);
					setError("");
					const input: VideoGenerateRequest = {
						prompt: prompt.trim(),
						durationSeconds: duration,
						aspectRatio: shownAspect,
						resolution: shownResolution,
						...(provider ? { provider } : {}),
						...(provider && model ? { model } : {}),
						...(shownImage.trim() ? { imageUrl: shownImage.trim() } : {}),
					};
					try {
						onStarted(await generateVideo(input));
						setPrompt("");
					} catch (cause) {
						setError(errorText(cause, "Could not start the video."));
					} finally {
						setStarting(false);
					}
				}}
			>
				<fieldset disabled={starting}>
					<div className="form-field">
						<label htmlFor={`${id}-prompt`}>Prompt</label>
						<textarea
							id={`${id}-prompt`}
							rows={3}
							required
							maxLength={basis.promptLength}
							value={prompt}
							placeholder="A lighthouse on a rocky coast at dusk, waves crashing, slow aerial push-in"
							onChange={(event) => {
								setPrompt(event.target.value);
								setError("");
							}}
							aria-describedby={`${id}-prompt-help`}
						/>
						<span className="field-hint" id={`${id}-prompt-help`}>
							Subject, action, setting, camera, and sound. Up to{" "}
							{basis.promptLength.toLocaleString()} characters.
						</span>
					</div>
					<div className="model-form-grid">
						<div className="form-field">
							<label htmlFor={`${id}-provider`}>Provider</label>
							<Dropdown
								id={`${id}-provider`}
								value={provider}
								onValueChange={(value) => {
									setProvider(value);
									setModel("");
									refit(value, "");
									setError("");
								}}
							>
								<option value="">Automatic: first that can make it</option>
								{models.providers.map((item) => (
									<option key={item.name} value={item.name}>
										{item.name} ({VIDEO_KIND_LABELS[item.kind]})
									</option>
								))}
							</Dropdown>
						</div>
						{chosenProvider && (
							<div className="form-field">
								<label htmlFor={`${id}-model`}>Model</label>
								<Dropdown
									id={`${id}-model`}
									value={model}
									onValueChange={(value) => {
										setModel(value);
										refit(provider, value);
										setError("");
									}}
								>
									<option value="">
										Connection default (
										{chosenProvider.models.find(
											(item) => item.id === chosenProvider.defaultModel,
										)?.label ?? chosenProvider.defaultModel}
										)
									</option>
									{chosenProvider.models.map((item) => (
										<option key={item.id} value={item.id}>
											{item.label}
										</option>
									))}
								</Dropdown>
							</div>
						)}
						<div className="form-field">
							<label htmlFor={`${id}-duration`}>Duration (seconds)</label>
							{choices.durations.kind === "range" ? (
								<input
									id={`${id}-duration`}
									type="number"
									required
									min={choices.durations.min}
									max={choices.durations.max}
									step={1}
									value={duration}
									disabled={!choices.fits}
									onChange={(event) => setDuration(Number(event.target.value))}
								/>
							) : (
								<Dropdown
									id={`${id}-duration`}
									value={String(duration)}
									disabled={!choices.fits}
									onValueChange={(value) => setDuration(Number(value))}
								>
									{choices.durations.values.map((value) => (
										<option key={value} value={String(value)}>
											{value} s
										</option>
									))}
								</Dropdown>
							)}
							<span className="field-hint">
								{choices.durations.kind === "range"
									? choices.fits
										? `${choices.durations.min} to ${choices.durations.max} seconds.`
										: "No length this model makes fits the workspace's limit."
									: choices.fits
										? `${choices.durations.values.join(" or ")} seconds.`
										: "No length this model makes fits the workspace's limit."}
							</span>
						</div>
						<div className="form-field">
							<label htmlFor={`${id}-aspect`}>Aspect ratio</label>
							<Dropdown
								id={`${id}-aspect`}
								value={shownAspect}
								onValueChange={(value) =>
									setAspectRatio(value as VideoAspectRatio)
								}
							>
								{choices.aspectRatios.map((value) => (
									<option key={value} value={value}>
										{value === "16:9"
											? "16:9 landscape"
											: value === "9:16"
												? "9:16 portrait"
												: "1:1 square"}
									</option>
								))}
							</Dropdown>
						</div>
						<div className="form-field">
							<label htmlFor={`${id}-resolution`}>Resolution</label>
							<Dropdown
								id={`${id}-resolution`}
								value={shownResolution}
								onValueChange={(value) =>
									setResolution(value as VideoResolution)
								}
							>
								{choices.resolutions.map((value) => (
									<option key={value} value={value}>
										{value}
									</option>
								))}
							</Dropdown>
						</div>
						{choices.image && (
							<div className="form-field">
								<label htmlFor={`${id}-image`}>
									Start from an image{" "}
									<span className="field-hint">(optional)</span>
								</label>
								<input
									id={`${id}-image`}
									type="url"
									inputMode="url"
									maxLength={VIDEO_LIMITS.urlLength}
									placeholder="https://example.com/frame.jpg"
									value={imageUrl}
									onChange={(event) => setImageUrl(event.target.value)}
								/>
								<span className="field-hint">
									An https link to a JPEG, PNG, or WebP. The provider downloads
									it.
								</span>
							</div>
						)}
					</div>
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					{problem && (prompt.trim() || !choices.fits) && (
						<p className="field-hint">{problem}</p>
					)}
					<div className="form-actions">
						<span className="field-hint">
							Uses {basis.label}
							{chosenProvider ? ` on ${chosenProvider.name}` : ""}.
						</span>
						<button
							className="button primary"
							type="submit"
							disabled={Boolean(problem)}
						>
							{starting ? "Starting…" : "Make video"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/** A finished video: Play mounts a player on demand; the link always works. */
function Player({ job }: { job: VideoJob }) {
	const [playing, setPlaying] = useState(false);
	const [broken, setBroken] = useState(false);
	if (!job.video) return null;
	return (
		<div className="video-play">
			{playing && !broken ? (
				// biome-ignore lint/a11y/useMediaCaption: generated videos come with no captions.
				<video
					className="video-player"
					controls
					autoPlay
					playsInline
					preload="metadata"
					src={job.video.url}
					onError={() => setBroken(true)}
				/>
			) : broken ? (
				<p className="field-hint" role="note">
					This video cannot play here. Open it instead.
				</p>
			) : null}
			<div className="video-actions">
				{!playing && (
					<button
						className="button"
						type="button"
						aria-label={`Play ${job.id}`}
						onClick={() => setPlaying(true)}
					>
						Play
					</button>
				)}
				<a
					className="button"
					href={job.video.url}
					target="_blank"
					rel="noreferrer"
				>
					Open video
				</a>
				<span className="field-hint">
					Available until {dateTime(job.video.expiresAt)}
				</span>
			</div>
		</div>
	);
}

function JobItem({
	job,
	onChanged,
	onError,
}: {
	job: VideoJob;
	onChanged(job: VideoJob): void;
	onError(message: string): void;
}) {
	const [confirming, setConfirming] = useState(false);
	const [stopping, setStopping] = useState(false);
	const finished = videoJobFinished(job.status);
	return (
		<li>
			<div className="video-job-head">
				<span className={`video-status ${job.status}`}>
					{STATUS_LABELS[job.status]}
					{job.status === "running" && job.progress !== null
						? ` · ${job.progress}%`
						: ""}
				</span>
				<span>
					{job.provider} · {job.model}
				</span>
				<span className="field-hint">{job.createdBy.name}</span>
				<time
					className="field-hint"
					dateTime={job.createdAt}
					title={dateTime(job.createdAt)}
				>
					{ago(job.createdAt)}
				</time>
			</div>
			<p className="video-prompt">{job.prompt}</p>
			<p className="field-hint">
				{job.durationSeconds} s · {job.aspectRatio} · {job.resolution} · est.{" "}
				{usd(job.costUsd)}
				{job.hasImage ? " · from an image" : ""}
			</p>
			{job.status === "failed" && job.error && (
				<p className="video-error" role="note">
					{job.error.message}
				</p>
			)}
			{job.status === "expired" && (
				<p className="field-hint">The provider no longer keeps this video.</p>
			)}
			{job.status === "succeeded" && <Player job={job} />}
			{!finished && (
				<div className="video-actions">
					{confirming ? (
						<>
							<button
								className="button danger"
								type="button"
								aria-label={`Confirm stop ${job.id}`}
								disabled={stopping}
								onClick={async () => {
									setStopping(true);
									try {
										onChanged(await cancelVideoJob(job.id));
										setConfirming(false);
									} catch (cause) {
										onError(errorText(cause, "Could not stop the video."));
									} finally {
										setStopping(false);
									}
								}}
							>
								{stopping ? "Stopping…" : "Stop video"}
							</button>
							<button
								className="button"
								type="button"
								onClick={() => setConfirming(false)}
							>
								Keep going
							</button>
							<span className="field-hint">
								Stopping does not give back the estimated cost.
							</span>
						</>
					) : (
						<button
							className="button"
							type="button"
							aria-label={`Stop ${job.id}`}
							onClick={() => setConfirming(true)}
						>
							Stop
						</button>
					)}
				</div>
			)}
		</li>
	);
}

const sleep = (ms: number, signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted) return resolve();
		const timer = setTimeout(done, ms);
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
		signal.addEventListener("abort", done, { once: true });
	});

/** Resolves once the page is visible again, or the follow is stopped. */
const visible = (signal: AbortSignal) =>
	new Promise<void>((resolve) => {
		if (signal.aborted || !document.hidden) return resolve();
		function done() {
			if (!signal.aborted && document.hidden) return;
			document.removeEventListener("visibilitychange", done);
			signal.removeEventListener("abort", done);
			resolve();
		}
		document.addEventListener("visibilitychange", done);
		signal.addEventListener("abort", done, { once: true });
	});

/** The Videos tab: the form, then every job in the workspace, following unfinished ones. */
export function VideoJobsPanel({
	models,
	modelsError,
	onFinished,
	onShowSettings,
}: {
	models: VideoModelList | null;
	modelsError: string;
	/** A job finished or started: the budget and usage changed. */
	onFinished(): void;
	onShowSettings(): void;
}) {
	const [jobs, setJobs] = useState<VideoJob[] | null>(null);
	const [nextBefore, setNextBefore] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [rowError, setRowError] = useState("");
	const [notice, setNotice] = useState("");
	const sequence = useRef(0);
	const finished = useRef(onFinished);
	finished.current = onFinished;

	const load = useCallback(async (before?: string) => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const page = await fetchVideoJobs(before ? { before } : {});
			if (request !== sequence.current) return;
			setJobs((current) =>
				before && current ? [...current, ...page.jobs] : page.jobs,
			);
			setNextBefore(page.nextBefore);
			setError("");
		} catch (cause) {
			if (request !== sequence.current) return;
			setError(errorText(cause, "Could not load videos."));
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		void load();
		return () => {
			sequence.current++;
		};
	}, [load]);

	const replace = useCallback((job: VideoJob) => {
		setJobs((current) =>
			current
				? current.map((item) => (item.id === job.id ? job : item))
				: current,
		);
	}, []);

	// Follows the newest few unfinished jobs: each status request holds up to
	// WAIT_SECONDS on the server, which asks the provider at most every 5 s.
	const followed = (jobs ?? [])
		.filter((job) => !videoJobFinished(job.status))
		.slice(0, FOLLOWED)
		.map((job) => job.id)
		.join(",");
	useEffect(() => {
		if (!followed) return;
		const controller = new AbortController();
		const { signal } = controller;
		const follow = async (id: string) => {
			let retry = FIRST_RETRY_MS;
			while (!signal.aborted) {
				await visible(signal);
				if (signal.aborted) return;
				const started = Date.now();
				try {
					const job = await fetchVideoJob(id, { wait: WAIT_SECONDS, signal });
					if (signal.aborted) return;
					replace(job);
					retry = FIRST_RETRY_MS;
					if (videoJobFinished(job.status)) {
						finished.current();
						return;
					}
					const gap = MIN_GAP_MS - (Date.now() - started);
					if (gap > 0) await sleep(gap, signal);
				} catch (cause) {
					if (signal.aborted) return;
					if (cause instanceof ApiError && cause.status === 404) {
						setJobs((current) =>
							current ? current.filter((item) => item.id !== id) : current,
						);
						return;
					}
					await sleep(retry, signal);
					retry = Math.min(retry * 2, MAX_RETRY_MS);
				}
			}
		};
		for (const id of followed.split(",")) void follow(id);
		return () => controller.abort();
	}, [followed, replace]);

	return (
		<>
			{models && !models.available ? (
				<section className="card">
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="video" />
						</span>
						<h3>Video is not set up</h3>
						<p>{models.reason}</p>
						<button className="button" type="button" onClick={onShowSettings}>
							Open settings
						</button>
					</div>
				</section>
			) : models ? (
				<MakeVideo
					models={models}
					onStarted={(job) => {
						setJobs((current) => [job, ...(current ?? [])]);
						setNotice(
							job.status === "failed"
								? "The video could not be started. The list says why."
								: "Started. It appears below and updates on its own.",
						);
						finished.current();
					}}
				/>
			) : modelsError ? (
				<div className="banner-error" role="alert">
					{modelsError}
				</div>
			) : null}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			<section
				className="card"
				aria-labelledby="video-jobs-heading"
				aria-busy={loading}
			>
				<div className="section-heading">
					<div>
						<h2 id="video-jobs-heading">Videos</h2>
						<p className="card-note">
							Every video made in this workspace in the last 30 days, newest
							first.
						</p>
					</div>
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => void load()}
					>
						{loading ? "Refreshing…" : "Refresh"}
					</button>
				</div>
				{(error || rowError) && (
					<div className="banner-error" role="alert">
						{error || rowError}
					</div>
				)}
				{!jobs ? (
					<div className="models-empty">
						{loading ? <LoadingBanner>Loading videos…</LoadingBanner> : null}
					</div>
				) : jobs.length === 0 ? (
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="video" />
						</span>
						<h3>No videos yet</h3>
						<p>Videos agents and people make appear here.</p>
					</div>
				) : (
					<ul className="video-jobs" aria-label="Videos">
						{jobs.map((job) => (
							<JobItem
								key={job.id}
								job={job}
								onChanged={(next) => {
									setRowError("");
									replace(next);
									finished.current();
								}}
								onError={setRowError}
							/>
						))}
					</ul>
				)}
				{nextBefore && (
					<div className="form-actions">
						<button
							className="button"
							type="button"
							disabled={loading}
							onClick={() => void load(nextBefore)}
						>
							Load more
						</button>
					</div>
				)}
			</section>
		</>
	);
}
