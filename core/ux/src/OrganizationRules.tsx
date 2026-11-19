import type {
	DecisionRoute,
	DecisionRule,
	DecisionRuleInput,
} from "@autonomo.us/common";
import { useEffect, useState } from "react";
import { organizationRequest } from "./api.js";
import { Dropdown } from "./Dropdown.js";
import {
	PositionPicker,
	RouteTrace,
	useOrgAction,
} from "./OrganizationControls.js";
import { messageFrom, useOrgRead } from "./organization-state.js";

function RuleEditor({
	workspace,
	rule,
	viewerPositionId,
	canManage,
	changed,
}: {
	workspace: string;
	rule?: DecisionRule;
	viewerPositionId?: string;
	canManage: boolean;
	changed: (key: string) => void;
}) {
	const [key, setKey] = useState(rule?.key ?? "");
	const [requester, setRequester] = useState(viewerPositionId ?? "");
	const [owner, setOwner] = useState(rule?.ownerPositionId ?? "");
	const [fallbacks, setFallbacks] = useState<string[]>(
		rule?.fallbackPositionIds ?? [],
	);
	const [deadline, setDeadline] = useState(String(rule?.deadlineMinutes ?? 30));
	const [preview, setPreview] = useState<{
		signature: string;
		route: DecisionRoute;
	} | null>(null);
	const action = useOrgAction();
	const input: DecisionRuleInput = {
		ownerPositionId: owner,
		fallbackPositionIds: fallbacks,
		deadlineMinutes: Number(deadline),
	};
	const signature = JSON.stringify([key, requester, input]);
	const currentPreview =
		preview?.signature === signature ? preview.route : null;
	const valid =
		key.trim() &&
		(!canManage ||
			(owner &&
				fallbacks.every(Boolean) &&
				Number.isInteger(Number(deadline)) &&
				Number(deadline) > 0));
	async function inspect() {
		const route = await organizationRequest<DecisionRoute>(
			workspace,
			"/preview",
			{
				method: "POST",
				body: {
					decisionKey: key.trim(),
					requesterPositionId: requester || undefined,
					...(canManage ? { rule: input } : {}),
				},
			},
		);
		setPreview({ signature, route });
	}
	async function save() {
		await organizationRequest(
			workspace,
			`/rules/${encodeURIComponent(key.trim())}`,
			{
				method: "PUT",
				body: { ...input, expectedVersion: rule?.version ?? 0 },
			},
		);
		changed(key.trim());
	}
	return (
		<div className="org-form">
			<h3>{rule ? `Routing rule · v${rule.version}` : "New routing rule"}</h3>
			<label>
				Decision key
				<input
					value={key}
					readOnly={!!rule || !canManage}
					placeholder="visual-continuity"
					onChange={(e) => setKey(e.target.value)}
				/>
			</label>
			{canManage && (
				<>
					<PositionPicker
						workspace={workspace}
						label="Decision owner"
						value={owner}
						onChange={setOwner}
					/>
					{fallbacks.map((id, index) => (
						<div className="org-fallback" key={id || "new"}>
							<PositionPicker
								workspace={workspace}
								label={`Fallback ${index + 1}`}
								value={id}
								onChange={(value) =>
									setFallbacks(
										fallbacks.map((old, i) => (i === index ? value : old)),
									)
								}
								exclude={[owner, ...fallbacks.filter((_, i) => i !== index)]}
							/>
							<button
								type="button"
								className="button"
								onClick={() =>
									setFallbacks(fallbacks.filter((_, i) => i !== index))
								}
							>
								Remove fallback {index + 1}
							</button>
						</div>
					))}
					<button
						type="button"
						className="button"
						disabled={fallbacks.includes("")}
						onClick={() => setFallbacks([...fallbacks, ""])}
					>
						Add fallback
					</button>
					<label>
						Response deadline (minutes)
						<input
							type="number"
							min="1"
							value={deadline}
							onChange={(e) => setDeadline(e.target.value)}
						/>
					</label>
					<PositionPicker
						workspace={workspace}
						label="Preview from position"
						value={requester}
						onChange={setRequester}
						optional
					/>
				</>
			)}
			{!canManage && (
				<p>Responses are due within {rule?.deadlineMinutes} minutes.</p>
			)}
			<div className="org-actions">
				<button
					type="button"
					className="button"
					disabled={!valid || action.busy}
					onClick={() => void action.run(inspect)}
				>
					Preview route
				</button>
				{canManage && (
					<button
						className="button primary"
						type="button"
						disabled={!currentPreview || action.busy}
						onClick={() => void action.run(save)}
					>
						Save rule
					</button>
				)}
			</div>
			{action.error && <p role="alert">{action.error}</p>}
			{currentPreview && (
				<RouteTrace workspace={workspace} route={currentPreview} />
			)}
		</div>
	);
}

function PublishedRule({
	workspace,
	rule,
	requester,
	edit,
}: {
	workspace: string;
	rule: DecisionRule;
	requester?: string;
	edit?: () => void;
}) {
	const [route, setRoute] = useState<DecisionRoute | null>(null);
	const [error, setError] = useState("");
	useEffect(() => {
		const controller = new AbortController();
		organizationRequest<DecisionRoute>(workspace, "/preview", {
			method: "POST",
			body: { decisionKey: rule.key, requesterPositionId: requester },
			signal: controller.signal,
		}).then(
			(result) => {
				if (!controller.signal.aborted) setRoute(result);
			},
			(cause) => {
				if (!controller.signal.aborted) setError(messageFrom(cause));
			},
		);
		return () => controller.abort();
	}, [workspace, rule.key, requester]);
	return (
		<div className="org-form">
			{error ? (
				<p role="alert">{error}</p>
			) : route ? (
				<RouteTrace workspace={workspace} route={route} />
			) : (
				<p role="status">Tracing route…</p>
			)}
			{edit && (
				<button type="button" className="button" onClick={edit}>
					Edit rule
				</button>
			)}
		</div>
	);
}

export function OrganizationRules({
	workspace,
	canManage,
	viewerPositionId,
	revision,
	onChanged,
}: {
	workspace: string;
	canManage: boolean;
	viewerPositionId?: string;
	revision: number;
	onChanged: () => void;
}) {
	const result = useOrgRead<{ rules: DecisionRule[] }>(
		workspace,
		"/rules",
		revision,
	);
	const [selection, setSelection] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	if (result.error) return <p role="alert">{result.error}</p>;
	if (!result.data) return <p role="status">Loading rules…</p>;
	const key = selection ?? result.data.rules[0]?.key ?? "";
	const rule = result.data.rules.find((r) => r.key === key);
	return (
		<section className="card org-form">
			<h2>Escalation rules</h2>
			{result.data.rules.length > 0 && (
				<label>
					Rule
					<Dropdown
						value={key}
						onValueChange={(value) => {
							setSelection(value);
							setEditing(false);
						}}
						aria-label="Rule"
					>
						{result.data.rules.map((r) => (
							<option key={r.key} value={r.key}>
								{r.key}
							</option>
						))}
						{canManage && <option value="">New rule</option>}
					</Dropdown>
				</label>
			)}
			{rule && !editing ? (
				<PublishedRule
					key={[key, rule.version, viewerPositionId].join("-")}
					workspace={workspace}
					rule={rule}
					requester={viewerPositionId}
					edit={canManage ? () => setEditing(true) : undefined}
				/>
			) : canManage || rule ? (
				<RuleEditor
					key={`${key}-${rule?.version ?? 0}`}
					workspace={workspace}
					rule={rule}
					canManage={canManage}
					viewerPositionId={viewerPositionId}
					changed={(saved) => {
						setSelection(saved);
						setEditing(false);
						onChanged();
					}}
				/>
			) : (
				<p>No decision rules have been configured.</p>
			)}
		</section>
	);
}
