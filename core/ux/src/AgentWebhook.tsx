import {
	AGENT_WEBHOOK_EVENT_HINTS,
	AGENT_WEBHOOK_EVENTS,
	AGENT_WEBHOOK_LIMITS,
	type AgentWebhook,
	type AgentWebhookEventGroup,
	type AgentWebhookHeader,
	type AgentWebhookSecret,
	type AgentWebhookTestResult,
	agentWebhookUrlProblem,
	CLAUDE_ROUTINE_HEADER,
	DEFAULT_AGENT_WEBHOOK_EVENTS,
	isClaudeRoutineUrl,
	type UpdateAgentWebhookRequest,
} from "@autonomo.us/common";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
	createAgentWebhook,
	deleteAgentWebhook,
	fetchAgentWebhook,
	rotateAgentWebhookSecret,
	testAgentWebhook,
	updateAgentWebhook,
} from "./api.js";

const date = (value: string | null) =>
	value ? new Date(value).toLocaleString() : "Never";
const errorText = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;
const GROUPS = Object.keys(AGENT_WEBHOOK_EVENTS) as AgentWebhookEventGroup[];

/** What a delivery failure code means. */
export function failureText(code: string): string {
	const status = /^http_(\d+)$/.exec(code);
	if (status) return `the receiver answered ${status[1]}`;
	switch (code) {
		case "timeout":
			return `no answer within ${AGENT_WEBHOOK_LIMITS.timeoutSeconds} seconds`;
		case "network":
			return "the receiver could not be reached";
		case "blocked":
			return "the host resolves to a private address";
		case "redirect":
			return "the receiver answered with a redirect, which is not followed";
		case "interrupted":
			return "the gateway stopped while sending";
		default:
			return code;
	}
}

function statusText(webhook: AgentWebhook): string {
	if (webhook.status === "active") return "Active";
	if (webhook.status === "paused") return "Paused: nothing is sent.";
	switch (webhook.disabledReason) {
		case "gone":
			return "Stopped: the receiver answered 410 Gone.";
		case "agent-revoked":
			return "Stopped: the agent was revoked.";
		default:
			return `Stopped: ${AGENT_WEBHOOK_LIMITS.failedDeliveriesBeforeDisable} deliveries in a row failed.`;
	}
}

function testText(result: AgentWebhookTestResult): string {
	return result.ok
		? `Test delivered: the receiver answered ${result.status} in ${result.durationMs} ms.`
		: `Test failed: ${failureText(result.error ?? "network")}.`;
}

/** The signing secret, shown once after it is made. */
function WebhookSecret({
	value,
	onDismiss,
}: {
	value: AgentWebhookSecret;
	onDismiss(): void;
}) {
	const id = useId();
	const input = useRef<HTMLTextAreaElement>(null);
	const [notice, setNotice] = useState("");
	useEffect(() => {
		input.current?.focus();
		input.current?.select();
	}, []);
	return (
		<div className="synapse-inline-form">
			<p id={id}>
				<strong>Save the signing secret.</strong> This is the only time it is
				shown. Your receiver uses it to check that each POST came from this
				gateway (Standard Webhooks, <code>webhook-signature</code>). A Claude
				Code routine does not need it.
			</p>
			<div className="form-field">
				<label htmlFor={`${id}-secret`}>Signing secret</label>
				<textarea
					ref={input}
					id={`${id}-secret`}
					value={value.secret}
					readOnly
					spellCheck={false}
					rows={2}
				/>
			</div>
			<div className="form-actions">
				<button
					className="button"
					type="button"
					onClick={async () => {
						try {
							await navigator.clipboard.writeText(value.secret);
							setNotice("Secret copied.");
						} catch {
							input.current?.focus();
							input.current?.select();
							setNotice("Copy unavailable. Select and copy the secret.");
						}
					}}
				>
					Copy secret
				</button>
				<button className="button primary" type="button" onClick={onDismiss}>
					I’ve saved this secret
				</button>
			</div>
			{notice && <p role="status">{notice}</p>}
		</div>
	);
}

type HeaderRow = AgentWebhookHeader & { key: number };

/** The settings form, to add a webhook or change one. */
function WebhookForm({
	agentId,
	webhook,
	onSaved,
	onCancel,
}: {
	agentId: string;
	/** The webhook to change; absent to add one. */
	webhook?: AgentWebhook;
	onSaved(result: { webhook: AgentWebhook; secret?: string }): void;
	onCancel(): void;
}) {
	const id = useId();
	const rowKey = useRef(0);
	const [url, setUrl] = useState(webhook?.url ?? "");
	const [events, setEvents] = useState<AgentWebhookEventGroup[]>(
		webhook?.events ?? [...DEFAULT_AGENT_WEBHOOK_EVENTS],
	);
	const [authKey, setAuthKey] = useState("");
	const [removeKey, setRemoveKey] = useState(false);
	// Saved header values are never shown, so a change replaces the list.
	const [replaceHeaders, setReplaceHeaders] = useState(!webhook);
	const [headers, setHeaders] = useState<HeaderRow[]>([]);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const routine = isClaudeRoutineUrl(url.trim());
	const routineHeader =
		headers.some(
			(header) =>
				header.name.trim().toLowerCase() === CLAUDE_ROUTINE_HEADER.name,
		) ||
		(!replaceHeaders &&
			(webhook?.headerNames ?? []).some(
				(name) => name.toLowerCase() === CLAUDE_ROUTINE_HEADER.name,
			));
	const addHeader = (header: AgentWebhookHeader = { name: "", value: "" }) =>
		setHeaders((current) => [...current, { ...header, key: rowKey.current++ }]);
	const urlProblem = url.trim() ? agentWebhookUrlProblem(url.trim()) : null;
	return (
		<form
			className="bot-form"
			onSubmit={async (event) => {
				event.preventDefault();
				if (busy) return;
				setBusy(true);
				setError("");
				const list = headers
					.filter((header) => header.name.trim() || header.value.trim())
					.map(({ name, value }) => ({
						name: name.trim(),
						value: value.trim(),
					}));
				try {
					if (webhook) {
						const input: UpdateAgentWebhookRequest = {};
						if (url.trim() !== webhook.url) input.url = url.trim();
						if (events.join() !== webhook.events.join()) input.events = events;
						if (removeKey) input.authKey = null;
						else if (authKey) input.authKey = authKey;
						if (replaceHeaders) input.headers = list.length ? list : null;
						onSaved({
							webhook: Object.keys(input).length
								? await updateAgentWebhook(agentId, input)
								: webhook,
						});
					} else
						onSaved(
							await createAgentWebhook(agentId, {
								url: url.trim(),
								events,
								...(authKey ? { authKey } : {}),
								...(list.length ? { headers: list } : {}),
							}),
						);
				} catch (cause) {
					setError(errorText(cause, "Could not save the webhook."));
					setBusy(false);
				}
			}}
		>
			<fieldset className="routing-fields" disabled={busy}>
				<div className="form-field">
					<label htmlFor={`${id}-url`}>URL</label>
					<input
						id={`${id}-url`}
						type="url"
						required
						maxLength={AGENT_WEBHOOK_LIMITS.urlLength}
						spellCheck={false}
						value={url}
						placeholder="https://api.anthropic.com/v1/claude_code/routines/trig_…/fire"
						aria-invalid={urlProblem ? true : undefined}
						onChange={(event) => setUrl(event.target.value)}
					/>
					<span className="field-hint">
						{urlProblem ??
							"An https address on a public host. For a Claude Code routine, the Fire URL of its API trigger."}
					</span>
				</div>
				{routine && (
					<p className="analytics-notice">
						This is a Claude Code routine. Put the routine’s token in{" "}
						<strong>Auth key</strong>, and send the{" "}
						<code>{CLAUDE_ROUTINE_HEADER.name}</code> header the routine needs.
						Its prompt should say to act on the{" "}
						<code>routine-fire-payload</code> block, which carries what
						happened.
						{!routineHeader && (
							<>
								{" "}
								<button
									className="button"
									type="button"
									onClick={() => {
										setReplaceHeaders(true);
										addHeader({ ...CLAUDE_ROUTINE_HEADER });
									}}
								>
									Add {CLAUDE_ROUTINE_HEADER.name}
								</button>
							</>
						)}
					</p>
				)}
				<div className="form-field">
					<label htmlFor={`${id}-key`}>Auth key</label>
					<input
						id={`${id}-key`}
						type="password"
						autoComplete="off"
						spellCheck={false}
						maxLength={AGENT_WEBHOOK_LIMITS.authKeyLength}
						value={authKey}
						disabled={removeKey}
						placeholder={
							webhook?.hasAuthKey ? "Leave blank to keep the saved key" : ""
						}
						onChange={(event) => setAuthKey(event.target.value)}
					/>
					<span className="field-hint">
						Sent as <code>Authorization: Bearer …</code> with each POST. It is
						never shown again.
					</span>
				</div>
				{webhook?.hasAuthKey && (
					<label className="bot-web-choice">
						<input
							type="checkbox"
							checked={removeKey}
							onChange={(event) => setRemoveKey(event.target.checked)}
						/>
						<span>Remove the saved auth key</span>
					</label>
				)}
				<fieldset className="bot-web-choices">
					<legend>Headers</legend>
					{!replaceHeaders && webhook ? (
						<p className="card-note">
							{webhook.headerNames.length
								? `Sends ${webhook.headerNames.join(", ")}. Values are hidden.`
								: "No custom headers."}{" "}
							<button
								className="button"
								type="button"
								onClick={() => setReplaceHeaders(true)}
							>
								Replace headers
							</button>
						</p>
					) : (
						<>
							{headers.map((header, index) => (
								<div
									className="agent-address-row agent-webhook-header"
									key={header.key}
								>
									<input
										aria-label={`Header ${index + 1} name`}
										placeholder="X-Api-Key"
										spellCheck={false}
										maxLength={AGENT_WEBHOOK_LIMITS.headerNameLength}
										value={header.name}
										onChange={(event) =>
											setHeaders((current) =>
												current.map((row) =>
													row.key === header.key
														? { ...row, name: event.target.value }
														: row,
												),
											)
										}
									/>
									<input
										aria-label={`Header ${index + 1} value`}
										type="password"
										autoComplete="off"
										spellCheck={false}
										maxLength={AGENT_WEBHOOK_LIMITS.headerValueLength}
										value={header.value}
										onChange={(event) =>
											setHeaders((current) =>
												current.map((row) =>
													row.key === header.key
														? { ...row, value: event.target.value }
														: row,
												),
											)
										}
									/>
									<button
										className="button"
										type="button"
										aria-label={`Remove header ${index + 1}`}
										onClick={() =>
											setHeaders((current) =>
												current.filter((row) => row.key !== header.key),
											)
										}
									>
										Remove
									</button>
								</div>
							))}
							{headers.length < AGENT_WEBHOOK_LIMITS.headers && (
								<button
									className="button"
									type="button"
									onClick={() => addHeader()}
								>
									Add header
								</button>
							)}
							<span className="field-hint">
								Up to {AGENT_WEBHOOK_LIMITS.headers} more headers for the
								receiver. Values are never shown again.
								{webhook && " Saving replaces the saved headers."}
							</span>
						</>
					)}
				</fieldset>
				<fieldset className="bot-web-choices">
					<legend>Wakes the agent on</legend>
					{GROUPS.map((group) => (
						<label className="bot-web-choice" key={group}>
							<input
								type="checkbox"
								checked={events.includes(group)}
								onChange={(event) =>
									setEvents((current) =>
										event.target.checked
											? GROUPS.filter(
													(item) => item === group || current.includes(item),
												)
											: current.filter((item) => item !== group),
									)
								}
							/>
							<span>
								{AGENT_WEBHOOK_EVENTS[group]}
								<span className="field-hint">
									{AGENT_WEBHOOK_EVENT_HINTS[group]}
								</span>
							</span>
						</label>
					))}
				</fieldset>
				{error && (
					<div className="banner-error" role="alert">
						{error}
					</div>
				)}
				<div className="form-actions">
					<button className="button" type="button" onClick={onCancel}>
						Cancel
					</button>
					<button
						className="button primary"
						type="submit"
						disabled={!url.trim() || Boolean(urlProblem) || !events.length}
					>
						{busy ? "Saving…" : webhook ? "Save webhook" : "Add webhook"}
					</button>
				</div>
			</fieldset>
		</form>
	);
}

/**
 * An agent's webhook: where the gateway POSTs when something should wake the
 * agent, how the last deliveries went, and the controls to change it.
 */
export function AgentWebhookCard({
	agentId,
	agentName,
	onChanged,
}: {
	agentId: string;
	agentName: string;
	/** Something was saved: the agent's history has a new line. */
	onChanged(message: string): void;
}) {
	const heading = useId();
	const [webhook, setWebhook] = useState<AgentWebhook | null | undefined>();
	const [mode, setMode] = useState<"view" | "edit" | "confirm-delete">("view");
	const [secret, setSecret] = useState<AgentWebhookSecret | null>(null);
	const [result, setResult] = useState<AgentWebhookTestResult | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const sequence = useRef(0);
	const refresh = useCallback(async () => {
		const request = ++sequence.current;
		try {
			const found = await fetchAgentWebhook(agentId);
			if (request === sequence.current) {
				setWebhook(found.webhook);
				setError("");
			}
		} catch (cause) {
			if (request === sequence.current)
				setError(errorText(cause, "Could not load the webhook."));
		}
	}, [agentId]);
	useEffect(() => {
		void refresh();
		// Deliveries change the status while the page is open.
		const timer = setInterval(() => {
			if (!document.hidden) void refresh();
		}, 15_000);
		return () => {
			sequence.current++;
			clearInterval(timer);
		};
	}, [refresh]);
	const act = async (
		work: () => Promise<void>,
		fallback: string,
	): Promise<void> => {
		setBusy(true);
		setError("");
		try {
			await work();
		} catch (cause) {
			setError(errorText(cause, fallback));
			void refresh();
		} finally {
			setBusy(false);
		}
	};
	const saved = (next: AgentWebhook, message: string) => {
		sequence.current++;
		setWebhook(next);
		setMode("view");
		onChanged(message);
	};
	return (
		<section className="card agents-card" aria-labelledby={heading}>
			<h3 id={heading}>Webhook</h3>
			<p className="card-note">
				The gateway POSTs to this address when something should wake {agentName}
				, so it reacts within seconds instead of polling. A Claude Code routine
				with an API trigger works as the receiver. Each POST says what happened
				and where, never the message text: the agent reads that over MCP.
			</p>
			{error && (
				<div className="banner-error" role="alert">
					{error}
				</div>
			)}
			{secret && (
				<WebhookSecret value={secret} onDismiss={() => setSecret(null)} />
			)}
			{webhook === undefined ? (
				<p className="card-note" role="status">
					{error ? "The webhook could not be loaded." : "Loading…"}
				</p>
			) : mode === "edit" ? (
				<WebhookForm
					agentId={agentId}
					webhook={webhook ?? undefined}
					onCancel={() => setMode("view")}
					onSaved={(next) => {
						if (next.secret)
							setSecret({ webhook: next.webhook, secret: next.secret });
						saved(
							next.webhook,
							webhook
								? `Saved the webhook of ${agentName}.`
								: `Added a webhook to ${agentName}.`,
						);
					}}
				/>
			) : webhook === null ? (
				<div className="token-actions">
					<button
						className="button primary"
						type="button"
						onClick={() => setMode("edit")}
					>
						Add webhook
					</button>
				</div>
			) : (
				<>
					<dl className="bot-facts">
						<dt>Status</dt>
						<dd className="agent-status">{statusText(webhook)}</dd>
						<dt>URL</dt>
						<dd>
							<code>{webhook.url}</code>
						</dd>
						<dt>Wakes on</dt>
						<dd>
							{webhook.events
								.map((group) => AGENT_WEBHOOK_EVENTS[group])
								.join(", ")}
						</dd>
						<dt>Auth key</dt>
						<dd>
							{webhook.hasAuthKey
								? "Sent as Authorization: Bearer (hidden)"
								: "None"}
						</dd>
						<dt>Headers</dt>
						<dd>{webhook.headerNames.join(", ") || "None"}</dd>
						<dt>Signing secret</dt>
						<dd>
							<code>{webhook.secretPrefix}</code>
						</dd>
						<dt>Last delivery</dt>
						<dd>{date(webhook.lastDeliveryAt)}</dd>
						{webhook.lastError && (
							<>
								<dt>Last failure</dt>
								<dd>
									{date(webhook.lastFailureAt)}:{" "}
									{failureText(webhook.lastError)}
									{webhook.consecutiveFailures > 0 &&
										` (${webhook.consecutiveFailures} in a row)`}
								</dd>
							</>
						)}
						{webhook.pendingEvents > 0 && (
							<>
								<dt>Waiting</dt>
								<dd>
									{webhook.pendingEvents === 1
										? "1 event"
										: `${webhook.pendingEvents} events`}
									{webhook.nextAttemptAt
										? `, next attempt ${date(webhook.nextAttemptAt)}`
										: ", sending now"}
								</dd>
							</>
						)}
					</dl>
					{result && (
						<p
							className={result.ok ? "analytics-notice" : "banner-error"}
							role="status"
						>
							{testText(result)}
						</p>
					)}
					{mode === "confirm-delete" ? (
						<div className="synapse-inline-form">
							<p>
								Delete the webhook of <strong>{agentName}</strong>? Nothing will
								wake it until a new one is added, and its auth key and headers
								are deleted with it.
							</p>
							<div className="form-actions">
								<button
									className="button"
									type="button"
									disabled={busy}
									onClick={() => setMode("view")}
								>
									Cancel
								</button>
								<button
									className="button danger"
									type="button"
									disabled={busy}
									onClick={() =>
										act(async () => {
											await deleteAgentWebhook(agentId);
											sequence.current++;
											setWebhook(null);
											setResult(null);
											setMode("view");
											onChanged(`Deleted the webhook of ${agentName}.`);
										}, "Could not delete the webhook.")
									}
								>
									{busy ? "Deleting…" : "Delete webhook"}
								</button>
							</div>
						</div>
					) : (
						<div className="token-actions agent-actions">
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() => setMode("edit")}
							>
								Edit webhook
							</button>
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() =>
									act(async () => {
										setResult(null);
										setResult(await testAgentWebhook(agentId));
									}, "Could not send the test.")
								}
							>
								{busy ? "Working…" : "Send test"}
							</button>
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() =>
									act(async () => {
										const start = webhook.status !== "active";
										saved(
											await updateAgentWebhook(agentId, { enabled: start }),
											start
												? `Started the webhook of ${agentName}.`
												: `Paused the webhook of ${agentName}.`,
										);
									}, "Could not change the webhook.")
								}
							>
								{webhook.status === "active" ? "Pause" : "Start"}
							</button>
							<button
								className="button"
								type="button"
								disabled={busy}
								onClick={() =>
									act(async () => {
										const rotated = await rotateAgentWebhookSecret(agentId);
										setSecret(rotated);
										saved(
											rotated.webhook,
											`Replaced the signing secret of ${agentName}'s webhook.`,
										);
									}, "Could not replace the secret.")
								}
							>
								New secret
							</button>
							<button
								className="button danger"
								type="button"
								disabled={busy}
								onClick={() => setMode("confirm-delete")}
							>
								Delete webhook
							</button>
						</div>
					)}
				</>
			)}
		</section>
	);
}
