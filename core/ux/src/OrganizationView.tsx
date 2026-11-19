import type {
	OrgBranch,
	OrgPosition,
	OrgPositionDetail,
	WorkspaceAccess,
} from "@autonomo.us/common";
import { useState } from "react";
import { occupantType, PositionAvatar } from "./OrganizationControls.js";
import { OrgSettingsForm, PositionForm } from "./OrganizationForms.js";
import { OrganizationRules } from "./OrganizationRules.js";
import {
	orgLink,
	queryPath,
	routeItem,
	useDebouncedQuery,
	useOrgRead,
} from "./organization-state.js";
import { PageTabs } from "./PageTabs.js";
import "./organization.css";

function BranchMap({
	workspace,
	positions,
	selected,
	searching,
}: {
	workspace: string;
	positions: OrgPosition[];
	selected: string | null;
	searching: boolean;
}) {
	const visible = new Set(positions.map((p) => p.id));
	const children = new Map<string, OrgPosition[]>();
	for (const position of positions) {
		const parent =
			!searching && position.managerId && visible.has(position.managerId)
				? position.managerId
				: "";
		const group = children.get(parent) ?? [];
		group.push(position);
		children.set(parent, group);
	}
	function branch(parent: string) {
		const group = children.get(parent);
		if (!group) return null;
		return (
			<ul>
				{group.map((p) => (
					<li key={p.id}>
						<a
							className="org-node"
							aria-current={p.id === selected ? "true" : undefined}
							href={orgLink(workspace, "organization", "positions", p.id)}
						>
							<PositionAvatar position={p} />
							<span>
								<strong>{p.title}</strong>
								<small>{p.occupant?.name ?? "Vacant"}</small>
								{p.childCount > 0 && (
									<small className="org-reports">
										{p.childCount} {p.childCount === 1 ? "report" : "reports"}
									</small>
								)}
							</span>
						</a>
						{branch(p.id)}
					</li>
				))}
			</ul>
		);
	}
	return (
		<section
			className={`org-map${searching || positions.length > 12 ? " org-map-list" : ""}`}
			aria-label={searching ? "Position search results" : "Reporting hierarchy"}
		>
			{branch("")}
		</section>
	);
}

function PositionDetails({
	workspace,
	id,
	canManage,
	edit,
	revision,
}: {
	workspace: string;
	id: string;
	canManage: boolean;
	edit: (p: OrgPosition) => void;
	revision: number;
}) {
	const detail = useOrgRead<OrgPositionDetail>(
		workspace,
		`/positions/${encodeURIComponent(id)}`,
		revision,
	);
	if (detail.error)
		return (
			<aside className="card">
				<p role="alert">{detail.error}</p>
			</aside>
		);
	if (!detail.data)
		return (
			<aside className="card" role="status">
				Loading position…
			</aside>
		);
	const { position: p, manager, fallback, cases } = detail.data;
	return (
		<aside className="card org-details" aria-label="Position details">
			<div className="section-heading">
				<h2>Position details</h2>
				{canManage && !p.archived && (
					<button type="button" className="button" onClick={() => edit(p)}>
						Edit position
					</button>
				)}
			</div>
			<div className="org-identity">
				<PositionAvatar position={p} />
				<div>
					<h3>{p.title}</h3>
					<p>
						{p.occupant
							? `${p.occupant.name} · ${occupantType(p.occupant)}`
							: "Vacant"}
					</p>
				</div>
			</div>
			<p>{p.remit}</p>
			<dl>
				<dt>Reports to</dt>
				<dd>
					{manager ? (
						<a
							href={orgLink(workspace, "organization", "positions", manager.id)}
						>
							{manager.title}
						</a>
					) : (
						"No manager"
					)}
				</dd>
				<dt>Human fallback</dt>
				<dd>
					{fallback ? (
						<a
							href={orgLink(
								workspace,
								"organization",
								"positions",
								fallback.id,
							)}
						>
							{fallback.title}
						</a>
					) : (
						"Unassigned"
					)}
				</dd>
			</dl>
			<h4>Can decide</h4>
			<p>{p.authority || "No decision authority described."}</p>
			<h4>Linked decisions</h4>
			{cases.length ? (
				<ul>
					{cases.map((c) => (
						<li key={c.id}>
							<a href={orgLink(workspace, "loops/decisions", "cases", c.id)}>
								{c.question}
							</a>{" "}
							· {c.status.replaceAll("_", " ")}
						</li>
					))}
				</ul>
			) : (
				<p>No visible decisions for this position.</p>
			)}
		</aside>
	);
}

export function OrganizationView({
	workspace,
	route,
}: {
	workspace: WorkspaceAccess;
	route: string;
}) {
	const id = routeItem(route, "positions") ?? routeItem(route, "escalations");
	const [query, setQuery] = useState("");
	const term = useDebouncedQuery(query);
	const [page, setPage] = useState<{ key: string; cursor: string } | null>(
		null,
	);
	const tab =
		route.split("/")[1] === "escalations" ? "escalations" : "reporting";
	function setTab(next: "reporting" | "escalations") {
		window.location.hash = orgLink(
			workspace.id,
			"organization",
			next === "escalations" ? "escalations" : id ? "positions" : undefined,
			id ?? undefined,
		);
	}
	const [panel, setPanel] = useState<"add" | "settings" | OrgPosition | null>(
		null,
	);
	const [revision, setRevision] = useState(0);
	const [notice, setNotice] = useState("");
	const searchKey = JSON.stringify([id, term, revision]);
	const cursor = page?.key === searchKey ? page.cursor : null;
	const data = useOrgRead<OrgBranch>(
		workspace.id,
		queryPath("/branch", {
			q: term,
			positionId: term ? null : id,
			after: cursor,
		}),
		revision,
	);
	const info = data.data;
	const focus =
		id ??
		info?.viewerPositionIds.find((pos) =>
			info.positions.some((p) => p.id === pos),
		) ??
		info?.leadPositionId ??
		info?.positions[0]?.id ??
		null;
	const refresh = () => setRevision((v) => v + 1);
	function saved(p: OrgPosition) {
		setPanel(null);
		setNotice(p.archived ? "Position archived." : "Position saved.");
		setQuery("");
		window.location.hash = orgLink(
			workspace.id,
			"organization",
			p.archived ? undefined : "positions",
			p.archived ? undefined : p.id,
		);
		refresh();
	}
	return (
		<div className="dashboard">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">{workspace.name}</p>
					<h1>Organization</h1>
				</div>
				{workspace.role === "admin" && (
					<div className="org-actions">
						<button
							className="button"
							type="button"
							onClick={() => setPanel("settings")}
						>
							Settings
						</button>
						<button
							className="button primary"
							type="button"
							onClick={() => setPanel("add")}
						>
							Add position
						</button>
					</div>
				)}
			</header>
			{notice && <p role="status">{notice}</p>}
			{panel === "settings" && info && (
				<OrgSettingsForm
					workspace={workspace.id}
					settings={info}
					done={() => {
						setPanel(null);
						refresh();
					}}
				/>
			)}
			{panel !== null && panel !== "settings" && (
				<PositionForm
					key={typeof panel === "string" ? "new" : panel.id}
					workspace={workspace.id}
					position={typeof panel === "object" ? panel : undefined}
					parentId={
						typeof panel === "string" ? (focus ?? undefined) : undefined
					}
					onSaved={saved}
					onCancel={() => setPanel(null)}
				/>
			)}
			<PageTabs<"reporting" | "escalations">
				label="Organization views"
				idPrefix="organization"
				tabs={[
					{ id: "reporting", label: "Reporting" },
					{ id: "escalations", label: "Escalations" },
				]}
				selected={tab}
				onSelect={setTab}
			/>
			<section
				role="tabpanel"
				id="organization-panel"
				aria-labelledby={`organization-tab-${tab}`}
			>
				{tab === "escalations" ? (
					<OrganizationRules
						workspace={workspace.id}
						canManage={workspace.role === "admin"}
						viewerPositionId={
							(workspace.role === "admin" ? id : null) ??
							info?.viewerPositionIds[0]
						}
						revision={revision}
						onChanged={refresh}
					/>
				) : (
					<>
						<label className="org-search">
							Find a position
							<input
								type="search"
								placeholder="Search title, person, or agent"
								value={query}
								onChange={(e) => {
									setQuery(e.target.value);
									setPage(null);
								}}
							/>
						</label>
						{data.error && (
							<p role="alert">
								{data.error}{" "}
								<button className="button" type="button" onClick={refresh}>
									Retry
								</button>
							</p>
						)}
						{!data.error && !info && <p role="status">Loading organization…</p>}
						{info && (
							<div className="org-layout">
								<div className="card org-map-card">
									<h2>{term ? "Matching positions" : "Reporting map"}</h2>
									{info.positions.length ? (
										<BranchMap
											workspace={workspace.id}
											positions={info.positions}
											selected={focus}
											searching={!!term}
										/>
									) : (
										<p>
											{term
												? "No matching positions."
												: workspace.role === "admin"
													? "Add the first position to set up this workspace’s organization."
													: "This workspace has no positions yet."}
										</p>
									)}
									<div className="org-actions">
										{id && (
											<a
												href={orgLink(workspace.id, "organization")}
												onClick={() => {
													setQuery("");
													setPage(null);
												}}
											>
												My branch
											</a>
										)}
										{cursor && (
											<button
												className="button"
												type="button"
												onClick={() => setPage(null)}
											>
												First page
											</button>
										)}
										{info.next && (
											<button
												className="button"
												type="button"
												onClick={() =>
													setPage({
														key: searchKey,
														cursor: info.next as string,
													})
												}
											>
												Next positions
											</button>
										)}
									</div>
								</div>
								{focus && (
									<PositionDetails
										workspace={workspace.id}
										id={focus}
										canManage={info.canManage}
										edit={setPanel}
										revision={revision}
									/>
								)}
							</div>
						)}
					</>
				)}
			</section>
		</div>
	);
}
