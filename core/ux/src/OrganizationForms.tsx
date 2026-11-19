import type {
	OrgIdentity,
	OrgPosition,
	OrgPositionInput,
	OrgSettings,
} from "@autonomo.us/common";
import { useState } from "react";
import { organizationRequest } from "./api.js";
import {
	OccupantPicker,
	PositionPicker,
	useOrgAction,
} from "./OrganizationControls.js";

export function PositionForm({
	workspace,
	position,
	parentId,
	onSaved,
	onCancel,
}: {
	workspace: string;
	position?: OrgPosition;
	parentId?: string;
	onSaved: (position: OrgPosition) => void;
	onCancel: () => void;
}) {
	const [title, setTitle] = useState(position?.title ?? "");
	const [remit, setRemit] = useState(position?.remit ?? "");
	const [authority, setAuthority] = useState(position?.authority ?? "");
	const [manager, setManager] = useState(position?.managerId ?? parentId ?? "");
	const [occupant, setOccupant] = useState<OrgIdentity | null>(
		position?.occupant ?? null,
	);
	const [archiving, setArchiving] = useState(false);
	const action = useOrgAction();
	async function submit(archive = false) {
		const input: OrgPositionInput = archive
			? { archived: true }
			: {
					title: title.trim(),
					remit: remit.trim(),
					authority: authority.trim(),
					managerId: manager || null,
					occupant: occupant ? { kind: occupant.kind, id: occupant.id } : null,
				};
		const saved = await organizationRequest<OrgPosition>(
			workspace,
			position ? `/positions/${encodeURIComponent(position.id)}` : "/positions",
			{ method: position ? "PATCH" : "POST", body: input },
		);
		onSaved(saved);
	}
	return (
		<form
			className="card org-form"
			onSubmit={(e) => {
				e.preventDefault();
				void action.run(() => submit(archiving));
			}}
		>
			<h2>{position ? "Edit position" : "Add position"}</h2>
			{archiving ? (
				<p>
					Archive {position?.title}? Its previous decisions stay in the case
					history.
				</p>
			) : (
				<>
					<label>
						Position title
						<input
							required
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</label>
					<label>
						Responsibility
						<textarea
							value={remit}
							onChange={(e) => setRemit(e.target.value)}
						/>
					</label>
					<label>
						Can decide
						<textarea
							value={authority}
							onChange={(e) => setAuthority(e.target.value)}
						/>
					</label>
					<OccupantPicker
						workspace={workspace}
						value={occupant}
						onChange={setOccupant}
					/>
					<PositionPicker
						workspace={workspace}
						label="Reports to"
						value={manager}
						onChange={setManager}
						exclude={position ? [position.id] : []}
						optional
					/>
				</>
			)}
			{action.error && <p role="alert">{action.error}</p>}
			<div className="org-actions">
				<button
					className="button primary"
					type="submit"
					disabled={action.busy || (!archiving && !title.trim())}
				>
					{archiving ? "Confirm archive" : "Save position"}
				</button>
				<button type="button" className="button" onClick={onCancel}>
					Cancel
				</button>
				{position && !archiving && (
					<button
						type="button"
						className="button"
						onClick={() => setArchiving(true)}
					>
						Archive position
					</button>
				)}
			</div>
		</form>
	);
}

export function OrgSettingsForm({
	workspace,
	settings,
	done,
}: {
	workspace: string;
	settings: OrgSettings;
	done: () => void;
}) {
	const [lead, setLead] = useState(settings.leadPositionId ?? "");
	const [fallback, setFallback] = useState(
		settings.humanFallbackPositionId ?? "",
	);
	const action = useOrgAction();
	return (
		<form
			className="card org-form"
			onSubmit={(e) => {
				e.preventDefault();
				void action.run(async () => {
					await organizationRequest<OrgSettings>(workspace, "/settings", {
						method: "PUT",
						body: {
							leadPositionId: lead || null,
							humanFallbackPositionId: fallback || null,
						},
					});
					done();
				});
			}}
		>
			<h2>Organization settings</h2>
			<PositionPicker
				workspace={workspace}
				label="Workspace lead"
				value={lead}
				onChange={setLead}
				optional
			/>
			<PositionPicker
				workspace={workspace}
				label="Accountable human fallback"
				value={fallback}
				onChange={setFallback}
				humanOnly
				optional
			/>
			{action.error && <p role="alert">{action.error}</p>}
			<div className="org-actions">
				<button className="button primary" disabled={action.busy} type="submit">
					Save settings
				</button>
				<button className="button" type="button" onClick={done}>
					Cancel
				</button>
			</div>
		</form>
	);
}
