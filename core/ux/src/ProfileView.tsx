import type { CurrentSession } from "@autonomo.us/common";
import { useState } from "react";
import { changePassword } from "./api.js";

export function ProfileView({ user }: { user: CurrentSession["user"] }) {
	const [currentPassword, setCurrentPassword] = useState("");
	const [newPassword, setNewPassword] = useState("");
	const [confirmation, setConfirmation] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [saved, setSaved] = useState(false);
	return (
		<div className="dashboard">
			<header className="dashboard-header">
				<h1>Profile settings</h1>
			</header>
			<section className="profile-card" aria-labelledby="account-heading">
				<h2 id="account-heading">Your account</h2>
				<dl>
					<dt>Name</dt>
					<dd>{user.name || "—"}</dd>
					<dt>Email</dt>
					<dd>{user.email}</dd>
					<dt>Role</dt>
					<dd>{user.role}</dd>
				</dl>
			</section>
			<form
				className="profile-card"
				onSubmit={async (event) => {
					event.preventDefault();
					setError("");
					setSaved(false);
					if (newPassword !== confirmation) {
						setError("New passwords do not match.");
						return;
					}
					setBusy(true);
					try {
						await changePassword(currentPassword, newPassword);
						setCurrentPassword("");
						setNewPassword("");
						setConfirmation("");
						setSaved(true);
					} catch (cause) {
						setError(
							cause instanceof Error
								? cause.message
								: "Could not change password.",
						);
					} finally {
						setBusy(false);
					}
				}}
			>
				<h2>Change password</h2>
				<label>
					Current password
					<input
						type="password"
						autoComplete="current-password"
						required
						value={currentPassword}
						onChange={(event) => setCurrentPassword(event.target.value)}
					/>
				</label>
				<label>
					New password
					<input
						type="password"
						autoComplete="new-password"
						required
						minLength={12}
						maxLength={128}
						value={newPassword}
						onChange={(event) => setNewPassword(event.target.value)}
					/>
				</label>
				<label>
					Confirm new password
					<input
						type="password"
						autoComplete="new-password"
						required
						value={confirmation}
						onChange={(event) => setConfirmation(event.target.value)}
					/>
				</label>
				{error && (
					<p className="banner-error" role="alert">
						{error}
					</p>
				)}
				{saved && <p role="status">Password updated.</p>}
				<button className="button primary" type="submit" disabled={busy}>
					{busy ? "Saving…" : "Update password"}
				</button>
			</form>
		</div>
	);
}
