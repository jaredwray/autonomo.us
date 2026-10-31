import type {
	FailoverPolicy,
	GatewayResponse,
	ModelInfo,
	RoutingConfig,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fetchModels, fetchRouting, sendChat, updateRouting } from "./api.js";

function ModelSelect({
	label,
	value,
	models,
	onChange,
}: {
	label: string;
	value: string;
	models: string[];
	onChange(value: string): void;
}) {
	const id = useId();
	return (
		<div className="form-field">
			<label htmlFor={id}>{label}</label>
			<select
				id={id}
				value={value}
				onChange={(event) => onChange(event.target.value)}
			>
				<option value="">Choose a model or pool…</option>
				{value && !models.includes(value) ? (
					<option value={value}>{value} (unavailable)</option>
				) : null}
				{models.map((model) => (
					<option key={model} value={model}>
						{model}
					</option>
				))}
			</select>
		</div>
	);
}

function PolicyEditor({
	policy,
	models,
	onChange,
}: {
	policy: FailoverPolicy;
	models: string[];
	onChange(policy: FailoverPolicy): void;
}) {
	const [target, setTarget] = useState("");
	return (
		<div className="routing-policy">
			<label className="failover-enable">
				<input
					type="checkbox"
					checked={policy.enabled}
					onChange={(event) =>
						onChange({ ...policy, enabled: event.target.checked })
					}
				/>
				Enable failover
			</label>
			<label className="form-field">
				Attempt timeout (ms)
				<input
					type="number"
					min="0"
					max="600000"
					required
					value={policy.timeoutMs}
					onChange={(event) =>
						onChange({ ...policy, timeoutMs: Number(event.target.value) })
					}
				/>
			</label>
			<p className="card-note">
				Fallbacks are tried in order. A timeout of 0 waits for a provider error.
			</p>
			<ol className="routing-list">
				{policy.targets.map((model, index) => (
					<li key={model}>
						<code>{model}</code>
						<div className="routing-row-actions">
							<button
								className="button"
								type="button"
								aria-label={`Move ${model} up`}
								disabled={index === 0}
								onClick={() => {
									const targets = [...policy.targets];
									[targets[index - 1], targets[index]] = [
										targets[index],
										targets[index - 1],
									];
									onChange({ ...policy, targets });
								}}
							>
								↑
							</button>
							<button
								className="button"
								type="button"
								aria-label={`Move ${model} down`}
								disabled={index === policy.targets.length - 1}
								onClick={() => {
									const targets = [...policy.targets];
									[targets[index + 1], targets[index]] = [
										targets[index],
										targets[index + 1],
									];
									onChange({ ...policy, targets });
								}}
							>
								↓
							</button>
							<button
								className="button"
								type="button"
								aria-label={`Remove fallback ${model}`}
								onClick={() =>
									onChange({
										...policy,
										targets: policy.targets.filter((id) => id !== model),
									})
								}
							>
								Remove
							</button>
						</div>
					</li>
				))}
			</ol>
			<div className="routing-add">
				<ModelSelect
					label="Fallback model"
					value={target}
					models={models.filter((model) => !policy.targets.includes(model))}
					onChange={setTarget}
				/>
				<button
					className="button"
					type="button"
					disabled={!target || policy.targets.includes(target)}
					onClick={() => {
						onChange({ ...policy, targets: [...policy.targets, target] });
						setTarget("");
					}}
				>
					Add fallback
				</button>
			</div>
		</div>
	);
}

export function RoutingView() {
	const [config, setConfig] = useState<RoutingConfig | null>(null);
	const [models, setModels] = useState<ModelInfo[]>([]);
	const [persistence, setPersistence] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [saving, setSaving] = useState(false);
	const [dirty, setDirty] = useState(false);
	const [saved, setSaved] = useState(false);
	const [autoTarget, setAutoTarget] = useState("");
	const [poolName, setPoolName] = useState("");
	const [ruleModel, setRuleModel] = useState("");
	const loadSequence = useRef(0);
	const load = useCallback(async () => {
		const sequence = ++loadSequence.current;
		setError(null);
		try {
			const [settings, available] = await Promise.all([
				fetchRouting(),
				fetchModels(),
			]);
			if (sequence !== loadSequence.current) return;
			setConfig(settings.config);
			setPersistence(settings.persistence);
			setModels(available.models);
		} catch (error) {
			if (sequence === loadSequence.current)
				setError(error instanceof Error ? error.message : String(error));
		}
	}, []);
	useEffect(() => {
		void load();
		return () => {
			loadSequence.current++;
		};
	}, [load]);
	const edit = (next: RoutingConfig) => {
		setConfig(next);
		setDirty(true);
		setSaved(false);
		setError(null);
	};
	const chatModels = models
		.filter((model) => model.capability !== "decisions")
		.map((model) => model.id);
	const targets = [
		...chatModels,
		...(config?.pools.map((pool) => `pool/${pool.id}`) ?? []),
	];
	const save = async () => {
		if (!config) return;
		setSaving(true);
		setError(null);
		setSaved(false);
		try {
			const result = await updateRouting(config);
			setConfig(result.config);
			setDirty(false);
			setSaved(true);
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setSaving(false);
		}
	};
	return (
		<div className="dashboard routing-view">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">Gateway</p>
					<h1>Model Routing</h1>
					<p className="page-description">
						Choose the right model, keep requests moving, and share traffic
						across accounts.
					</p>
				</div>
			</header>
			{error ? (
				<div className="banner-error" role="alert">
					{error}
					{!config ? (
						<button
							type="button"
							className="button"
							onClick={() => void load()}
						>
							Retry
						</button>
					) : null}
				</div>
			) : null}
			{!config ? (
				<p>Loading routing settings…</p>
			) : (
				<>
					<p className="card-note">
						{persistence === "mongodb"
							? "Routing settings are saved in MongoDB."
							: "Settings are temporary and last until the API restarts."}
					</p>
					{chatModels.length === 0 ? (
						<p className="banner-error">
							<a href="#/models">Add chat models and account connections</a> to
							start routing.
						</p>
					) : null}
					<form
						onSubmit={(event) => {
							event.preventDefault();
							void save();
						}}
					>
						<fieldset className="routing-fields" disabled={saving}>
							<section className="card" aria-labelledby="auto-title">
								<h2 id="auto-title">Auto mode</h2>
								<p className="card-note">
									A decision model reads each request and chooses from your
									allowed targets. Describe when each target is the best fit.
								</p>
								<label className="failover-enable">
									<input
										type="checkbox"
										checked={config.auto.enabled}
										onChange={(event) =>
											edit({
												...config,
												auto: { ...config.auto, enabled: event.target.checked },
											})
										}
									/>
									Enable Auto routing
								</label>
								<div className="model-form-grid">
									<ModelSelect
										label="Decision model"
										value={config.auto.decisionModel}
										models={models.map((model) => model.id)}
										onChange={(decisionModel) =>
											edit({
												...config,
												auto: { ...config.auto, decisionModel },
											})
										}
									/>
									<label className="form-field">
										Decision timeout (ms)
										<input
											type="number"
											min="100"
											max="600000"
											required
											value={config.auto.timeoutMs}
											onChange={(event) =>
												edit({
													...config,
													auto: {
														...config.auto,
														timeoutMs: Number(event.target.value),
													},
												})
											}
										/>
									</label>
								</div>
								<p className="card-note">
									Choose Jev or a configured chat model, including OpenAI. Auto
									makes an additional model call before generating the answer.
								</p>
								<div className="routing-add">
									<ModelSelect
										label="Allowed target"
										value={autoTarget}
										models={targets.filter(
											(target) =>
												!config.auto.targets.some(
													(item) => item.target === target,
												),
										)}
										onChange={setAutoTarget}
									/>
									<button
										type="button"
										className="button"
										disabled={
											!autoTarget ||
											config.auto.targets.some(
												(item) => item.target === autoTarget,
											)
										}
										onClick={() => {
											edit({
												...config,
												auto: {
													...config.auto,
													targets: [
														...config.auto.targets,
														{ target: autoTarget, description: "" },
													],
												},
											});
											setAutoTarget("");
										}}
									>
										Add target
									</button>
								</div>
								{config.auto.targets.map((item) => (
									<div className="routing-target" key={item.target}>
										<label className="form-field">
											When to use {item.target}
											<input
												required
												maxLength={2000}
												placeholder="For example: complex coding and reasoning"
												value={item.description}
												onChange={(event) =>
													edit({
														...config,
														auto: {
															...config.auto,
															targets: config.auto.targets.map((target) =>
																target.target === item.target
																	? {
																			...target,
																			description: event.target.value,
																		}
																	: target,
															),
														},
													})
												}
											/>
										</label>
										<button
											type="button"
											className="button"
											aria-label={`Remove Auto target ${item.target}`}
											onClick={() =>
												edit({
													...config,
													auto: {
														...config.auto,
														fallbackTarget:
															config.auto.fallbackTarget === item.target
																? ""
																: config.auto.fallbackTarget,
														targets: config.auto.targets.filter(
															(target) => target.target !== item.target,
														),
													},
												})
											}
										>
											Remove
										</button>
									</div>
								))}
								<ModelSelect
									label="If the decision model fails, use"
									value={config.auto.fallbackTarget}
									models={config.auto.targets.map((item) => item.target)}
									onChange={(fallbackTarget) =>
										edit({
											...config,
											auto: { ...config.auto, fallbackTarget },
										})
									}
								/>
							</section>
							<section className="card" aria-labelledby="pools-title">
								<h2 id="pools-title">Load balancing</h2>
								<p className="card-note">
									Group models or multiple account connections into a pool.
									Weighted round robin shares traffic by weight; least requests
									favors members with fewer active requests relative to their
									weight.
								</p>
								<p className="card-note">
									Each gateway instance balances its own traffic. Use the same
									model on different connections to balance accounts.
								</p>
								<div className="routing-add">
									<label className="form-field">
										New pool name
										<input
											value={poolName}
											placeholder="coding"
											maxLength={64}
											onChange={(event) => setPoolName(event.target.value)}
										/>
									</label>
									<button
										className="button"
										type="button"
										disabled={
											!/^[a-z][a-z0-9_-]{0,63}$/.test(poolName) ||
											config.pools.some((pool) => pool.id === poolName)
										}
										onClick={() => {
											edit({
												...config,
												pools: [
													...config.pools,
													{
														id: poolName,
														strategy: "weighted-round-robin",
														members: [],
														failover: true,
													},
												],
											});
											setPoolName("");
										}}
									>
										Add pool
									</button>
								</div>
								{config.pools.map((pool) => (
									<PoolEditor
										key={pool.id}
										pool={pool}
										models={chatModels}
										onChange={(next) =>
											edit({
												...config,
												pools: config.pools.map((item) =>
													item.id === pool.id ? next : item,
												),
											})
										}
										onRemove={() =>
											edit({
												...config,
												pools: config.pools.filter(
													(item) => item.id !== pool.id,
												),
											})
										}
									/>
								))}
							</section>
							<section
								className="card"
								aria-labelledby="default-failover-title"
							>
								<h2 id="default-failover-title">Default failover</h2>
								<p className="card-note">
									Applies when no model or pool rule matches. Streaming requests
									can switch only before the first output.
								</p>
								<PolicyEditor
									policy={config.failover}
									models={chatModels}
									onChange={(failover) => edit({ ...config, failover })}
								/>
							</section>
							<section className="card" aria-labelledby="rules-title">
								<h2 id="rules-title">Model and pool failover rules</h2>
								<p className="card-note">
									For example, send Astra failures to an Opus connection. A pool
									rule takes priority over its selected model's rule; either
									replaces the default policy. A pool's member failover remains
									independent.
								</p>
								<div className="routing-add">
									<ModelSelect
										label="Model or pool for rule"
										value={ruleModel}
										models={targets.filter(
											(target) =>
												!config.rules.some((rule) => rule.model === target),
										)}
										onChange={setRuleModel}
									/>
									<button
										className="button"
										type="button"
										disabled={
											!ruleModel ||
											config.rules.some((rule) => rule.model === ruleModel)
										}
										onClick={() => {
											edit({
												...config,
												rules: [
													...config.rules,
													{
														model: ruleModel,
														enabled: true,
														timeoutMs: 30000,
														targets: [],
													},
												],
											});
											setRuleModel("");
										}}
									>
										Add rule
									</button>
								</div>
								{config.rules.map((rule) => (
									<section
										className="routing-subcard"
										key={rule.model}
										aria-label={`Failover for ${rule.model}`}
									>
										<div className="routing-subheader">
											<h3>{rule.model}</h3>
											<button
												className="button"
												type="button"
												onClick={() =>
													edit({
														...config,
														rules: config.rules.filter(
															(item) => item.model !== rule.model,
														),
													})
												}
											>
												Remove rule
											</button>
										</div>
										<PolicyEditor
											policy={rule}
											models={chatModels.filter(
												(model) => model !== rule.model,
											)}
											onChange={(policy) =>
												edit({
													...config,
													rules: config.rules.map((item) =>
														item.model === rule.model
															? { ...policy, model: rule.model }
															: item,
													),
												})
											}
										/>
									</section>
								))}
							</section>
							<div className="routing-save">
								<button
									className="button primary"
									type="submit"
									disabled={!dirty}
								>
									{saving ? "Saving…" : "Save routing"}
								</button>
								<span role="status">
									{saved ? "Routing saved" : dirty ? "Unsaved changes" : ""}
								</span>
							</div>
						</fieldset>
					</form>
					<RoutingTrial
						models={chatModels}
						config={config}
						disabled={dirty || saving}
					/>
				</>
			)}
		</div>
	);
}

function PoolEditor({
	pool,
	models,
	onChange,
	onRemove,
}: {
	pool: RoutingConfig["pools"][number];
	models: string[];
	onChange(pool: RoutingConfig["pools"][number]): void;
	onRemove(): void;
}) {
	const [model, setModel] = useState("");
	const id = useId();
	return (
		<section className="routing-subcard" aria-labelledby={id}>
			<div className="routing-subheader">
				<h3 id={id}>pool/{pool.id}</h3>
				<button type="button" className="button" onClick={onRemove}>
					Remove pool
				</button>
			</div>
			<label className="form-field">
				Balancing strategy
				<select
					aria-label="Balancing strategy"
					value={pool.strategy}
					onChange={(event) =>
						onChange({
							...pool,
							strategy: event.target.value as typeof pool.strategy,
						})
					}
				>
					<option value="weighted-round-robin">Weighted round robin</option>
					<option value="least-requests">Least requests</option>
				</select>
			</label>
			<label className="failover-enable">
				<input
					type="checkbox"
					checked={pool.failover}
					onChange={(event) =>
						onChange({ ...pool, failover: event.target.checked })
					}
				/>
				Try other pool members on failure
			</label>
			{pool.members.map((member) => (
				<div className="routing-target" key={member.model}>
					<code>{member.model}</code>
					<label className="form-field routing-weight">
						Weight for {member.model}
						<input
							type="number"
							min="1"
							max="100"
							required
							value={member.weight}
							onChange={(event) =>
								onChange({
									...pool,
									members: pool.members.map((item) =>
										item.model === member.model
											? { ...item, weight: Number(event.target.value) }
											: item,
									),
								})
							}
						/>
					</label>
					<button
						className="button"
						type="button"
						aria-label={`Remove member ${member.model}`}
						onClick={() =>
							onChange({
								...pool,
								members: pool.members.filter(
									(item) => item.model !== member.model,
								),
							})
						}
					>
						Remove
					</button>
				</div>
			))}
			{pool.members.length === 0 ? (
				<p className="card-note">Add at least one member before saving.</p>
			) : null}
			<div className="routing-add">
				<ModelSelect
					label="Pool member"
					value={model}
					models={models.filter(
						(id) => !pool.members.some((item) => item.model === id),
					)}
					onChange={setModel}
				/>
				<button
					className="button"
					type="button"
					disabled={!model || pool.members.some((item) => item.model === model)}
					onClick={() => {
						onChange({
							...pool,
							members: [...pool.members, { model, weight: 1 }],
						});
						setModel("");
					}}
				>
					Add member
				</button>
			</div>
		</section>
	);
}

function RoutingTrial({
	models,
	config,
	disabled,
}: {
	models: string[];
	config: RoutingConfig;
	disabled: boolean;
}) {
	const [model, setModel] = useState("auto");
	const [prompt, setPrompt] = useState("");
	const [result, setResult] = useState<GatewayResponse | null>(null);
	const [error, setError] = useState("");
	const [running, setRunning] = useState(false);
	const run = async () => {
		setRunning(true);
		setResult(null);
		setError("");
		try {
			setResult(await sendChat(model, prompt));
		} catch (error) {
			setError(error instanceof Error ? error.message : String(error));
		} finally {
			setRunning(false);
		}
	};
	return (
		<section className="card" aria-labelledby="trial-title">
			<h2 id="trial-title">Try routing</h2>
			<p className="card-note">
				Runs a real request using saved settings. Provider usage charges apply.
				Save your changes before trying a route.
			</p>
			<form
				onSubmit={(event) => {
					event.preventDefault();
					void run();
				}}
			>
				<fieldset className="routing-fields" disabled={running || disabled}>
					<label className="form-field">
						Routing mode
						<select
							aria-label="Routing mode"
							value={model}
							onChange={(event) => setModel(event.target.value)}
						>
							<option value="auto" disabled={!config.auto.enabled}>
								Auto{!config.auto.enabled ? " (disabled)" : ""}
							</option>
							{[
								...config.pools.map((pool) => `pool/${pool.id}`),
								...models,
							].map((id) => (
								<option key={id} value={id}>
									{id}
								</option>
							))}
						</select>
					</label>
					<label className="form-field">
						Request
						<textarea
							required
							value={prompt}
							onChange={(event) => setPrompt(event.target.value)}
							rows={3}
							placeholder="What would you like help with?"
						/>
					</label>
					<button
						type="submit"
						className="button"
						disabled={
							!prompt.trim() || (model === "auto" && !config.auto.enabled)
						}
					>
						{running ? "Sending…" : "Send request"}
					</button>
				</fieldset>
			</form>
			{error ? (
				<p role="alert" className="save-error">
					{error}
				</p>
			) : null}
			{result ? (
				<div className="routing-result" role="status">
					<p>
						Answered by <strong>{result.model}</strong>
						{result.routing?.decisionFallback
							? " · Decision fallback used"
							: ""}
						{result.failover
							? ` · ${result.failover.attempts.length} failed attempt(s)`
							: ""}
					</p>
					<p>{result.message.content}</p>
				</div>
			) : null}
		</section>
	);
}
