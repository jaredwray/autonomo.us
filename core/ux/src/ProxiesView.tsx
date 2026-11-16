import {
	COUNTRY_PATTERN,
	type CreateProxyRequest,
	DEFAULT_PROXY_LEVEL,
	levelFixes,
	PROXY_KIND_LABELS,
	PROXY_KINDS,
	PROXY_LEVELS,
	PROXY_NAME_PATTERN,
	type ProxyConnection,
	type ProxyKind,
	type ProxyLevel,
	type ProxyList,
	stepLabel,
	type UpdateProxyRequest,
	WEB_LIMITS,
	type WebDomainRule,
	type WebFetchOutcome,
	type WebFetchResult,
	type WebPolicy,
	type WebStep,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	ApiError,
	createProxy,
	deleteProxy,
	fetchProxies,
	testProxy,
	updateProxy,
	updateWebPolicy,
	webFetch,
} from "./api.js";
import { Dropdown } from "./Dropdown.js";
import { Icon } from "./Icons.js";
import { LoadingBanner } from "./LoadingBanner.js";

const PROVIDER_HELP: Record<ProxyKind, string> = {
	zenrows:
		"Gets pages that block plain requests, with rotating proxies, a browser, and anti-bot handling. With Auto, ZenRows picks the setting and bills only the one that worked.",
	"cloudflare-browser":
		"Renders pages that need JavaScript in a browser on Cloudflare's network. It cannot get past CAPTCHAs or bot protection, so it is only tried for pages that load but stay empty.",
	brightdata:
		"A second unblocker, for pages the first one could not get. Billed per successful request.",
};
const KEY_LABELS: Record<ProxyKind, string> = {
	zenrows: "API key",
	"cloudflare-browser": "API token",
	brightdata: "API key",
};
const LEVEL_LABELS: Record<ProxyLevel, string> = {
	auto: "Auto",
	basic: "Basic",
	render: "Render JavaScript",
	premium: "Premium proxies",
	"render-premium": "Render and premium",
	unlock: "Unlock",
};
const LEVEL_COST: Record<ProxyKind, Partial<Record<ProxyLevel, string>>> = {
	zenrows: {
		auto: "1–25 credits, billed only for what worked",
		basic: "1 credit",
		render: "5 credits",
		premium: "10 credits",
		"render-premium": "25 credits",
	},
	"cloudflare-browser": { render: "billed for browser time" },
	brightdata: { unlock: "billed per successful request" },
};
const RULE_LABELS: Record<WebDomainRule["rule"], string> = {
	deny: "Never fetch",
	"start-at-proxy": "Start at the first proxy",
	"direct-only": "Plain request only",
	allow: "Allow",
};
const OUTCOME_LABELS: Record<WebFetchOutcome, string> = {
	ok: "OK",
	blocked: "Blocked",
	"needs-render": "Needs JavaScript",
	"not-found": "Not found",
	"target-error": "Site error",
	"provider-error": "Provider error",
	timeout: "Timed out",
	skipped: "Skipped",
};
/** A country only changes where ZenRows and Bright Data send the request from. */
const USES_COUNTRY: Record<ProxyKind, boolean> = {
	zenrows: true,
	"cloudflare-browser": false,
	brightdata: true,
};
const ACCOUNT_PATTERN = /^[a-fA-F0-9]{32}$/;
/** The name a new connection starts with, until someone types one. */
const SUGGESTED_NAMES: Record<ProxyKind, string> = {
	zenrows: "zenrows",
	"cloudflare-browser": "cloudflare",
	brightdata: "brightdata",
};
const HOST_PATTERN =
	/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const count = (value: number) => value.toLocaleString();
/** Dollars with cents, or with more places for the fractions of a cent requests cost. */
export function usd(value: number): string {
	if (value === 0) return "$0";
	if (value >= 0.01) return `$${value.toFixed(2)}`;
	return `$${Number(value.toPrecision(2))}`;
}
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

/** What a step fixes and costs, in words. */
function stepHint(step: WebStep, connections: ProxyConnection[]): string {
	if (step.kind === "direct") return "Plain request · free";
	const connection = connections.find((item) => item.name === step.connection);
	if (!connection) return "This connection no longer exists.";
	const fixes = levelFixes(connection.kind, step.level);
	const words =
		fixes.length === 2
			? "Gets past blocks and renders JavaScript"
			: fixes[0] === "blocked"
				? "Gets past blocks"
				: "Renders JavaScript";
	const cost = LEVEL_COST[connection.kind][step.level];
	return `${words}${cost ? ` · ${cost}` : ""}${connection.enabled ? "" : " · switched off"}`;
}

/** A host typed as a URL, with a wildcard, or in capitals, as a rule's match. */
export function normalizeHost(value: string): string {
	let host = value.trim().toLowerCase();
	host = host.replace(/^[a-z]+:\/\//, "");
	host = host.split(/[/?#]/)[0] ?? "";
	host = host.replace(/^\*\./, "").replace(/^\./, "").replace(/\.$/, "");
	return host;
}

/** Why the policy cannot be saved, checked against the gateway's limits. */
export function policyProblem(policy: WebPolicy): string | null {
	if (policy.ladder.length === 0) return "The ladder needs at least one step.";
	if (policy.ladder.length > WEB_LIMITS.ladderSteps)
		return `The ladder has at most ${WEB_LIMITS.ladderSteps} steps.`;
	if (policy.domains.length > WEB_LIMITS.domainRules)
		return `At most ${WEB_LIMITS.domainRules} domain rules.`;
	const people = policy.callerProxyRequestsPerDay;
	if (
		!Number.isInteger(people) ||
		people < 0 ||
		people > WEB_LIMITS.maxCallerProxyRequestsPerDay
	)
		return `Proxied requests a day is a whole number from 0 to ${count(WEB_LIMITS.maxCallerProxyRequestsPerDay)}.`;
	const budget = policy.monthlyBudgetUsd;
	if (
		!Number.isFinite(budget) ||
		budget < 0 ||
		budget > WEB_LIMITS.maxMonthlyBudgetUsd
	)
		return `The monthly budget is from $0 to $${count(WEB_LIMITS.maxMonthlyBudgetUsd)}.`;
	return null;
}

/** Adds a connection, or edits one that was saved in the dashboard. */
function ProxyForm({
	existing,
	taken,
	persistence,
	onSaved,
	onClose,
}: {
	existing?: ProxyConnection;
	taken: string[];
	persistence: ProxyList["persistence"];
	onSaved(connection: ProxyConnection, addToLadder: boolean): void;
	onClose(): void;
}) {
	const id = useId();
	const [kind, setKind] = useState<ProxyKind>(existing?.kind ?? "zenrows");
	const [name, setName] = useState(existing?.name ?? SUGGESTED_NAMES.zenrows);
	const [nameTouched, setNameTouched] = useState(false);
	const [apiKey, setApiKey] = useState("");
	const [accountId, setAccountId] = useState(existing?.accountId ?? "");
	const [zone, setZone] = useState(existing?.zone ?? "");
	const [price, setPrice] = useState(String(existing?.pricePer1000Usd ?? 1.5));
	const [country, setCountry] = useState(existing?.country ?? "");
	const [cap, setCap] = useState(
		existing?.monthlyRequestCap == null
			? ""
			: String(existing.monthlyRequestCap),
	);
	const [addToLadder, setAddToLadder] = useState(true);
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
		if (!existing && !PROXY_NAME_PATTERN.test(trimmedName))
			return "Use a lowercase letter first, then up to 63 lowercase letters, numbers, dashes or underscores.";
		if (nameTaken) return "This name is already in use.";
		if (!existing && !apiKey.trim())
			return `Enter the ${KEY_LABELS[kind].toLowerCase()}.`;
		if (kind === "cloudflare-browser" && !ACCOUNT_PATTERN.test(accountId))
			return "Enter the 32-character Cloudflare account ID.";
		if (kind === "brightdata" && !zone.trim())
			return "Enter the Web Unlocker zone name.";
		if (kind === "brightdata") {
			const value = Number(price);
			if (!price.trim() || !Number.isFinite(value) || value < 0)
				return "Enter what 1,000 requests cost on your plan.";
		}
		if (country && USES_COUNTRY[kind] && !COUNTRY_PATTERN.test(country))
			return "A country is two letters, such as us or de.";
		if (cap.trim()) {
			const value = Number(cap);
			if (
				!Number.isInteger(value) ||
				value < 0 ||
				value > WEB_LIMITS.maxMonthlyRequestCap
			)
				return `The cap is a whole number up to ${count(WEB_LIMITS.maxMonthlyRequestCap)}.`;
		}
		return null;
	})();
	const shared = {
		...(kind === "cloudflare-browser" ? { accountId: accountId.trim() } : {}),
		...(kind === "brightdata"
			? { zone: zone.trim(), pricePer1000Usd: Number(price) }
			: {}),
		monthlyRequestCap: cap.trim() ? Number(cap) : null,
	};
	return (
		<section className="card add-model-card" aria-labelledby={`${id}-title`}>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>
						{existing ? `Edit ${existing.name}` : "Add a proxy"}
					</h2>
					<p className="card-note">{PROVIDER_HELP[kind]}</p>
				</div>
				<button
					className="icon-button"
					type="button"
					aria-label={existing ? "Close edit proxy" : "Close add proxy"}
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
						if (existing) {
							const input: UpdateProxyRequest = {
								...shared,
								...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
								// An empty country clears it.
								...(USES_COUNTRY[kind] ? { country: country.trim() } : {}),
							};
							onSaved(await updateProxy(existing.name, input), false);
						} else {
							const input: CreateProxyRequest = {
								name: trimmedName,
								kind,
								apiKey: apiKey.trim(),
								...shared,
								...(USES_COUNTRY[kind] && country.trim()
									? { country: country.trim() }
									: {}),
							};
							onSaved(await createProxy(input), addToLadder);
						}
						setApiKey("");
					} catch (cause) {
						setError(errorText(cause, "Could not save the proxy."));
					} finally {
						setSaving(false);
					}
				}}
			>
				<fieldset disabled={saving}>
					<div className="model-form-grid">
						{existing ? (
							<p className="field-hint">
								{PROXY_KIND_LABELS[existing.kind]} · {existing.name}
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
											const next = value as ProxyKind;
											if (!nameTouched) setName(SUGGESTED_NAMES[next]);
											setKind(next);
											setError("");
										}}
									>
										{PROXY_KINDS.map((item) => (
											<option key={item} value={item}>
												{PROXY_KIND_LABELS[item]}
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
											: "Lowercase letters, numbers, dashes or underscores. Shown in the ladder and on each fetch."}
									</span>
								</div>
							</>
						)}
						{kind === "cloudflare-browser" && (
							<div className="form-field">
								<label htmlFor={`${id}-account`}>Cloudflare Account ID</label>
								<input
									id={`${id}-account`}
									value={accountId}
									required
									maxLength={32}
									placeholder="32-character account ID"
									onChange={(event) => setAccountId(event.target.value)}
								/>
							</div>
						)}
						{kind === "brightdata" && (
							<>
								<div className="form-field">
									<label htmlFor={`${id}-zone`}>Zone</label>
									<input
										id={`${id}-zone`}
										value={zone}
										required
										maxLength={100}
										placeholder="web_unlocker1"
										onChange={(event) => setZone(event.target.value)}
									/>
									<span className="field-hint">
										The name of your Web Unlocker zone.
									</span>
								</div>
								<div className="form-field">
									<label htmlFor={`${id}-price`}>
										Price per 1,000 requests (USD)
									</label>
									<input
										id={`${id}-price`}
										type="number"
										min={0}
										step={0.01}
										value={price}
										onChange={(event) => setPrice(event.target.value)}
									/>
									<span className="field-hint">
										Used to count spend against the monthly budget.
									</span>
								</div>
							</>
						)}
						<div className="form-field key-field">
							<label htmlFor={`${id}-key`}>
								{KEY_LABELS[kind]}{" "}
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
								maxLength={WEB_LIMITS.keyLength}
								placeholder={
									existing
										? "Leave blank to keep the saved key"
										: `Enter your ${PROXY_KIND_LABELS[kind]} ${KEY_LABELS[kind].toLowerCase()}`
								}
								onChange={(event) => {
									setApiKey(event.target.value);
									setError("");
								}}
								aria-describedby={`${id}-key-help`}
							/>
							<span className="field-hint" id={`${id}-key-help`}>
								{kind === "cloudflare-browser"
									? "A token with the Browser Run Edit permission. "
									: ""}
								Keys stay on the server and are never shown again.
							</span>
						</div>
						{USES_COUNTRY[kind] && (
							<div className="form-field">
								<label htmlFor={`${id}-country`}>
									Country <span className="field-hint">(optional)</span>
								</label>
								<input
									id={`${id}-country`}
									value={country}
									maxLength={2}
									placeholder="us"
									onChange={(event) =>
										setCountry(event.target.value.toLowerCase())
									}
								/>
								<span className="field-hint">
									Where requests appear to come from. Two letters.
								</span>
							</div>
						)}
						<div className="form-field">
							<label htmlFor={`${id}-cap`}>
								Monthly request cap{" "}
								<span className="field-hint">(optional)</span>
							</label>
							<input
								id={`${id}-cap`}
								type="number"
								min={0}
								step={1}
								value={cap}
								placeholder="No cap"
								onChange={(event) => setCap(event.target.value)}
							/>
							<span className="field-hint">
								Requests through this connection in a calendar month. The
								workspace's monthly budget applies either way.
							</span>
						</div>
					</div>
					{!existing && (
						<label className="failover-enable">
							<input
								type="checkbox"
								checked={addToLadder}
								onChange={(event) => setAddToLadder(event.target.checked)}
							/>
							Add it to the ladder
							<span className="field-hint">
								As {name.trim() || "it"}:{DEFAULT_PROXY_LEVEL[kind]}, after the
								current steps.
							</span>
						</label>
					)}
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
							{saving ? "Saving…" : existing ? "Save changes" : "Add proxy"}
						</button>
					</div>
				</fieldset>
			</form>
		</section>
	);
}

/** Each attempt a fetch made, what came of it, and the page it got. */
export function FetchResultView({
	result,
	title,
}: {
	result: WebFetchResult;
	title: string;
}) {
	const id = useId();
	return (
		<section className="proxy-result" aria-labelledby={id}>
			<h3 id={id}>{title}</h3>
			<p role="status">
				{result.ok ? (
					<>
						Fetched <code>{result.finalUrl}</code> ({result.status}
						{result.contentType ? `, ${result.contentType}` : ""}) via{" "}
						<strong>{result.cached ? "cache" : result.via}</strong>.
					</>
				) : (
					<>Nothing fetched. {result.reason ?? ""}</>
				)}{" "}
				Cost: {usd(result.costUsd)}.
			</p>
			{result.attempts.length > 0 && (
				<div className="table-scroll">
					<table className="models-table proxy-attempts">
						<thead>
							<tr>
								<th>Step</th>
								<th>Outcome</th>
								<th>Status</th>
								<th>Time</th>
								<th>Cost</th>
								<th>Detail</th>
							</tr>
						</thead>
						<tbody>
							{result.attempts.map((attempt, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: attempts are in order and never move
								<tr key={index}>
									<td>
										<code>{stepLabel(attempt.step)}</code>
									</td>
									<td>
										<span className={`proxy-outcome ${attempt.outcome}`}>
											{OUTCOME_LABELS[attempt.outcome]}
										</span>
									</td>
									<td>{attempt.status ?? "—"}</td>
									<td>{(attempt.latencyMs / 1000).toFixed(1)} s</td>
									<td>{usd(attempt.costUsd)}</td>
									<td>{attempt.detail ?? ""}</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			)}
			{result.ok && (
				<>
					<p className="field-hint">
						{result.format === "markdown" ? "Markdown" : "HTML"},{" "}
						{count(result.content.length)} characters
						{result.truncated ? ", cut short" : ""}.
					</p>
					{/* Shown as text: a fetched page is never rendered here. */}
					<section className="proxy-preview" aria-label="Fetched content">
						<pre>{result.content}</pre>
					</section>
				</>
			)}
		</section>
	);
}

/** One billable request through one connection, at a level the admin picks. */
function TestPanel({
	connection,
	onClose,
	onDone,
}: {
	connection: ProxyConnection;
	onClose(): void;
	onDone(): void;
}) {
	const id = useId();
	const levels = PROXY_LEVELS[connection.kind];
	const [url, setUrl] = useState("");
	const [level, setLevel] = useState<ProxyLevel>(
		DEFAULT_PROXY_LEVEL[connection.kind],
	);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<WebFetchResult | null>(null);
	const [error, setError] = useState("");
	return (
		<section className="card" aria-labelledby={`${id}-title`}>
			<div className="section-heading">
				<div>
					<h2 id={`${id}-title`}>Test {connection.name}</h2>
					<p className="card-note">
						This is a real request through {PROXY_KIND_LABELS[connection.kind]},
						billed like any other. Leave the address empty to fetch a neutral
						page.
					</p>
				</div>
				<button
					className="icon-button"
					type="button"
					aria-label="Close test"
					onClick={onClose}
					disabled={running}
				>
					<Icon name="close" />
				</button>
			</div>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					setRunning(true);
					setError("");
					setResult(null);
					try {
						setResult(
							await testProxy(connection.name, {
								...(url.trim() ? { url: url.trim() } : {}),
								level,
							}),
						);
						onDone();
					} catch (cause) {
						setError(errorText(cause, "The test could not run."));
					} finally {
						setRunning(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={running}>
					<div className="routing-add">
						<div className="form-field">
							<label htmlFor={`${id}-url`}>Address</label>
							<input
								id={`${id}-url`}
								type="url"
								value={url}
								maxLength={WEB_LIMITS.urlLength}
								placeholder="https://example.com"
								onChange={(event) => setUrl(event.target.value)}
							/>
						</div>
						{levels.length > 1 && (
							<div className="form-field">
								<label htmlFor={`${id}-level`}>Level</label>
								<Dropdown
									id={`${id}-level`}
									value={level}
									onValueChange={(value) => setLevel(value as ProxyLevel)}
								>
									{levels.map((item) => (
										<option key={item} value={item}>
											{LEVEL_LABELS[item]}
										</option>
									))}
								</Dropdown>
							</div>
						)}
						<button className="button primary" type="submit">
							{running ? "Testing…" : "Run billable test"}
						</button>
					</div>
				</fieldset>
			</form>
			{error && (
				<p className="banner-error" role="alert">
					{error}
				</p>
			)}
			{result && (
				<FetchResultView result={result} title={`Test of ${connection.name}`} />
			)}
		</section>
	);
}

/** The fetch an agent gets, run from the dashboard. */
function TryUrl({ onDone }: { onDone(): void }) {
	const id = useId();
	const [url, setUrl] = useState("");
	const [skipDirect, setSkipDirect] = useState(false);
	const [render, setRender] = useState(false);
	const [running, setRunning] = useState(false);
	const [result, setResult] = useState<WebFetchResult | null>(null);
	const [error, setError] = useState("");
	return (
		<section className="card" aria-labelledby={`${id}-title`}>
			<h2 id={`${id}-title`}>Try a URL</h2>
			<p className="card-note">
				Runs the same fetch an agent gets, with the saved ladder: a plain
				request first, then each proxy as far as needed. Proxied requests are
				billed and count against your limits. Save ladder changes before trying.
			</p>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (!url.trim()) return;
					setRunning(true);
					setError("");
					setResult(null);
					try {
						setResult(
							await webFetch({
								url: url.trim(),
								...(skipDirect ? { skipDirect } : {}),
								...(render ? { render } : {}),
							}),
						);
						onDone();
					} catch (cause) {
						setError(errorText(cause, "The fetch could not run."));
					} finally {
						setRunning(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={running}>
					<div className="routing-add">
						<div className="form-field">
							<label htmlFor={`${id}-url`}>Address to fetch</label>
							<input
								id={`${id}-url`}
								type="url"
								required
								value={url}
								maxLength={WEB_LIMITS.urlLength}
								placeholder="https://example.com/pricing"
								onChange={(event) => setUrl(event.target.value)}
							/>
						</div>
						<button
							className="button primary"
							type="submit"
							disabled={!url.trim()}
						>
							{running ? "Fetching…" : "Fetch"}
						</button>
					</div>
					<div className="proxy-switches">
						<label className="failover-enable">
							<input
								type="checkbox"
								checked={skipDirect}
								onChange={(event) => setSkipDirect(event.target.checked)}
							/>
							Skip the plain request
						</label>
						<label className="failover-enable">
							<input
								type="checkbox"
								checked={render}
								onChange={(event) => setRender(event.target.checked)}
							/>
							Needs JavaScript
						</label>
					</div>
				</fieldset>
			</form>
			{error && (
				<p className="banner-error" role="alert">
					{error}
				</p>
			)}
			{result && <FetchResultView result={result} title="Result" />}
		</section>
	);
}

/** The ladder, domain rules, and limits, saved together with the policy's revision. */
function PolicyEditor({
	policy,
	connections,
	canEdit,
	dirty,
	saving,
	error,
	saved,
	onChange,
	onSave,
	onReload,
}: {
	policy: WebPolicy;
	connections: ProxyConnection[];
	canEdit: boolean;
	dirty: boolean;
	saving: boolean;
	error: { message: string; stale: boolean } | null;
	saved: boolean;
	onChange(policy: WebPolicy): void;
	onSave(): void;
	onReload(): void;
}) {
	const id = useId();
	const [step, setStep] = useState("");
	const [host, setHost] = useState("");
	const [rule, setRule] = useState<WebDomainRule["rule"]>("deny");
	const problem = policyProblem(policy);
	const present = new Set(policy.ladder.map(stepLabel));
	const choices: Array<{ value: string; label: string; step: WebStep }> = [
		...(present.has("direct")
			? []
			: [
					{
						value: "direct",
						label: "Plain request (free)",
						step: { kind: "direct" } as WebStep,
					},
				]),
		...connections.flatMap((connection) =>
			PROXY_LEVELS[connection.kind].map((level) => {
				const item: WebStep = {
					kind: "proxy",
					connection: connection.name,
					level,
				};
				return {
					value: stepLabel(item),
					label: `${connection.name} · ${LEVEL_LABELS[level]} (${LEVEL_COST[connection.kind][level] ?? ""})`,
					step: item,
				};
			}),
		),
	].filter((choice) => !present.has(choice.value));
	const normalized = normalizeHost(host);
	const hostProblem = !host.trim()
		? null
		: !HOST_PATTERN.test(normalized)
			? "Enter a host such as example.com."
			: policy.domains.some((item) => item.match === normalized)
				? "This domain already has a rule."
				: null;
	const move = (index: number, by: -1 | 1) => {
		const ladder = [...policy.ladder];
		[ladder[index], ladder[index + by]] = [ladder[index + by], ladder[index]];
		onChange({ ...policy, ladder });
	};
	return (
		<form
			className="card"
			aria-labelledby={`${id}-title`}
			onSubmit={(event) => {
				event.preventDefault();
				if (!problem && dirty) onSave();
			}}
		>
			<h2 id={`${id}-title`}>Ladder</h2>
			<p className="card-note">
				Each fetch tries these steps in order and stops at the first that gets
				the page. A step is skipped when it cannot fix what went wrong: a
				renderer is only tried for pages that need JavaScript, never for a
				block.
			</p>
			<fieldset className="routing-fields" disabled={!canEdit || saving}>
				<ol className="routing-list proxy-ladder" aria-label="Ladder steps">
					{policy.ladder.map((item, index) => {
						const label = stepLabel(item);
						return (
							<li key={label}>
								<code>{label}</code>{" "}
								<span className="field-hint">
									{stepHint(item, connections)}
								</span>
								{canEdit && (
									<div className="routing-row-actions">
										<button
											className="button"
											type="button"
											aria-label={`Move ${label} up`}
											disabled={index === 0}
											onClick={() => move(index, -1)}
										>
											↑
										</button>
										<button
											className="button"
											type="button"
											aria-label={`Move ${label} down`}
											disabled={index === policy.ladder.length - 1}
											onClick={() => move(index, 1)}
										>
											↓
										</button>
										<button
											className="button"
											type="button"
											aria-label={`Remove step ${label}`}
											onClick={() =>
												onChange({
													...policy,
													ladder: policy.ladder.filter(
														(other) => stepLabel(other) !== label,
													),
												})
											}
										>
											Remove
										</button>
									</div>
								)}
							</li>
						);
					})}
				</ol>
				{canEdit && (
					<div className="routing-add">
						<div className="form-field">
							<label htmlFor={`${id}-step`}>Step to add</label>
							<Dropdown
								id={`${id}-step`}
								value={step}
								onValueChange={(value) => setStep(value)}
							>
								<option value="">
									{choices.length ? "Choose a step…" : "Every step is added"}
								</option>
								{choices.map((choice) => (
									<option key={choice.value} value={choice.value}>
										{choice.label}
									</option>
								))}
							</Dropdown>
						</div>
						<button
							className="button"
							type="button"
							disabled={!step || policy.ladder.length >= WEB_LIMITS.ladderSteps}
							onClick={() => {
								const choice = choices.find((item) => item.value === step);
								if (!choice) return;
								onChange({
									...policy,
									ladder: [...policy.ladder, choice.step],
								});
								setStep("");
							}}
						>
							Add step
						</button>
					</div>
				)}

				<h3>Domain rules</h3>
				<p className="card-note">
					A rule matches its host and every subdomain.
				</p>
				{policy.domains.length === 0 ? (
					<p className="card-note">No domain rules.</p>
				) : (
					<ul className="proxy-rules" aria-label="Domain rules">
						{policy.domains.map((item) => (
							<li key={item.match}>
								<code>{item.match}</code>
								{canEdit ? (
									<>
										<Dropdown
											aria-label={`Rule for ${item.match}`}
											value={item.rule}
											onValueChange={(value) =>
												onChange({
													...policy,
													domains: policy.domains.map((other) =>
														other.match === item.match
															? {
																	...other,
																	rule: value as WebDomainRule["rule"],
																}
															: other,
													),
												})
											}
										>
											{Object.entries(RULE_LABELS).map(([value, label]) => (
												<option key={value} value={value}>
													{label}
												</option>
											))}
										</Dropdown>
										<button
											className="button"
											type="button"
											aria-label={`Remove rule for ${item.match}`}
											onClick={() =>
												onChange({
													...policy,
													domains: policy.domains.filter(
														(other) => other.match !== item.match,
													),
												})
											}
										>
											Remove
										</button>
									</>
								) : (
									<span>{RULE_LABELS[item.rule]}</span>
								)}
							</li>
						))}
					</ul>
				)}
				{canEdit && (
					<div className="routing-add">
						<div className="form-field">
							<label htmlFor={`${id}-host`}>Domain</label>
							<input
								id={`${id}-host`}
								value={host}
								placeholder="example.com"
								maxLength={253}
								onChange={(event) => setHost(event.target.value)}
								aria-describedby={`${id}-host-help`}
							/>
							<span className="field-hint" id={`${id}-host-help`}>
								{hostProblem ?? ""}
							</span>
						</div>
						<div className="form-field">
							<label htmlFor={`${id}-rule`}>Rule</label>
							<Dropdown
								id={`${id}-rule`}
								value={rule}
								onValueChange={(value) =>
									setRule(value as WebDomainRule["rule"])
								}
							>
								{Object.entries(RULE_LABELS).map(([value, label]) => (
									<option key={value} value={value}>
										{label}
									</option>
								))}
							</Dropdown>
						</div>
						<button
							className="button"
							type="button"
							disabled={
								!host.trim() ||
								Boolean(hostProblem) ||
								policy.domains.length >= WEB_LIMITS.domainRules
							}
							onClick={() => {
								onChange({
									...policy,
									domains: [...policy.domains, { match: normalized, rule }],
								});
								setHost("");
							}}
						>
							Add rule
						</button>
					</div>
				)}
				<label className="failover-enable">
					<input
						type="checkbox"
						checked={policy.allowOnly}
						onChange={(event) =>
							onChange({ ...policy, allowOnly: event.target.checked })
						}
					/>
					Only fetch listed domains
					<span className="field-hint">
						Every domain without a rule, or with Never fetch, is refused.
					</span>
				</label>

				<h3>Limits</h3>
				<div className="model-form-grid">
					<div className="form-field">
						<label htmlFor={`${id}-people`}>Proxied requests a day</label>
						<input
							id={`${id}-people`}
							type="number"
							required
							min={0}
							max={WEB_LIMITS.maxCallerProxyRequestsPerDay}
							step={1}
							value={policy.callerProxyRequestsPerDay}
							onChange={(event) =>
								onChange({
									...policy,
									callerProxyRequestsPerDay: Number(event.target.value),
								})
							}
						/>
						<span className="field-hint">
							For each person, API token, and agent, counted from 00:00 UTC.
							Agents with instructions use their own limit.
						</span>
					</div>
					<div className="form-field">
						<label htmlFor={`${id}-budget`}>Monthly budget (USD)</label>
						<input
							id={`${id}-budget`}
							type="number"
							required
							min={0}
							max={WEB_LIMITS.maxMonthlyBudgetUsd}
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
							What every proxy together may spend in a calendar month (UTC).
							Proxied requests stop once it is reached.
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
							{saving ? "Saving…" : "Save ladder and limits"}
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

export function ProxiesView({
	workspace,
}: {
	workspace?: { isDefault: boolean; role?: "admin" | "member" };
} = {}) {
	// Members see the proxies and the ladder; admins change them and spend on them.
	const canEdit = workspace?.role !== "member";
	const [list, setList] = useState<ProxyList | null>(null);
	const [draft, setDraft] = useState<WebPolicy | null>(null);
	const [dirty, setDirty] = useState(false);
	const dirtyRef = useRef(false);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");
	const [panel, setPanel] = useState<
		| { kind: "add" }
		| { kind: "edit"; name: string }
		| { kind: "test"; name: string }
		| null
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
	const editDraft = (next: WebPolicy) => {
		setDraft(next);
		setDirty(true);
		dirtyRef.current = true;
		setSaved(false);
		setSaveError(null);
	};
	const refresh = useCallback(async (discard = false) => {
		const request = ++sequence.current;
		setLoading(true);
		try {
			const next = await fetchProxies();
			if (request !== sequence.current) return;
			setList(next);
			setError("");
			// Unsaved ladder edits survive a refresh unless they are thrown away.
			if (discard || !dirtyRef.current) {
				setDraft(next.policy);
				setDirty(false);
				dirtyRef.current = false;
			}
		} catch (cause) {
			if (request !== sequence.current) return;
			setError(
				errorText(
					cause,
					"Could not load proxies. Check the API connection and try again.",
				),
			);
		} finally {
			if (request === sequence.current) setLoading(false);
		}
	}, []);
	useEffect(() => {
		void refresh();
		return () => {
			sequence.current++;
		};
	}, [refresh]);
	const savePolicy = async (policy: WebPolicy) => {
		setSaving(true);
		setSaveError(null);
		try {
			const { revision, ...rest } = policy;
			const next = await updateWebPolicy({ ...rest, revision });
			setList((current) => (current ? { ...current, policy: next } : current));
			setDraft(next);
			setDirty(false);
			dirtyRef.current = false;
			setSaved(true);
			return true;
		} catch (cause) {
			setSaveError(
				cause instanceof ApiError && cause.status === 409
					? {
							message:
								"The ladder changed elsewhere since you opened it. Reload to see the latest, then make your change again.",
							stale: true,
						}
					: {
							message: errorText(cause, "Could not save the ladder."),
							stale: false,
						},
			);
			return false;
		} finally {
			setSaving(false);
		}
	};
	const closePanel = () => {
		setPanel(null);
		addButton.current?.focus();
	};
	const connections = list?.connections ?? [];
	const testing =
		panel?.kind === "test"
			? connections.find((item) => item.name === panel.name)
			: undefined;
	const editing =
		panel?.kind === "edit"
			? connections.find((item) => item.name === panel.name)
			: undefined;
	const requests = connections.reduce(
		(total, item) => total + item.usage.requests,
		0,
	);

	return (
		<div className="dashboard models-page proxies-page">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">Gateway</p>
					<h1>Proxies</h1>
					<p className="page-description">
						Services agents' web fetches go through when a site blocks plain
						requests or needs a browser.
					</p>
				</div>
				{canEdit ? (
					<button
						ref={addButton}
						className="button primary"
						type="button"
						disabled={!list || panel?.kind === "add"}
						onClick={() => {
							setPanel({ kind: "add" });
							setNotice("");
						}}
					>
						<Icon name="plus" /> Add proxy
					</button>
				) : (
					<p className="card-note">
						Ask a workspace admin to add proxies or change the ladder.
					</p>
				)}
			</header>
			{list && !list.available && (
				<p className="banner-warning" role="status">
					Web access is turned off on this gateway. Agents cannot fetch pages
					until its operator turns it back on.
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
			{list && (
				<p className="card-note">
					{list.persistence === "mongodb"
						? "Proxy settings are saved in MongoDB."
						: "Proxy settings are temporary and last until the API restarts. Connect MongoDB to keep them."}
				</p>
			)}
			{panel?.kind === "add" && list && (
				<ProxyForm
					taken={connections.map((item) => item.name)}
					persistence={list.persistence}
					onClose={closePanel}
					onSaved={async (connection, addToLadder) => {
						closePanel();
						let message = `Added ${connection.name}.`;
						if (addToLadder) {
							const step: WebStep = {
								kind: "proxy",
								connection: connection.name,
								level: DEFAULT_PROXY_LEVEL[connection.kind],
							};
							if (dirtyRef.current && draft) {
								// Unsaved ladder edits stay; the new step joins them.
								editDraft({ ...draft, ladder: [...draft.ladder, step] });
								message += " It is in the ladder below: save to use it.";
							} else if (
								list.policy.ladder.length < WEB_LIMITS.ladderSteps &&
								(await savePolicy({
									...list.policy,
									ladder: [...list.policy.ladder, step],
								}))
							)
								message += ` Fetches can now use ${stepLabel(step)}.`;
							else message += " Add it to the ladder below to use it.";
						}
						setNotice(message);
						await refresh();
					}}
				/>
			)}
			{editing && list && (
				<ProxyForm
					key={editing.name}
					existing={editing}
					taken={[]}
					persistence={list.persistence}
					onClose={closePanel}
					onSaved={async (connection) => {
						closePanel();
						setNotice(`Saved ${connection.name}.`);
						await refresh();
					}}
				/>
			)}
			<section className="models-overview" aria-label="Proxy overview">
				<div>
					<span className="overview-value">
						{list
							? `${usd(list.budget.spentUsd)} / ${usd(list.budget.limitUsd)}`
							: "—"}
					</span>
					<span>Spent this month</span>
				</div>
				<div>
					<span className="overview-value">{list ? count(requests) : "—"}</span>
					<span>Proxied requests this month</span>
				</div>
				<div>
					<span className="overview-value">
						{list ? connections.length : "—"}
					</span>
					<span>Connections</span>
				</div>
			</section>
			<section
				className="card active-models"
				aria-labelledby="proxy-connections-heading"
				aria-busy={loading && Boolean(list)}
			>
				<div className="section-heading">
					<div>
						<h2 id="proxy-connections-heading">Connections</h2>
						<p className="card-note">
							Keys stay on the server. A fetch uses a connection only when it is
							in the ladder.
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
				{!list ? (
					<div className="models-empty">
						{loading ? (
							<LoadingBanner>Loading proxies…</LoadingBanner>
						) : (
							"Proxies could not be loaded."
						)}
					</div>
				) : connections.length === 0 ? (
					<div className="models-empty">
						<span className="empty-icon">
							<Icon name="proxies" />
						</span>
						<h3>No proxies yet</h3>
						<p>
							Agents fetch pages with a plain request. Add a proxy for sites
							that block them.
						</p>
						{workspace && !workspace.isDefault && (
							<p className="field-hint">
								This workspace starts with no proxies. Keys set as environment
								variables belong to the Default workspace.
							</p>
						)}
					</div>
				) : (
					<div className="table-scroll">
						<table className="models-table proxy-table">
							<thead>
								<tr>
									<th>Connection</th>
									<th>Key</th>
									<th>Country</th>
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
													<Icon name="proxies" />
												</span>
												<span>
													<strong>{item.name}</strong>
													<span className="field-hint">
														{PROXY_KIND_LABELS[item.kind]}
														{item.source === "environment" &&
															" · environment variable"}
													</span>
													{item.source === "environment" && canEdit && (
														<span className="field-hint">
															Set on the server, so it is changed there. Take it
															out of the ladder to stop using it.
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
										<td>{item.country ? item.country.toUpperCase() : "—"}</td>
										<td>
											{count(item.usage.requests)}
											{item.monthlyRequestCap != null &&
												` / ${count(item.monthlyRequestCap)}`}{" "}
											requests · {usd(item.usage.costUsd)}
										</td>
										<td>
											{canEdit ? (
												<div className="proxy-actions">
													{item.source === "saved" ? (
														<label className="failover-enable">
															<input
																type="checkbox"
																aria-label={`Use ${item.name}`}
																checked={item.enabled}
																onChange={async (event) => {
																	setRowError("");
																	try {
																		await updateProxy(item.name, {
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
													) : (
														<span
															className="chip"
															title="Set on the server. Take it out of the ladder to stop using it."
														>
															<span
																className={`dot ${item.enabled ? "dot-good" : "dot-muted"}`}
															/>
															{item.enabled ? "On" : "Off"}
														</span>
													)}
													<button
														className="button"
														type="button"
														aria-label={`Test ${item.name}`}
														onClick={() => {
															setPanel({ kind: "test", name: item.name });
															setNotice("");
														}}
													>
														Test
													</button>
													{item.source === "saved" && (
														<>
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
																				await deleteProxy(item.name);
																				setConfirming(null);
																				setNotice(
																					`Deleted ${item.name} and took it out of the ladder.`,
																				);
																				if (
																					panel &&
																					"name" in panel &&
																					panel.name === item.name
																				)
																					setPanel(null);
																				await refresh(true);
																			} catch (cause) {
																				setRowError(
																					errorText(
																						cause,
																						"Could not delete it.",
																					),
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
														</>
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
			{testing && canEdit && (
				<TestPanel
					key={testing.name}
					connection={testing}
					onClose={closePanel}
					onDone={() => void refresh()}
				/>
			)}
			{draft && (
				<PolicyEditor
					policy={draft}
					connections={connections}
					canEdit={canEdit}
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
			{canEdit && list && <TryUrl onDone={() => void refresh()} />}
		</div>
	);
}
