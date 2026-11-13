import {
	type AuthSession,
	type AuthStatus,
	type InvitePreview,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	type SetupCheck,
	type SetupDataChoice,
	type SetupInventory,
	TEAM_ROLES,
} from "@autonomo.us/common";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { acceptInvite, completeSetup, previewInvite, signIn } from "./api.js";
import { SetupTokenForm } from "./SetupToken.js";

const logoMark = new URL("./assets/logo-mark.svg", import.meta.url).href;
const message = (cause: unknown, fallback: string) =>
	cause instanceof Error ? cause.message : fallback;

export function AuthLayout({
	labelledBy,
	children,
}: {
	labelledBy: string;
	children: ReactNode;
}) {
	return (
		<main id="main-content" tabIndex={-1} className="auth-shell">
			<section className="card auth-card" aria-labelledby={labelledBy}>
				<div className="auth-brand">
					<img src={logoMark} alt="" width="36" height="29" />
					<span>autonomo.us</span>
				</div>
				{children}
			</section>
		</main>
	);
}

function MemoryNote({ status }: { status: AuthStatus }) {
	return status.persistence === "memory" ? (
		<p className="card-note auth-note">
			MongoDB isn't connected, so accounts last only until the API restarts.
		</p>
	) : null;
}

export function passwordProblem(password: string, confirm: string) {
	const length = [...password].length;
	if (length < PASSWORD_MIN_LENGTH)
		return `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
	if (length > PASSWORD_MAX_LENGTH)
		return `Use at most ${PASSWORD_MAX_LENGTH} characters.`;
	if (password !== confirm) return "The passwords don't match.";
	return "";
}

/** New password plus confirmation, shared by setup, invites, and team forms. */
export function PasswordFields({
	idPrefix,
	label = "Password",
	password,
	confirm,
	onPassword,
	onConfirm,
}: {
	idPrefix: string;
	label?: string;
	password: string;
	confirm: string;
	onPassword(value: string): void;
	onConfirm(value: string): void;
}) {
	return (
		<>
			<div className="form-field">
				<label htmlFor={`${idPrefix}-password`}>{label}</label>
				<input
					id={`${idPrefix}-password`}
					type="password"
					autoComplete="new-password"
					required
					minLength={PASSWORD_MIN_LENGTH}
					maxLength={PASSWORD_MAX_LENGTH}
					value={password}
					onChange={(event) => onPassword(event.target.value)}
				/>
				<span className="field-hint">
					At least {PASSWORD_MIN_LENGTH} characters. A short phrase works well.
				</span>
			</div>
			<div className="form-field">
				<label htmlFor={`${idPrefix}-confirm`}>Confirm password</label>
				<input
					id={`${idPrefix}-confirm`}
					type="password"
					autoComplete="new-password"
					required
					value={confirm}
					onChange={(event) => onConfirm(event.target.value)}
				/>
			</div>
		</>
	);
}

/** Name, email, and a new password; used for the first owner and invited members. */
function AccountForm({
	submitLabel,
	busyLabel,
	nameRequired,
	onSubmit,
}: {
	submitLabel: string;
	busyLabel: string;
	nameRequired: boolean;
	onSubmit(input: {
		name: string;
		email: string;
		password: string;
	}): Promise<void>;
}) {
	const [name, setName] = useState("");
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<form
			onSubmit={async (event) => {
				event.preventDefault();
				if (busy) return;
				const problem = passwordProblem(password, confirm);
				if (problem) {
					setError(problem);
					return;
				}
				setBusy(true);
				setError("");
				try {
					await onSubmit({ name: name.trim(), email: email.trim(), password });
				} catch (cause) {
					setError(message(cause, "Could not create the account."));
					setBusy(false);
				}
			}}
		>
			<fieldset className="routing-fields" disabled={busy}>
				<div className="form-field">
					<label htmlFor="account-name">
						{nameRequired ? "Your name" : "Your name (optional)"}
					</label>
					<input
						id="account-name"
						autoComplete="name"
						required={nameRequired}
						maxLength={100}
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
				</div>
				<div className="form-field">
					<label htmlFor="account-email">Email</label>
					<input
						id="account-email"
						type="email"
						autoComplete="username"
						required
						maxLength={254}
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
					<span className="field-hint">
						You'll sign in with this address. Nothing is sent to it.
					</span>
				</div>
				<PasswordFields
					idPrefix="account"
					password={password}
					confirm={confirm}
					onPassword={setPassword}
					onConfirm={setConfirm}
				/>
				{error && (
					<p className="banner-error" role="alert">
						{error}
					</p>
				)}
				<div className="form-actions">
					<button
						className="button primary"
						type="submit"
						disabled={
							!email.trim() || !password || (nameRequired && !name.trim())
						}
					>
						{busy ? busyLabel : submitLabel}
					</button>
				</div>
			</fieldset>
		</form>
	);
}

const INVENTORY: Array<[keyof SetupInventory, string, string]> = [
	["accounts", "team account", "team accounts"],
	["invites", "pending invite", "pending invites"],
	["connections", "model connection", "model connections"],
	["tokens", "API or agent token", "API and agent tokens"],
	["workspaces", "workspace besides Default", "workspaces besides Default"],
	["notes", "Synapse note", "Synapse notes"],
	["usageEvents", "recorded request", "recorded requests"],
];

/** "3 team accounts", "1 Synapse note", … for each kind of data that exists. */
export function inventoryLines(existing: SetupInventory): string[] {
	return INVENTORY.filter(([key]) => existing[key] > 0).map(
		([key, one, many]) =>
			`${existing[key].toLocaleString()} ${existing[key] === 1 ? one : many}`,
	);
}

/** With the setup token on a gateway that has data: keep it or start fresh. */
function SetupDataStep({
	check,
	choice,
	onChoice,
	onContinue,
}: {
	check: SetupCheck;
	choice: SetupDataChoice;
	onChoice(choice: SetupDataChoice): void;
	onContinue(): void;
}) {
	const [confirmed, setConfirmed] = useState(false);
	const clearing = choice === "clear";
	return (
		<form
			onSubmit={(event) => {
				event.preventDefault();
				if (!clearing || confirmed) onContinue();
			}}
		>
			<p className="auth-intro">It already holds:</p>
			<ul className="setup-inventory">
				{inventoryLines(check.existing).map((line) => (
					<li key={line}>{line}</li>
				))}
			</ul>
			<fieldset className="setup-choices">
				<legend>What should happen to it?</legend>
				<label className="setup-choice">
					<input
						type="radio"
						name="setup-data"
						value="keep"
						checked={choice === "keep"}
						onChange={() => onChoice("keep")}
					/>
					<span>
						<strong>Keep it and add an owner</strong>
						<span className="field-hint">
							Everything stays. If you use an email that already has an account,
							that account gets your new password and the owner role, and its
							other sessions are signed out.
						</span>
					</span>
				</label>
				<label className="setup-choice destructive">
					<input
						type="radio"
						name="setup-data"
						value="clear"
						checked={clearing}
						disabled={!check.canClear}
						onChange={() => onChoice("clear")}
					/>
					<span>
						<strong>Delete it and start fresh</strong>
						<span className="field-hint">
							{check.canClear
								? "Permanently deletes every team account, model and key, routing rule, token, workspace, Synapse note, and usage record in this gateway's database."
								: "Needs MongoDB. Without it, the gateway starts fresh each time the API restarts."}
						</span>
					</span>
				</label>
			</fieldset>
			{clearing && (
				<label className="setup-confirm">
					<input
						type="checkbox"
						checked={confirmed}
						onChange={(event) => setConfirmed(event.target.checked)}
					/>
					<span>I understand this can't be undone.</span>
				</label>
			)}
			<div className="form-actions">
				<button
					className="button primary"
					type="submit"
					disabled={clearing && !confirmed}
				>
					Continue
				</button>
			</div>
		</form>
	);
}

type SetupStep = "token" | "data" | "account";

/**
 * Setup: prove control of the gateway (when SETUP_TOKEN is set), decide what
 * happens to data it already holds, then create the owner account.
 */
export function SetupView({
	status,
	onComplete,
}: {
	status: AuthStatus;
	onComplete(session: AuthSession): void;
}) {
	const [step, setStep] = useState<SetupStep>(
		status.setupTokenRequired ? "token" : "account",
	);
	const [check, setCheck] = useState<SetupCheck | null>(null);
	const [choice, setChoice] = useState<SetupDataChoice>("keep");
	const hasData = check
		? Object.values(check.existing).some((count) => count > 0)
		: false;
	const steps: SetupStep[] = !status.setupTokenRequired
		? ["account"]
		: hasData
			? ["token", "data", "account"]
			: ["token", "account"];
	const heading = useRef<HTMLHeadingElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: move focus to the new step's heading.
	useEffect(() => {
		heading.current?.focus();
	}, [step]);
	const clearing = hasData && choice === "clear";
	const title =
		step === "token"
			? "Welcome to autonomo.us"
			: step === "data"
				? "This gateway already has data"
				: hasData && !clearing
					? "Create an owner account"
					: "Create your account";
	return (
		<AuthLayout labelledBy="setup-heading">
			{steps.length > 1 && (
				<p className="auth-step">
					Step {steps.indexOf(step) + 1} of {steps.length}
				</p>
			)}
			<h1 id="setup-heading" tabIndex={-1} ref={heading}>
				{title}
			</h1>
			{step === "token" && (
				<>
					<p className="auth-intro">
						Setup is open on this gateway. Enter its setup token to continue.
					</p>
					<SetupTokenForm
						onVerified={(result) => {
							setCheck(result);
							setChoice("keep");
							setStep(
								Object.values(result.existing).some((count) => count > 0)
									? "data"
									: "account",
							);
						}}
					/>
				</>
			)}
			{step === "data" && check && (
				<SetupDataStep
					check={check}
					choice={choice}
					onChoice={setChoice}
					onContinue={() => setStep("account")}
				/>
			)}
			{step === "account" && (
				<>
					<p className="auth-intro">
						{clearing
							? "Creating this account first deletes everything this gateway holds. Then invite your team from the Team page."
							: hasData
								? "This account becomes an owner, and the gateway's data stays. If the email already has an account, that account gets this password."
								: status.setupTokenRequired
									? "Create the first owner account for this gateway. Once you're in, invite your team from the Team page."
									: "Welcome! This gateway hasn't been set up yet. Create the first owner account. Once you're in, invite your team from the Team page."}
					</p>
					<AccountForm
						nameRequired
						submitLabel={
							clearing ? "Delete data and create account" : "Create account"
						}
						busyLabel={clearing ? "Deleting data…" : "Creating account…"}
						onSubmit={async (input) => {
							onComplete(
								await completeSetup(
									check
										? { ...input, data: clearing ? "clear" : "keep" }
										: input,
								),
							);
						}}
					/>
					{hasData && (
						<button
							className="link-button auth-switch"
							type="button"
							onClick={() => setStep("data")}
						>
							Back
						</button>
					)}
					<MemoryNote status={status} />
				</>
			)}
		</AuthLayout>
	);
}

export function SignInView({
	status,
	onSignedIn,
}: {
	status: AuthStatus;
	onSignedIn(): void;
}) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<AuthLayout labelledBy="sign-in-heading">
			<h1 id="sign-in-heading">Sign in</h1>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						await signIn(email.trim(), password);
						onSignedIn();
					} catch (cause) {
						setError(message(cause, "Could not sign in."));
						setPassword("");
						setBusy(false);
					}
				}}
			>
				<fieldset className="routing-fields" disabled={busy}>
					<div className="form-field">
						<label htmlFor="sign-in-email">Email</label>
						<input
							id="sign-in-email"
							type="email"
							autoComplete="username"
							required
							value={email}
							onChange={(event) => setEmail(event.target.value)}
						/>
					</div>
					<div className="form-field">
						<label htmlFor="sign-in-password">Password</label>
						<input
							id="sign-in-password"
							type="password"
							autoComplete="current-password"
							required
							value={password}
							onChange={(event) => setPassword(event.target.value)}
						/>
					</div>
					{error && (
						<p className="banner-error" role="alert">
							{error}
						</p>
					)}
					<div className="form-actions">
						<button
							className="button primary"
							type="submit"
							disabled={!email.trim() || !password}
						>
							{busy ? "Signing in…" : "Sign in"}
						</button>
					</div>
				</fieldset>
				<p className="card-note auth-note">
					Forgot your password? Ask an owner or admin to reset it from the Team
					page.
				</p>
			</form>
			<MemoryNote status={status} />
		</AuthLayout>
	);
}

/** Opened from an invite link (`#/invite/<token>`); the token never leaves the fragment except in POST bodies. */
export function InviteView({
	token,
	status,
	onJoined,
	onCancel,
}: {
	token: string;
	status: AuthStatus;
	onJoined(): void;
	onCancel(): void;
}) {
	const [preview, setPreview] = useState<InvitePreview | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		let active = true;
		previewInvite(token).then(
			(value) => {
				if (active) setPreview(value);
			},
			(cause) => {
				if (active) setError(message(cause, "This invite link is invalid."));
			},
		);
		return () => {
			active = false;
		};
	}, [token]);
	return (
		<AuthLayout labelledBy="invite-heading">
			<h1 id="invite-heading">
				{error ? "Invite unavailable" : "Join your team"}
			</h1>
			{error ? (
				<>
					<p className="banner-error" role="alert">
						{error}
					</p>
					<button className="button" type="button" onClick={onCancel}>
						Go to sign in
					</button>
				</>
			) : !preview ? (
				<p role="status">Checking your invite…</p>
			) : (
				<>
					<p className="auth-intro">
						<strong>{preview.invitedBy}</strong> invited you to join as{" "}
						<strong>{TEAM_ROLES[preview.role]}</strong>. Create your account to
						continue. This link works once and expires{" "}
						{new Date(preview.expiresAt).toLocaleString()}.
					</p>
					<AccountForm
						nameRequired={false}
						submitLabel="Join team"
						busyLabel="Joining…"
						onSubmit={async (input) => {
							await acceptInvite({ token, ...input });
							onJoined();
						}}
					/>
					<MemoryNote status={status} />
				</>
			)}
		</AuthLayout>
	);
}
