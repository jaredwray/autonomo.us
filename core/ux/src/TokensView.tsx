import {
	API_TOKEN_TTLS,
	type ApiToken,
	type ApiTokenSecret,
	type ApiTokenSettings,
	type ApiTokenTtl,
	type CreateApiTokenRequest,
	type RollApiTokenRequest,
	type UpdateApiTokenRequest,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons.js";

type Panel<Permission extends string> =
	| { kind: "create" }
	| { kind: "edit" | "roll" | "revoke"; token: ApiToken<Permission> };
const date = (value: string | null) =>
	value ? new Date(value).toLocaleString() : "Never";
const ttlLabel = (value: ApiTokenTtl) =>
	value === "never" ? "Never" : `${value} ${value === 1 ? "day" : "days"}`;

export type TokenViewConfig<Permission extends string> = {
	title: string;
	tokenLabel: string;
	description: string;
	namePlaceholder: string;
	emptyMessage: string;
	connectionNote?: string;
	permissionHint: string;
	permissions: Record<Permission, string>;
	permissionGroups: readonly {
		resource: string;
		label: string;
		choices: readonly Permission[];
	}[];
	api: {
		list(): Promise<ApiTokenSettings<Permission>>;
		create(
			input: CreateApiTokenRequest<Permission>,
		): Promise<ApiTokenSecret<Permission>>;
		update(
			id: string,
			input: UpdateApiTokenRequest<Permission>,
		): Promise<ApiToken<Permission>>;
		roll(
			id: string,
			input: RollApiTokenRequest,
		): Promise<ApiTokenSecret<Permission>>;
		revoke(id: string): Promise<ApiToken<Permission>>;
	};
};

function PermissionFields<Permission extends string>({
	config,
	value,
	onChange,
}: {
	config: TokenViewConfig<Permission>;
	value: Permission[];
	onChange(permissions: Permission[]): void;
}) {
	return (
		<fieldset className="token-permission-fields">
			<legend>Permissions</legend>
			<p className="card-note">{config.permissionHint}</p>
			<ul className="token-permission-list">
				{config.permissionGroups.map((group) => {
					const read = group.choices.find((choice) => choice.endsWith(":read"));
					const edit = group.choices.find((choice) => choice.endsWith(":edit"));
					const editing = Boolean(edit && value.includes(edit));
					return (
						<li key={group.resource}>
							<span className="token-permission-resource">{group.label}</span>
							<div className="token-permission-options">
								{group.choices.map((permission) => (
									<label className="token-permission-choice" key={permission}>
										<input
											type="checkbox"
											aria-label={config.permissions[permission]}
											checked={
												value.includes(permission) ||
												(permission === read && editing)
											}
											disabled={permission === read && editing}
											onChange={(event) => {
												const next = value.filter(
													(item) =>
														item !== permission &&
														!(permission === edit && item === read),
												);
												if (event.target.checked) next.push(permission);
												else if (
													permission === edit &&
													read &&
													!next.includes(read)
												)
													next.push(read);
												onChange(next);
											}}
										/>
										{config.permissions[permission].split(": ")[1]}
									</label>
								))}
							</div>
						</li>
					);
				})}
			</ul>
		</fieldset>
	);
}

function TokenForm<Permission extends string>({
	config,
	panel,
	onClose,
	onSaved,
}: {
	config: TokenViewConfig<Permission>;
	panel: Panel<Permission>;
	onClose(): void;
	onSaved(message: string, secret?: ApiTokenSecret<Permission>): void;
}) {
	const token = panel.kind === "create" ? undefined : panel.token;
	const [name, setName] = useState(token?.name ?? "");
	const [description, setDescription] = useState(token?.description ?? "");
	const [permissions, setPermissions] = useState<Permission[]>(() => [
		...(token?.permissions ?? []),
	]);
	const [ttl, setTtl] = useState<ApiTokenTtl>(token?.ttlDays ?? 30);
	const [overlap, setOverlap] = useState("86400");
	const [customHours, setCustomHours] = useState(24);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const heading = useRef<HTMLHeadingElement>(null);
	useEffect(() => {
		heading.current?.focus();
	}, []);
	const title =
		panel.kind === "create"
			? `Create ${config.tokenLabel} token`
			: `${panel.kind === "edit" ? "Edit" : panel.kind === "roll" ? "Roll" : "Revoke"} ${token?.name}`;
	const metadata = panel.kind === "create" || panel.kind === "edit";
	return (
		<section className="card token-form" aria-labelledby="token-form-title">
			<div className="section-heading">
				<h2 id="token-form-title" tabIndex={-1} ref={heading}>
					{title}
				</h2>
				<button
					type="button"
					className="icon-button"
					aria-label="Close token form"
					onClick={onClose}
					disabled={busy}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						if (panel.kind === "create")
							onSaved(
								"Token created.",
								await config.api.create({
									name: name.trim(),
									description: description.trim(),
									ttlDays: ttl,
									permissions,
								}),
							);
						else if (panel.kind === "edit") {
							await config.api.update(panel.token.id, {
								name: name.trim(),
								description: description.trim(),
								permissions,
							});
							onSaved("Token updated.");
						} else if (panel.kind === "roll")
							onSaved(
								"Token rolled.",
								await config.api.roll(panel.token.id, {
									ttlDays: ttl,
									previousTokenTtlSeconds:
										overlap === "custom"
											? Math.round(customHours * 3600)
											: Number(overlap),
								}),
							);
						else {
							await config.api.revoke(panel.token.id);
							onSaved("Token revoked.");
						}
					} catch (cause) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not save the token.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					{metadata && (
						<div>
							<div className="form-field">
								<label htmlFor="token-name">Name</label>
								<input
									id="token-name"
									required
									maxLength={100}
									value={name}
									onChange={(event) => setName(event.target.value)}
									placeholder={config.namePlaceholder}
								/>
							</div>
							<div className="form-field">
								<label htmlFor="token-description">Description</label>
								<textarea
									id="token-description"
									maxLength={1000}
									value={description}
									onChange={(event) => setDescription(event.target.value)}
									placeholder="What will use this token?"
									rows={2}
								/>
							</div>
						</div>
					)}
					{(panel.kind === "create" || panel.kind === "roll") && (
						<div className="form-field token-ttl">
							<label htmlFor="token-ttl">
								{panel.kind === "roll" ? "New token TTL" : "TTL"}
							</label>
							<select
								id="token-ttl"
								value={ttl}
								onChange={(event) =>
									setTtl(
										event.target.value === "never"
											? "never"
											: (Number(event.target.value) as ApiTokenTtl),
									)
								}
							>
								{API_TOKEN_TTLS.map((value) => (
									<option key={value} value={value}>
										{ttlLabel(value)}
									</option>
								))}
							</select>
							<span className="field-hint">
								Starts when the new token is issued.
							</span>
						</div>
					)}
					{panel.kind === "edit" && (
						<p className="card-note">
							Roll this token to change its TTL and issue a new secret.
						</p>
					)}
					{metadata && (
						<PermissionFields
							config={config}
							value={permissions}
							onChange={setPermissions}
						/>
					)}
					{panel.kind === "roll" && (
						<>
							<div className="form-field">
								<label htmlFor="token-overlap">
									Keep previous token alive for
								</label>
								<select
									id="token-overlap"
									value={overlap}
									onChange={(event) => setOverlap(event.target.value)}
								>
									<option value="0">Revoke immediately</option>
									<option value="3600">1 hour</option>
									<option value="86400">24 hours</option>
									<option value="604800">7 days</option>
									<option value="custom">Custom duration</option>
								</select>
							</div>
							{overlap === "custom" && (
								<div className="form-field">
									<label htmlFor="token-overlap-hours">Overlap (hours)</label>
									<input
										id="token-overlap-hours"
										type="number"
										min={0}
										max={720}
										step="0.01"
										required
										value={customHours}
										onChange={(event) =>
											setCustomHours(event.target.valueAsNumber)
										}
									/>
								</div>
							)}
							<p className="card-note">
								The new token works immediately. The previous value stops
								working at the end of this overlap or its original expiry,
								whichever comes first. Earlier rolls keep their existing
								deadlines. Custom overlap supports up to 30 days.
							</p>
						</>
					)}
					{panel.kind === "revoke" && (
						<p>
							Revoke <strong>{token?.name}</strong>? The current value and every
							previous value will stop working immediately. This cannot be
							undone.
						</p>
					)}
					{error && (
						<div className="banner-error" role="alert">
							{error}
						</div>
					)}
					<div className="form-actions">
						<button className="button" type="button" onClick={onClose}>
							Cancel
						</button>
						<button
							className={`button ${panel.kind === "revoke" ? "danger" : "primary"}`}
							type="submit"
							disabled={metadata && !name.trim()}
						>
							{busy
								? "Saving…"
								: panel.kind === "create"
									? "Create token"
									: panel.kind === "edit"
										? "Save changes"
										: panel.kind === "roll"
											? "Roll token"
											: "Revoke token"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

function NewSecret<Permission extends string>({
	config,
	value,
	onDismiss,
}: {
	config: TokenViewConfig<Permission>;
	value: ApiTokenSecret<Permission>;
	onDismiss(): void;
}) {
	const [notice, setNotice] = useState("");
	const input = useRef<HTMLTextAreaElement>(null);
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	return (
		<section
			className="card token-secret"
			aria-labelledby="token-secret-heading"
		>
			<h2 id="token-secret-heading">Save your new token</h2>
			<p className="card-note">
				This is the only time the full value for{" "}
				<strong>{value.token.name}</strong> is shown. Save it before leaving
				this page.
			</p>
			<div className="form-field">
				<label htmlFor="new-token-secret">New {config.tokenLabel} token</label>
				<textarea
					ref={input}
					id="new-token-secret"
					value={value.secret}
					readOnly
					spellCheck={false}
					rows={3}
				/>
			</div>
			<div className="form-actions">
				<button
					className="button"
					type="button"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(value.secret);
							setNotice("Token copied.");
						} catch {
							input.current?.focus();
							input.current?.select();
							setNotice("Copy unavailable. Select and copy the token above.");
						}
					}}
				>
					Copy token
				</button>
				<button className="button primary" type="button" onClick={onDismiss}>
					I’ve saved this token
				</button>
			</div>
			{notice && <p role="status">{notice}</p>}
		</section>
	);
}

export function TokensView<Permission extends string>({
	config,
}: {
	config: TokenViewConfig<Permission>;
}) {
	const [data, setData] = useState<ApiTokenSettings<Permission> | null>(null);
	const [panel, setPanel] = useState<Panel<Permission> | null>(null);
	const [secret, setSecret] = useState<ApiTokenSecret<Permission> | null>(null);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const sequence = useRef(0);
	const createButton = useRef<HTMLButtonElement>(null);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const result = await config.api.list();
			if (request === sequence.current) {
				setData(result);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(
					cause instanceof Error
						? cause.message
						: `Could not load ${config.tokenLabel} tokens.`,
				);
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, [config]);
	useEffect(() => {
		void refresh();
		const timer = setInterval(() => void refresh(), 30_000);
		return () => {
			sequence.current++;
			clearInterval(timer);
		};
	}, [refresh]);
	const busy = Boolean(panel || secret);
	const wasBusy = useRef(false);
	useEffect(() => {
		if (wasBusy.current && !busy) createButton.current?.focus();
		wasBusy.current = busy;
	}, [busy]);
	return (
		<div className="dashboard tokens-view">
			<header className="dashboard-header">
				<div>
					<h1>{config.title}</h1>
					<p className="page-description">{config.description}</p>
				</div>
				<div className="header-actions">
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => void refresh()}
					>
						{loading ? "Loading…" : "Refresh"}
					</button>
					<button
						ref={createButton}
						className="button primary"
						type="button"
						disabled={!data || busy}
						onClick={() => {
							setNotice("");
							setPanel({ kind: "create" });
						}}
					>
						<Icon name="plus" />
						Create token
					</button>
				</div>
			</header>
			{config.connectionNote && (
				<p className="card-note">{config.connectionNote}</p>
			)}
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{notice && (
				<p className="success-notice" role="status">
					{notice}
				</p>
			)}
			{data?.persistence === "memory" && (
				<p className="card-note">
					Tokens and action history are temporary until MongoDB is connected.
					They are lost when the API restarts.
				</p>
			)}
			{data && !data.authenticationRequired && (
				<p className="banner-error">
					Authentication is disabled for this local gateway. Configure
					OWNER_TOKEN on the API to require credentials for all API requests.
				</p>
			)}
			{panel && (
				<TokenForm
					config={config}
					key={
						panel.kind === "create"
							? "create"
							: `${panel.kind}-${panel.token.id}`
					}
					panel={panel}
					onClose={() => {
						setPanel(null);
					}}
					onSaved={(message, value) => {
						setPanel(null);
						setNotice(message);
						setSecret(value ?? null);
						void refresh();
					}}
				/>
			)}
			{secret && (
				<NewSecret
					config={config}
					value={secret}
					onDismiss={() => {
						setSecret(null);
					}}
				/>
			)}
			<section className="card" aria-labelledby="tokens-heading">
				<div className="section-heading">
					<h2 id="tokens-heading">Your tokens</h2>
					<span className="card-note">{data?.tokens.length ?? 0} total</span>
				</div>
				{data?.tokens.length ? (
					<div className="table-scroll">
						<table className="tokens-table">
							<thead>
								<tr>
									<th>Name</th>
									<th>TTL</th>
									<th>Permissions</th>
									<th>Status</th>
									<th>Expires</th>
									<th>Actions</th>
								</tr>
							</thead>
							<tbody>
								{data.tokens.map((token) => (
									<tr key={token.id}>
										<td>
											<strong>{token.name}</strong>
											<p className="token-description">
												{token.description || "No description"}
											</p>
											<code>{token.prefix}</code>
											<small className="token-date">
												Created {date(token.createdAt)}
											</small>
										</td>
										<td>{ttlLabel(token.ttlDays)}</td>
										<td>
											{token.permissions.length
												? token.permissions.map((permission) => (
														<span
															className="token-permission-label"
															key={permission}
														>
															{config.permissions[permission]}
														</span>
													))
												: "None"}
										</td>
										<td>
											<span className={`token-status ${token.status}`}>
												{token.status}
											</span>
										</td>
										<td>
											{date(token.expiresAt)}
											{token.previousTokens.map((previous) => (
												<small className="token-date" key={previous.prefix}>
													Previous {previous.prefix}: {date(previous.expiresAt)}
												</small>
											))}
										</td>
										<td>
											<div className="token-actions">
												{(["edit", "roll", "revoke"] as const).map((kind) => (
													<button
														key={kind}
														className={`button ${kind === "revoke" ? "danger" : ""}`}
														type="button"
														disabled={busy || token.status === "revoked"}
														aria-label={`${kind === "edit" ? "Edit" : kind === "roll" ? "Roll" : "Revoke"} ${token.name}`}
														onClick={() => {
															setNotice("");
															setPanel({ kind, token });
														}}
													>
														{kind === "edit"
															? "Edit"
															: kind === "roll"
																? "Roll"
																: "Revoke"}
													</button>
												))}
											</div>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<div className="empty-state">
						{loading
							? "Loading tokens…"
							: error
								? "Tokens could not be loaded. Try refreshing."
								: config.emptyMessage}
					</div>
				)}
			</section>
			<section className="card" aria-labelledby="token-log-heading">
				<h2 id="token-log-heading">Token action log</h2>
				<p className="card-note">
					The latest 100 lifecycle actions, newest first. Token values are never
					included.
				</p>
				{data?.actions.length ? (
					<div className="table-scroll">
						<table className="token-log-table">
							<thead>
								<tr>
									<th>Time</th>
									<th>Token</th>
									<th>Action</th>
									<th>Actor</th>
									<th>Details</th>
								</tr>
							</thead>
							<tbody>
								{data.actions.map((action) => (
									<tr key={action.id}>
										<td>{date(action.timestamp)}</td>
										<td>{action.tokenName}</td>
										<td className="token-action-name">{action.action}</td>
										<td>
											{action.actor === "owner" ? "Owner" : "Local admin"}
										</td>
										<td>{action.detail}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<div className="empty-state">
						{loading
							? "Loading actions…"
							: error
								? "Action history is unavailable."
								: "No token actions yet."}
					</div>
				)}
			</section>
		</div>
	);
}
