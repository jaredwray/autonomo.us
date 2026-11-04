import { useState } from "react";
import { verifySetupToken } from "./api.js";

/** First-run step when the API has SETUP_TOKEN: proves you may set up this gateway. */
export function SetupTokenForm({ onVerified }: { onVerified(): void }) {
	const [token, setToken] = useState("");
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
					await verifySetupToken(token.trim());
					setToken("");
					onVerified();
				} catch (cause) {
					setError(
						cause instanceof Error ? cause.message : "Could not verify.",
					);
					setBusy(false);
				}
			}}
		>
			<div className="form-field">
				<label htmlFor="setup-token">Setup token</label>
				<input
					id="setup-token"
					type="password"
					autoComplete="off"
					required
					value={token}
					onChange={(event) => setToken(event.target.value)}
					disabled={busy}
				/>
				<span className="field-hint">
					The SETUP_TOKEN configured on the API. It's only used to finish setup
					and stays in this tab.
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
					disabled={busy || !token.trim()}
					type="submit"
				>
					{busy ? "Checking…" : "Continue"}
				</button>
			</div>
		</form>
	);
}
