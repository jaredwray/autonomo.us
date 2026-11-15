import {
	AGENT_KINDS,
	type ChannelSummary,
	OVERVIEW_BUDGET_WARNING,
	type OverviewAgent,
	type UsageAnalytics,
	type WorkspaceOverview,
} from "@autonomo.us/common";
import type { ReactNode } from "react";
import {
	ago,
	count,
	formatMoney,
	percent,
	plural,
	shortDate,
} from "./dashboard-format.js";
import { type AttentionItem, attentionItems } from "./overview-items.js";

const href = (workspaceId: string, path: string) =>
	`#/w/${encodeURIComponent(workspaceId)}/${path}`;

const SEVERITY_LABELS: Record<AttentionItem["severity"], string> = {
	critical: "Urgent",
	warning: "Soon",
	info: "To do",
};

function AttentionList({ items }: { items: AttentionItem[] }) {
	return (
		<ul className="attention-list">
			{items.map((item) => (
				<li key={item.id}>
					<a href={item.href} className="attention-item">
						<span
							className={`attention-mark ${item.severity}`}
							aria-hidden="true"
						>
							{item.severity === "info" ? "" : "!"}
						</span>
						<span className="attention-text">
							<span className="visually-hidden">
								{SEVERITY_LABELS[item.severity]}:{" "}
							</span>
							<strong>{item.text}</strong>
							{item.detail && <small>{item.detail}</small>}
						</span>
					</a>
				</li>
			))}
		</ul>
	);
}

function NeedsYou({
	overview,
	workspaceId,
}: {
	overview: WorkspaceOverview;
	workspaceId: string;
}) {
	const items = attentionItems(overview, workspaceId);
	const yours = items.filter((item) => item.yours);
	const others = items.filter((item) => !item.yours);
	return (
		<section className="card needs-you" aria-labelledby="needs-you-heading">
			<h2 id="needs-you-heading">Needs you</h2>
			{yours.length ? (
				<AttentionList items={yours} />
			) : (
				<p className="needs-you-clear">
					Nothing needs you. Mentions, reviews, and problems show up here.
				</p>
			)}
			{others.length > 0 && (
				<>
					<h3 className="needs-you-subheading">Waiting on a workspace admin</h3>
					<AttentionList items={others} />
				</>
			)}
		</section>
	);
}

function Tile(props: { label: string; value: string; detail: string }) {
	return (
		<div className="tile">
			<p className="label">{props.label}</p>
			<p className="value">{props.value}</p>
			<p className="detail">{props.detail}</p>
		</div>
	);
}

/** A ratio against a limit. The fill turns amber near the limit and red at it. */
export function Meter({
	label,
	used,
	limit,
	format = count,
}: {
	label: string;
	used: number;
	limit: number;
	format?: (value: number) => string;
}) {
	const share = limit > 0 ? Math.min(used / limit, 1) : 0;
	const tone =
		limit > 0 && used >= limit
			? "critical"
			: share >= OVERVIEW_BUDGET_WARNING
				? "warning"
				: "normal";
	const text = `${format(used)} of ${format(limit)}${tone === "critical" ? ", at the limit" : ""}`;
	return (
		<div className="meter-row">
			<span className="meter-label">{label}</span>
			<meter
				className="visually-hidden"
				aria-label={label}
				min={0}
				max={limit}
				value={Math.min(used, limit)}
				aria-valuetext={text}
			/>
			<span className="meter" aria-hidden="true" title={`${label}: ${text}`}>
				<span
					className={`meter-fill ${tone}`}
					style={{ width: `${share * 100}%` }}
				/>
			</span>
			<span className="meter-value">
				{format(used)} / {format(limit)}
				{tone === "critical" && <em> · at limit</em>}
			</span>
		</div>
	);
}

const STATUS_LABELS: Record<OverviewAgent["status"], string> = {
	active: "Active",
	paused: "Paused",
	expired: "Expired",
	revoked: "Revoked",
};

function agentLine(agent: OverviewAgent) {
	if (agent.kind === "instructions")
		return agent.model ?? AGENT_KINDS.instructions;
	if (agent.kind === "oauth")
		return `${AGENT_KINDS.oauth} · ${plural(agent.connections, "app")} signed in`;
	return agent.expiresAt && agent.status === "active"
		? `${AGENT_KINDS.token} · expires ${shortDate(agent.expiresAt)}`
		: AGENT_KINDS.token;
}

function AgentsCard({
	overview,
	analytics,
	workspaceId,
}: {
	overview: WorkspaceOverview;
	analytics: UsageAnalytics | null;
	workspaceId: string;
}) {
	const usage = (agent: OverviewAgent) => {
		const model = analytics?.byCaller.find(
			(row) => row.id === `agent:${agent.id}`,
		);
		const web = analytics?.web.byCaller.find(
			(row) => row.id === `agent:${agent.id}`,
		);
		return {
			calls: model?.requests ?? 0,
			fetches: web?.fetches ?? 0,
			spend: (model?.estimatedCostUsd ?? 0) + (web?.costUsd ?? 0),
			// Unpriced calls cost something unknown, not nothing.
			known: Boolean(model?.pricedRequests || web?.fetches),
			unpriced: model ? model.requests - model.pricedRequests : 0,
		};
	};
	const rows = overview.agents
		.map((agent) => ({ agent, ...usage(agent) }))
		.sort(
			(a, b) =>
				b.spend - a.spend ||
				b.calls - a.calls ||
				a.agent.name.localeCompare(b.agent.name),
		);
	return (
		<section className="card" aria-labelledby="overview-agents-heading">
			<div className="analytics-card-heading">
				<div>
					<h2 id="overview-agents-heading">Agents</h2>
					<p className="card-note">
						Spend and calls in the period. Limits reset hourly and at midnight
						UTC.
					</p>
				</div>
				<a className="button" href={href(workspaceId, "agents")}>
					All agents
				</a>
			</div>
			{rows.length ? (
				<div className="table-scroll">
					<table className="events analytics-table overview-agents">
						<thead>
							<tr>
								<th>Agent</th>
								<th>Status</th>
								<th>Limits</th>
								<th className="num">Spend</th>
							</tr>
						</thead>
						<tbody>
							{rows.map(({ agent, calls, fetches, spend, known, unpriced }) => (
								<tr key={agent.id}>
									<td>
										<a
											className="analytics-link"
											href={href(workspaceId, `agents/${agent.id}`)}
										>
											{agent.name}
										</a>
										<span className="analytics-subtext">
											{agentLine(agent)}
										</span>
									</td>
									<td>
										<span
											className={`token-status ${agent.replying ? "active" : agent.status}`}
										>
											{agent.replying
												? "Replying…"
												: STATUS_LABELS[agent.status]}
										</span>
									</td>
									<td className="overview-limits">
										{agent.replies && agent.tokens ? (
											<>
												<Meter
													label="Replies this hour"
													used={agent.replies.used}
													limit={agent.replies.limit}
												/>
												<Meter
													label="Tokens today"
													used={agent.tokens.used}
													limit={agent.tokens.limit}
												/>
											</>
										) : (
											<span className="analytics-subtext">
												Set by the app that signs in
											</span>
										)}
									</td>
									<td className="num">
										{known ? formatMoney(spend) : "—"}
										<span className="analytics-subtext">
											{plural(calls, "call")} ·{" "}
											{plural(fetches, "fetch", "fetches")}
											{unpriced > 0 && ` · ${count(unpriced)} unpriced`}
										</span>
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			) : (
				<p className="empty-state">
					No agents yet. <a href={href(workspaceId, "agents")}>Create one</a> to
					answer in channels, or connect an MCP app.
				</p>
			)}
		</section>
	);
}

type SpendRow = {
	id: string;
	name: string;
	source: "model" | "proxy";
	costUsd: number;
	detail: string;
};

function SpendBySource({
	overview,
	analytics,
	workspaceId,
}: {
	overview: WorkspaceOverview;
	analytics: UsageAnalytics | null;
	workspaceId: string;
}) {
	const rows: SpendRow[] = [
		...(analytics?.byProvider ?? []).map((row) => ({
			id: `model:${row.id}`,
			name: row.name,
			source: "model" as const,
			costUsd: row.estimatedCostUsd,
			detail: `${plural(row.requests, "call")}${row.pricedRequests < row.requests ? ` · ${count(row.requests - row.pricedRequests)} unpriced` : ""}`,
		})),
		...(analytics?.web.byConnection ?? [])
			.filter((row) => row.id !== "direct")
			.map((row) => ({
				id: `proxy:${row.id}`,
				name: row.id,
				source: "proxy" as const,
				costUsd: row.costUsd,
				detail: plural(row.attempts, "request"),
			})),
	].sort((a, b) => b.costUsd - a.costUsd || a.name.localeCompare(b.name));
	const max = Math.max(0, ...rows.map((row) => row.costUsd));
	const total = rows.reduce((sum, row) => sum + row.costUsd, 0);
	return (
		<section className="card" aria-labelledby="spend-source-heading">
			<h2 id="spend-source-heading">Spend by source</h2>
			<p className="card-note">
				{formatMoney(total)} in the period. Model spend is estimated; proxies
				report theirs.
			</p>
			{rows.length ? (
				<>
					<ul className="spend-legend" aria-label="Sources">
						<li>
							<span className="swatch model" aria-hidden="true" /> Model
							connection
						</li>
						<li>
							<span className="swatch proxy" aria-hidden="true" /> Proxy
						</li>
					</ul>
					<ul className="spend-list">
						{rows.map((row) => (
							<li key={row.id} className="provider-spend">
								<div>
									<span>
										<strong>{row.name}</strong>{" "}
										<span className="spend-kind">
											{row.source === "model" ? "Model connection" : "Proxy"}
										</span>
									</span>
									<span>{formatMoney(row.costUsd)}</span>
								</div>
								<div
									className="spend-track"
									title={`${row.name}: ${formatMoney(row.costUsd)}, ${row.detail}`}
								>
									<span
										className={row.source}
										style={{
											width: `${max ? (row.costUsd / max) * 100 : 0}%`,
										}}
									/>
								</div>
								<p>{row.detail}</p>
							</li>
						))}
					</ul>
				</>
			) : (
				<p className="empty-state">No spending in this period.</p>
			)}
			<div className="budget-meter">
				<Meter
					label={`Proxy budget, ${overview.budget.month}`}
					used={overview.budget.spentUsd}
					limit={overview.budget.limitUsd}
					format={formatMoney}
				/>
				<a href={href(workspaceId, "proxies")}>Change the budget</a>
			</div>
		</section>
	);
}

function Recent({
	overview,
	channels,
	workspaceId,
}: {
	overview: WorkspaceOverview;
	channels: ChannelSummary[] | null;
	workspaceId: string;
}) {
	const channelName = new Map(channels?.map((item) => [item.id, item.name]));
	const unread = (channels ?? []).filter(
		(channel) => channel.unread && !channel.mentions,
	);
	const empty =
		!overview.failedRuns.length &&
		!unread.length &&
		!overview.recentNotes.length &&
		!overview.recentDecisions.length;
	return (
		<section className="card" aria-labelledby="recent-heading">
			<h2 id="recent-heading">Recent</h2>
			{empty && <p className="empty-state">Nothing new.</p>}
			{overview.failedRuns.length > 0 && (
				<>
					<h3 className="recent-heading">Replies that failed</h3>
					<ul className="recent-list">
						{overview.failedRuns.map((run) => (
							<li key={run.id}>
								<a href={href(workspaceId, `agents/${run.botId}`)}>
									{run.name} could not reply
									{channelName.get(run.channelId)
										? ` in #${channelName.get(run.channelId)}`
										: ""}
								</a>
								<small>
									{ago(run.createdAt)}
									{run.detail ? ` · ${run.detail}` : ""}
								</small>
							</li>
						))}
					</ul>
				</>
			)}
			{unread.length > 0 && (
				<>
					<h3 className="recent-heading">Unread channels</h3>
					<ul className="recent-list">
						{unread.map((channel) => (
							<li key={channel.id}>
								<a
									href={href(
										workspaceId,
										`channels/${encodeURIComponent(channel.name)}`,
									)}
								>
									#{channel.name}
								</a>
								{channel.lastMessageAt && (
									<small>{ago(channel.lastMessageAt)}</small>
								)}
							</li>
						))}
					</ul>
				</>
			)}
			{overview.recentNotes.length > 0 && (
				<>
					<h3 className="recent-heading">Shared notes</h3>
					<ul className="recent-list">
						{overview.recentNotes.map((note) => (
							<li key={note.title}>
								<a
									href={href(
										workspaceId,
										`synapse/${note.global ? "global" : "shared"}/${encodeURIComponent(note.title)}`,
									)}
								>
									{note.title}
								</a>
								<small>
									{note.global ? "Global · " : ""}changed {ago(note.updatedAt)}
								</small>
							</li>
						))}
					</ul>
				</>
			)}
			{overview.recentDecisions.length > 0 && (
				<>
					<h3 className="recent-heading">Proposals decided</h3>
					<ul className="recent-list">
						{overview.recentDecisions.map((decision) => (
							<li key={decision.id}>
								<span>
									{decision.status === "approved" ? "Approved" : "Rejected"} “
									{decision.title}” from {decision.author}
								</span>
								<small>
									{decision.decidedBy ? `${decision.decidedBy} · ` : ""}
									{ago(decision.decidedAt)}
								</small>
							</li>
						))}
					</ul>
				</>
			)}
		</section>
	);
}

/** The dashboard's home: what needs the person, agents, spend, and news. */
export function OverviewPanel({
	overview,
	analytics,
	channels,
	workspaceId,
	children,
}: {
	overview: WorkspaceOverview;
	analytics: UsageAnalytics | null;
	channels: ChannelSummary[] | null;
	workspaceId: string;
	/** The activity chart, which the Usage tab shares. */
	children?: ReactNode;
}) {
	const runs = overview.runs;
	const replies = runs.succeeded + runs.failed;
	const active = overview.agents.filter((agent) => agent.status === "active");
	const replying = overview.agents.filter((agent) => agent.replying).length;
	const modelSpend = analytics?.totals.estimatedCostUsd ?? 0;
	const webSpend = analytics?.web.totals.costUsd ?? 0;
	const unpriced = analytics
		? analytics.totals.requests - analytics.totals.pricedRequests
		: 0;
	return (
		<>
			<NeedsYou overview={overview} workspaceId={workspaceId} />
			<section
				className="tile-row overview-tiles"
				aria-label="Workspace totals"
			>
				<Tile
					label="Spend"
					value={analytics ? formatMoney(modelSpend + webSpend) : "—"}
					detail={
						analytics
							? `${formatMoney(modelSpend)} models · ${formatMoney(webSpend)} proxies${unpriced ? ` · ${plural(unpriced, "call")} unpriced` : ""}`
							: "Loading usage…"
					}
				/>
				<Tile
					label="Model calls"
					value={analytics ? count(analytics.totals.requests) : "—"}
					detail={
						analytics
							? `${percent(analytics.totals.requests - analytics.totals.errors, analytics.totals.requests)} succeeded`
							: "Loading usage…"
					}
				/>
				<Tile
					label="Agent replies"
					value={count(replies)}
					detail={`${count(runs.failed)} failed · ${count(runs.skipped)} skipped`}
				/>
				<Tile
					label="Web fetches"
					value={analytics ? count(analytics.web.totals.fetches) : "—"}
					detail={
						analytics?.web.totals.fetches
							? `${percent(analytics.web.totals.proxied, analytics.web.totals.fetches)} needed a proxy`
							: "None in this period"
					}
				/>
				<Tile
					label="Active agents"
					value={count(active.length)}
					detail={`${count(replying)} replying now · ${count(overview.agents.length)} in all`}
				/>
			</section>
			<AgentsCard
				overview={overview}
				analytics={analytics}
				workspaceId={workspaceId}
			/>
			<div className="analytics-split">
				<SpendBySource
					overview={overview}
					analytics={analytics}
					workspaceId={workspaceId}
				/>
				<Recent
					overview={overview}
					channels={channels}
					workspaceId={workspaceId}
				/>
			</div>
			{children}
		</>
	);
}
