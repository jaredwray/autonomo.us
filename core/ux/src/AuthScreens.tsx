import {
	type AuthSession,
	type AuthStatus,
	type InvitePreview,
	PASSWORD_MAX_LENGTH,
	PASSWORD_MIN_LENGTH,
	TEAM_ROLES,
} from "@autonomo.us/common";
import { type ReactNode, useEffect, useRef, useState } from "react";
import {
	acceptInvite,
	completeSetup,
	credentialKind,
	previewInvite,
	signIn,
} from "./api.js";
import { OwnerCredentialForm } from "./OwnerAccess.js";

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

/** First run: prove control of the gateway (when required), then create the owner account. */
export function SetupView({
	status,
	onComplete,
}: {
	status: AuthStatus;
	onComplete(session: AuthSession): void;
}) {
	const [step, setStep] = useState<"owner" | "account">(() =>
		status.ownerCredentialConfigured && credentialKind() !== "owner"
			? "owner"
			: "account",
	);
	const heading = useRef<HTMLHeadingElement>(null);
	// biome-ignore lint/correctness/useExhaustiveDependencies: move focus to the new step's heading.
	useEffect(() => {
		heading.current?.focus();
	}, [step]);
	return (
		<AuthLayout labelledBy="setup-heading">
			{status.ownerCredentialConfigured && (
				<p className="auth-step">Step {step === "owner" ? 1 : 2} of 2</p>
			)}
			<h1 id="setup-heading" tabIndex={-1} ref={heading}>
				{step === "owner" ? "Welcome to autonomo.us" : "Create your account"}
			</h1>
			{step === "owner" ? (
				<>
					<p className="auth-intro">
						This gateway hasn't been set up yet. Enter its owner credential to
						continue.
					</p>
					<OwnerCredentialForm
						submitLabel="Continue"
						onConnected={() => setStep("account")}
					/>
				</>
			) : (
				<>
					<p className="auth-intro">
						{status.ownerCredentialConfigured
							? "Create the first owner account for this gateway."
							: "Welcome! This gateway hasn't been set up yet. Create the first owner account."}{" "}
						Once you're in, invite your team from the Team page.
					</p>
					<AccountForm
						nameRequired
						submitLabel="Create account"
						busyLabel="Creating account…"
						onSubmit={async (input) => {
							onComplete(await completeSetup(input));
						}}
					/>
					<MemoryNote status={status} />
				</>
			)}
		</AuthLayout>
	);
}

export function SignInView({
	status,
	initialMode,
	onSignedIn,
}: {
	status: AuthStatus;
	initialMode: "password" | "owner";
	onSignedIn(): void;
}) {
	const [mode, setMode] = useState<"password" | "owner">(
		initialMode === "owner" && status.ownerCredentialConfigured
			? "owner"
			: "password",
	);
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	return (
		<AuthLayout labelledBy="sign-in-heading">
			<h1 id="sign-in-heading">Sign in</h1>
			{mode === "password" ? (
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
						Forgot your password? Ask an owner or admin to reset it from the
						Team page.
					</p>
				</form>
			) : (
				<>
					<p className="auth-intro">
						Use the gateway's owner credential for break-glass access.
					</p>
					<OwnerCredentialForm onConnected={onSignedIn} />
				</>
			)}
			<MemoryNote status={status} />
			{status.ownerCredentialConfigured && (
				<button
					className="button link-button auth-switch"
					type="button"
					onClick={() => setMode(mode === "owner" ? "password" : "owner")}
				>
					{mode === "owner"
						? "Sign in with email instead"
						: "Use the owner credential instead"}
				</button>
			)}
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
