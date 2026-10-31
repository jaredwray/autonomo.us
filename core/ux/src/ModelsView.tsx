import {
	type ManagedProvider,
	type ModelInfo,
	PROVIDER_NAMES,
	type ProviderSettings,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	addModel,
	fetchModelCatalog,
	fetchModels,
	fetchProviderSettings,
	type ModelCatalog,
	type ModelsData,
} from "./api.js";
import { Icon } from "./Icons.js";

const providerNames: Record<string, string> = PROVIDER_NAMES;

function AddModelForm(props: {
	settings: ProviderSettings;
	catalog: ModelCatalog | null;
	models: ModelInfo[];
	onAdded(model: ModelInfo): void;
	onClose(): void;
}) {
	const [provider, setProvider] = useState<ManagedProvider>("google");
	const [connection, setConnection] = useState(
		() =>
			props.settings.connections.find((item) => item.provider === "google")
				?.id ?? "",
	);
	const [connectionName, setConnectionName] = useState("google");
	const [model, setModel] = useState("");
	const [apiKey, setApiKey] = useState("");
	const [accountId, setAccountId] = useState("");
	const [saving, setSaving] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const providerInput = useRef<HTMLSelectElement>(null);
	useEffect(() => {
		providerInput.current?.focus();
	}, []);
	const connections = props.settings.connections.filter(
		(item) => item.provider === provider,
	);
	const providerSettings = connections.find((item) => item.id === connection);
	const connectionId = connection || connectionName.trim();
	const nameTaken =
		!connection &&
		props.settings.connections.some((item) => item.id === connectionId);
	const configured = providerSettings?.configured;
	const active = props.models.some(
		(item) => item.id === `${connectionId}/${model.trim()}`,
	);
	const suggestions = (props.catalog?.providers[provider]?.models ?? []).filter(
		(item) =>
			!/(embedding|image|imagine|video|tts|live|audio|robotics|voice|whisper|rerank|moderation)/i.test(
				item.id,
			),
	);

	return (
		<section
			className="card add-model-card"
			aria-labelledby="add-model-heading"
		>
			<div className="section-heading">
				<div>
					<h2 id="add-model-heading">Add a model</h2>
					<p className="card-note">
						Choose a provider and a model to make it available in your gateway.
					</p>
				</div>
				<button
					className="icon-button"
					type="button"
					aria-label="Close add model"
					onClick={props.onClose}
					disabled={saving}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (saving) return;
					setSaving(true);
					setError(null);
					try {
						const added = await addModel({
							provider,
							connectionId,
							createConnection: !connection,
							model: model.trim(),
							...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
							...(provider === "cloudflare" && accountId.trim()
								? { accountId: accountId.trim() }
								: {}),
						});
						setApiKey("");
						props.onAdded(added);
					} catch (cause) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not add the model.",
						);
					} finally {
						setSaving(false);
					}
				}}
			>
				<fieldset disabled={saving}>
					<div className="model-form-grid">
						<div className="form-field">
							<label htmlFor="model-provider">Provider</label>
							<select
								id="model-provider"
								ref={providerInput}
								value={provider}
								onChange={(event) => {
									setProvider(event.target.value as ManagedProvider);
									const existing = props.settings.connections.find(
										(item) => item.provider === event.target.value,
									);
									setConnection(existing?.id ?? "");
									setConnectionName(event.target.value);
									setAccountId(existing?.accountId ?? "");
									setModel("");
									setApiKey("");
									setError(null);
								}}
							>
								{props.settings.providers.map((item) => (
									<option key={item.id} value={item.id}>
										{item.name}
									</option>
								))}
							</select>
						</div>
						<div className="form-field">
							<label htmlFor="provider-connection">Connection</label>
							<select
								id="provider-connection"
								value={connection}
								onChange={(event) => {
									setConnection(event.target.value);
									setConnectionName(connections.length ? "" : provider);
									setApiKey("");
									setAccountId(
										connections.find((item) => item.id === event.target.value)
											?.accountId ?? "",
									);
									setError(null);
								}}
							>
								{connections.map((item) => (
									<option key={item.id} value={item.id}>
										{item.id}
									</option>
								))}
								<option value="">New connection…</option>
							</select>
						</div>
						{!connection ? (
							<div className="form-field">
								<label htmlFor="connection-name">Connection name</label>
								<input
									id="connection-name"
									value={connectionName}
									onChange={(event) => {
										setConnectionName(event.target.value);
										setError(null);
									}}
									required
									pattern="[a-z][a-z0-9_\-]{0,63}"
									maxLength={64}
									placeholder={`${provider}-work`}
									aria-describedby="connection-help"
								/>
								<span className="field-hint" id="connection-help">
									{nameTaken
										? "This name is already in use. Select the existing connection or choose another name."
										: "Use lowercase letters, numbers, dashes or underscores. Each connection has its own credentials."}
								</span>
							</div>
						) : null}
						<div className="form-field">
							<label htmlFor="provider-model">Model</label>
							<input
								id="provider-model"
								required
								list="model-options"
								value={model}
								onChange={(event) => {
									setModel(event.target.value);
									setError(null);
								}}
								placeholder="Choose or enter a model ID"
								maxLength={200}
								aria-describedby="model-help"
							/>
							<datalist id="model-options">
								{suggestions.map((item) => (
									<option key={item.id} value={item.id}>
										{item.name}
									</option>
								))}
							</datalist>
							<span className="field-hint" id="model-help">
								{active
									? "This model is already active."
									: "Select a suggestion or enter a model ID from your provider."}
							</span>
						</div>
						{provider === "cloudflare" ? (
							<div className="form-field">
								<label htmlFor="cloudflare-account">
									Cloudflare Account ID
								</label>
								<input
									id="cloudflare-account"
									value={accountId}
									onChange={(event) => setAccountId(event.target.value)}
									required
									maxLength={32}
									pattern="[a-fA-F0-9]{32}"
									placeholder="32-character account ID"
									aria-describedby="account-help"
								/>
								<span className="field-hint" id="account-help">
									Find this in your Cloudflare account overview.
								</span>
							</div>
						) : null}
						<div className="form-field key-field">
							<label htmlFor="provider-api-key">
								{provider === "cloudflare" ? "API token" : "API key"}{" "}
								{configured ? (
									<span className="field-hint">(optional)</span>
								) : null}
							</label>
							<input
								id="provider-api-key"
								type="password"
								autoComplete="new-password"
								spellCheck={false}
								value={apiKey}
								required={!configured}
								onChange={(event) => {
									setApiKey(event.target.value);
									setError(null);
								}}
								placeholder={
									configured
										? "Leave blank to use your saved key"
										: `Enter your ${providerNames[provider]} API key`
								}
								aria-describedby="key-help"
								maxLength={4096}
							/>
							<span className="field-hint" id="key-help">
								{configured ? "This connection has a saved key. " : ""}Keys stay
								on the server and are never shown again.
							</span>
						</div>
					</div>
					{provider === "typesafe" ? (
						<p className="field-hint">
							Jev classifies and scores data. Use it for decisions through
							/v1/decisions; it cannot answer chat requests. Get a key from the{" "}
							<a
								href="https://console.typesafe.ai"
								target="_blank"
								rel="noreferrer"
							>
								TypeSafe console
							</a>
							.
						</p>
					) : null}
					{provider === "cloudflare" ? (
						<p className="field-hint">
							Use a Cloudflare API token with Workers AI permission.
						</p>
					) : null}
					{props.settings.persistence === "memory" ? (
						<p className="field-hint">
							Changes in this session last until the API restarts. Connect
							MongoDB to keep them.
						</p>
					) : null}
					{error ? (
						<div className="banner-error" role="alert">
							{error}
						</div>
					) : null}
					<div className="form-actions">
						<button className="button" type="button" onClick={props.onClose}>
							Cancel
						</button>
						<button
							className="button primary"
							type="submit"
							disabled={
								!model.trim() ||
								!connectionId ||
								nameTaken ||
								(!configured && !apiKey.trim()) ||
								(active && !apiKey.trim())
							}
						>
							{saving ? "Adding…" : active ? "Update key" : "Add model"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

export function ModelsView() {
	const [data, setData] = useState<ModelsData | null>(null);
	const [settings, setSettings] = useState<ProviderSettings | null>(null);
	const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [settingsError, setSettingsError] = useState(false);
	const [catalogError, setCatalogError] = useState(false);
	const [loading, setLoading] = useState(true);
	const [adding, setAdding] = useState(false);
	const [search, setSearch] = useState("");
	const [notice, setNotice] = useState("");
	const addButton = useRef<HTMLButtonElement>(null);
	const refresh = useCallback(async () => {
		setLoading(true);
		const [models, providers, choices] = await Promise.allSettled([
			fetchModels(),
			fetchProviderSettings(),
			fetchModelCatalog(),
		]);
		if (models.status === "fulfilled") {
			setData(models.value);
			setError(null);
		} else
			setError(
				"Could not load active models. Check the API connection and try again.",
			);
		if (providers.status === "fulfilled") {
			setSettings(providers.value);
			setSettingsError(false);
		} else {
			setSettings(null);
			setSettingsError(true);
		}
		if (choices.status === "fulfilled") {
			setCatalog(choices.value);
			setCatalogError(false);
		} else setCatalogError(true);
		setLoading(false);
	}, []);
	useEffect(() => {
		void refresh();
	}, [refresh]);
	const closeForm = () => {
		setAdding(false);
		addButton.current?.focus();
	};
	const providerKind = (connection: string) =>
		data?.providers.find((item) => item.name === connection)?.kind ??
		connection;
	const filtered = (data?.models ?? []).filter((item) =>
		`${item.id} ${providerNames[providerKind(item.provider)] ?? item.provider}`
			.toLowerCase()
			.includes(search.toLowerCase().trim()),
	);

	return (
		<div className="dashboard models-page">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">Gateway</p>
					<h1>Models</h1>
					<p className="page-description">
						Manage the models available to your agents.
					</p>
				</div>
				<button
					ref={addButton}
					className="button primary"
					type="button"
					disabled={!settings || adding}
					onClick={() => {
						setAdding(true);
						setNotice("");
					}}
				>
					<Icon name="plus" /> Add model
				</button>
			</header>
			{notice ? (
				<p className="success-notice" role="status">
					{notice}
				</p>
			) : null}
			{error || settingsError ? (
				<div className="banner-error" role="alert">
					{error ??
						"Model setup is unavailable. Check the database connection and try again."}{" "}
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => void refresh()}
					>
						Retry
					</button>
				</div>
			) : null}
			{adding && settings ? (
				<AddModelForm
					settings={settings}
					catalog={catalog}
					models={data?.models ?? []}
					onClose={closeForm}
					onAdded={(model) => {
						setData((current) =>
							current
								? {
										...current,
										models: [
											...current.models.filter((item) => item.id !== model.id),
											model,
										],
									}
								: { models: [model], providers: [] },
						);
						setNotice(`${model.id} is now active.`);
						setSearch("");
						closeForm();
						void refresh();
					}}
				/>
			) : null}
			{adding && catalogError ? (
				<p className="field-hint">
					Model suggestions are unavailable. You can still enter a model ID from
					your provider.
				</p>
			) : null}
			<section className="models-overview" aria-label="Model overview">
				<div>
					<span className="overview-value">
						{data ? data.models.length : "—"}
					</span>
					<span>Active models</span>
				</div>
				<div>
					<span className="overview-value">
						{data ? data.providers.length : "—"}
					</span>
					<span>Provider connections</span>
				</div>
				<p>One gateway. Your choice of models.</p>
			</section>
			<section
				className="card active-models"
				aria-labelledby="active-models-heading"
				aria-busy={loading}
			>
				<div className="section-heading">
					<div>
						<h2 id="active-models-heading">Active models</h2>
						<p className="card-note">Configured for use in your gateway.</p>
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
				<label className="model-search">
					<Icon name="search" />
					<input
						type="search"
						aria-label="Search active models"
						placeholder="Search models or providers…"
						value={search}
						onChange={(event) => setSearch(event.target.value)}
					/>
				</label>
				{!data ? (
					<div className="models-empty">
						{loading ? "Loading models…" : "Models could not be loaded."}
					</div>
				) : data.models.length === 0 ? (
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="models" />
						</span>
						<h3>No active models yet</h3>
						<p>Add your first model to start using the gateway.</p>
						<span className="field-hint">
							Connect your preferred provider for chat or structured decisions.
						</span>
						{data.providers.length > 0 ? (
							<p className="field-hint">
								{data.providers.map((item) => item.name).join(", ")} configured
								without an advertised model list.
							</p>
						) : null}
						<button
							type="button"
							className="button"
							disabled={!settings || adding}
							onClick={() => setAdding(true)}
						>
							<Icon name="plus" /> Add your first model
						</button>
					</div>
				) : filtered.length === 0 ? (
					<div className="models-empty">
						<h3>No matching models</h3>
						<p>Try another model name or provider.</p>
						<button
							className="button"
							type="button"
							onClick={() => setSearch("")}
						>
							Clear search
						</button>
					</div>
				) : (
					<div className="table-scroll">
						<table className="models-table">
							<thead>
								<tr>
									<th>Model</th>
									<th>Provider</th>
									<th>Connection</th>
									<th>Use</th>
									<th>Status</th>
								</tr>
							</thead>
							<tbody>
								{filtered.map((item) => (
									<tr key={item.id}>
										<td>
											<div className="model-title">
												<span className="model-avatar">
													<Icon name="models" />
												</span>
												<span>
													<strong>
														{catalog?.providers[
															providerKind(item.provider)
														]?.models.find((entry) => entry.id === item.model)
															?.name ?? item.model}
													</strong>
													<code>{item.id}</code>
												</span>
											</div>
										</td>
										<td>
											{providerNames[providerKind(item.provider)] ??
												item.provider}
										</td>
										<td>{item.provider}</td>
										<td>
											{item.capability === "decisions" ? "Decisions" : "Chat"}
										</td>
										<td>
											<span className="chip">
												<span className="dot dot-good" />
												Active
											</span>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}
			</section>
		</div>
	);
}
