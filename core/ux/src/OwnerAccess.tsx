import { useState } from "react";
import { connectOwner } from "./api.js";

export function OwnerAccess({ onConnected }: { onConnected(): void }) {
	const [credential, setCredential] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return (
		<section
			className="card owner-access"
			aria-labelledby="owner-access-heading"
		>
			<h1 id="owner-access-heading">Connect to your gateway</h1>
			<p className="card-note">
				Enter the owner credential configured for this gateway. It stays in this
				tab until you reload or lock the dashboard.
			</p>
			<form
				onSubmit={async (event) => {
					event.preventDefault();
					if (busy) return;
					setBusy(true);
					setError("");
					try {
						await connectOwner(credential.trim());
						setCredential("");
						onConnected();
					} catch (cause) {
						setError(
							cause instanceof Error ? cause.message : "Could not connect.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				<div className="form-field">
					<label htmlFor="owner-credential">Owner credential</label>
					<input
						id="owner-credential"
						type="password"
						autoComplete="off"
						required
						value={credential}
						onChange={(event) => setCredential(event.target.value)}
						disabled={busy}
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
						disabled={busy || !credential.trim()}
						type="submit"
					>
						{busy ? "Connecting…" : "Connect"}
					</button>
				</div>
			</form>
		</section>
	);
}
