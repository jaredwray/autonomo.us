import { useState } from "react";
import { connectOwner } from "./api.js";

/** Break-glass access with the gateway's OWNER_TOKEN, held only in tab memory. */
export function OwnerCredentialForm({
	onConnected,
	submitLabel = "Connect",
}: {
	onConnected(): void;
	submitLabel?: string;
}) {
	const [credential, setCredential] = useState("");
	const [error, setError] = useState("");
	const [busy, setBusy] = useState(false);
	return (
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
				<span className="field-hint">
					The OWNER_TOKEN configured on the API. It stays in this tab until you
					reload or lock the dashboard.
				</span>
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
					{busy ? "Connecting…" : submitLabel}
				</button>
			</div>
		</form>
	);
}
