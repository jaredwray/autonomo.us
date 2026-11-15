import type {
	AnalyticsBreakdown,
	AnalyticsQuery,
	ChannelSummary,
	UsageAnalytics,
	WebAnalytics,
	WorkspaceAccess,
	WorkspaceOverview,
} from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import {
	currentWorkspaceId,
	fetchDashboardData,
	fetchWorkspaceOverview,
} from "./api.js";
import { OverviewPanel } from "./DashboardOverview.js";
import {
	cost,
	costLabel,
	count,
	dateTime,
	formatMoney,
	percent,
	plain,
} from "./dashboard-format.js";
import {
	type DashboardTab,
	dashboardHash,
	parseDashboardTab,
} from "./dashboard-route.js";
import { PageTabs } from "./PageTabs.js";

const ranges = {
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
	"90d": "Last 90 days",
};
type Range = keyof typeof ranges;
type Metric = "requests" | "totalTokens" | "estimatedCostUsd";
const metricLabels: Record<Metric, string> = {
	requests: "Calls",
	totalTokens: "Tokens",
	estimatedCostUsd: "Spend",
};
const DASHBOARD_TABS = [
	{ id: "overview", label: "Overview" },
	{ id: "usage", label: "Usage" },
] as const;
type Filters = { provider: string; model: string; caller: string };
const NO_FILTERS: Filters = { provider: "", model: "", caller: "" };
/** Agents the gateway knows have UUIDs; older history may name others. */
const AGENT_ID = /^agent:([0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
const POLL_MS = 30_000;

function windowFor(range: Range) {
	const to = new Date();
	const days = range === "24h" ? 1 : Number.parseInt(range, 10);
	return {
		from: new Date(to.getTime() - days * 86_400_000).toISOString(),
		to: to.toISOString(),
	};
}

function StatTile(props: { label: string; value: string; detail: string }) {
	return (
		<div className="tile">
			<p className="label">{props.label}</p>
			<p className="value">{props.value}</p>
			<p className="detail">{props.detail}</p>
		</div>
	);
}

/** Quote cells and neutralize formula prefixes before opening in a spreadsheet. */
export function analyticsCsv(data: UsageAnalytics): string {
	const rows: unknown[][] = [
		[
			"From (UTC)",
			"To (UTC)",
			"Source",
			"Partial history",
			"Provider filter",
			"Model filter",
			"Caller filter",
		],
		[
			data.query.from,
			data.query.to,
			data.source,
			data.partial,
			data.query.provider ?? "",
			data.query.model ?? "",
			data.query.caller ?? "",
		],
		[],
		[
			"Breakdown",
			"ID",
			"Name",
			"Calls",
			"Errors",
			"Prompt tokens",
			"Completion tokens",
			"Total tokens",
			"Estimated USD (priced calls only)",
			"Priced calls",
			"Unpriced calls",
			"Avg successful latency ms",
			"Last active (UTC)",
		],
	];
	for (const [kind, items] of [
		[
			"Total",
			[
				{
					...data.totals,
					id: "total",
					name: "Total",
					lastSeen: data.generatedAt,
				},
			],
		],
		["Model", data.byModel],
		["Provider", data.byProvider],
		["Caller", data.byCaller],
		["Operation", data.byOperation],
		[
			"Time bucket",
			data.series.map((point) => ({
				...point,
				id: point.timestamp,
				name: point.timestamp,
				lastSeen: point.timestamp,
			})),
		],
	] as const)
		for (const row of items)
			rows.push([
				kind,
				row.id,
				row.name,
				row.requests,
				row.errors,
				row.promptTokens,
				row.completionTokens,
				row.totalTokens,
				row.pricedRequests ? row.estimatedCostUsd : "",
				row.pricedRequests,
				row.requests - row.pricedRequests,
				row.avgLatencyMs,
				row.lastSeen,
			]);
	// Web fetches: the caller filter applies; model and connection filters do not.
	rows.push(
		[],
		[
			"Web breakdown",
			"ID",
			"Name",
			"Fetches (requests for a connection)",
			"Succeeded",
			"Needed a proxy",
			"From cache",
			"Proxy USD",
			"Avg successful latency ms",
			"Last active (UTC)",
		],
	);
	const web = data.web;
	for (const [kind, items] of [
		[
			"Web total",
			[
				{
					...web.totals,
					id: "total",
					name: "Total",
					lastSeen: data.generatedAt,
				},
			],
		],
		["Web caller", web.byCaller],
		["Web site", web.byHost],
	] as const)
		for (const row of items)
			rows.push([
				kind,
				row.id,
				row.name,
				row.fetches,
				row.succeeded,
				row.proxied,
				row.cached,
				row.costUsd,
				row.avgLatencyMs,
				row.lastSeen,
			]);
	for (const row of web.byConnection)
		rows.push([
			"Web connection",
			row.id,
			row.id,
			row.attempts,
			row.succeeded,
			"",
			"",
			row.costUsd,
			"",
			row.lastSeen,
		]);
	for (const row of web.byOutcome)
		rows.push(["Web outcome", row.id, row.id, row.fetches]);
	return rows
		.map((row) =>
			row
				.map((value) => {
					const raw = String(value);
					const safe = /^[\s]*[=+@-]/.test(raw) ? `'${raw}` : raw;
					return `"${safe.replaceAll('"', '""')}"`;
				})
				.join(","),
		)
		.join("\r\n");
}

function exportReport(data: UsageAnalytics) {
	const url = URL.createObjectURL(
		new Blob([analyticsCsv(data)], { type: "text/csv;charset=utf-8" }),
	);
	const link = document.createElement("a");
	link.href = url;
	link.download = `gateway-usage-${data.query.from.slice(0, 10)}.csv`;
	link.click();
	setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function ActivityChart({ data }: { data: UsageAnalytics }) {
	const [metric, setMetric] = useState<Metric>("requests");
	const [selected, setSelected] = useState<number | null>(null);
	const max = Math.max(...data.series.map((point) => point[metric])) || 1;
	const point = selected === null ? undefined : data.series[selected];
	const label = (timestamp: string) =>
		new Date(timestamp).toLocaleString(
			undefined,
			data.bucket === "hour"
				? { month: "short", day: "numeric", hour: "numeric" }
				: { month: "short", day: "numeric", timeZone: "UTC" },
		);
	return (
		<section className="card" aria-labelledby="activity-heading">
			<div className="analytics-card-heading">
				<div>
					<h2 id="activity-heading">Activity over time</h2>
					<p className="card-note">
						{data.bucket === "hour"
							? "Hourly totals · your timezone"
							: "Daily totals · UTC days"}
						. Edge buckets may be partial.
					</p>
				</div>
				<fieldset className="metric-switch" aria-label="Chart metric">
					{(Object.keys(metricLabels) as Metric[]).map((key) => (
						<button
							type="button"
							key={key}
							aria-pressed={metric === key}
							onClick={() => setMetric(key)}
						>
							{metricLabels[key]}
						</button>
					))}
				</fieldset>
			</div>
			<section
				className="analytics-chart"
				aria-label={`${metricLabels[metric]} over time`}
			>
				<div className="chart-scale">
					<span>
						{metric === "estimatedCostUsd" ? formatMoney(max) : count(max)}
					</span>
					<span>0</span>
				</div>
				<div className="chart-columns">
					{data.series.map((item, index) => {
						const value =
							metric === "estimatedCostUsd"
								? costLabel(item)
								: count(item[metric]);
						return (
							<button
								type="button"
								className={`chart-column ${selected === index ? "selected" : ""}`}
								key={item.timestamp}
								aria-label={`${label(item.timestamp)}: ${value} ${metricLabels[metric].toLowerCase()}`}
								onFocus={() => setSelected(index)}
								onMouseEnter={() => setSelected(index)}
								onClick={() => setSelected(index)}
							>
								<span
									className="chart-bar"
									style={{
										height: `${Math.max((item[metric] / max) * 100, item[metric] > 0 ? 1 : 0)}%`,
									}}
								/>
							</button>
						);
					})}
				</div>
			</section>
			<div className="chart-axis">
				<span>{label(data.series[0].timestamp)}</span>
				<span>{label(data.series[data.series.length - 1].timestamp)}</span>
			</div>
			<p className="chart-detail">
				{point ? (
					<>
						{label(point.timestamp)} · {count(point.requests)} calls ·{" "}
						{count(point.totalTokens)} tokens · {costLabel(point)} estimated ·{" "}
						{count(point.errors)} errors
					</>
				) : (
					"Select or focus a bar to inspect its usage and spending."
				)}
			</p>
			{metric === "estimatedCostUsd" &&
				data.totals.pricedRequests < data.totals.requests && (
					<p className="analytics-notice">
						Spend includes priced calls only. Unpriced calls are excluded from
						the bars.
					</p>
				)}
		</section>
	);
}

function callerKindLabel(
	row: Pick<AnalyticsBreakdown, "id" | "provider" | "kind">,
) {
	if (row.provider) return row.provider;
	switch (row.kind) {
		case "api-token":
			return "API token";
		case "user":
			return "Team member";
		case "agent":
			return AGENT_ID.test(row.id) ? "Agent" : "Reported agent ID";
		case "owner":
			return "Owner credential (before team accounts)";
		default:
			return "No caller identity";
	}
}

function BreakdownTable({
	title,
	note,
	rows,
	kind,
	workspaceId,
	onSelect,
}: {
	title: string;
	note: string;
	rows: AnalyticsBreakdown[];
	kind: "model" | "caller";
	workspaceId: string;
	onSelect(id: string): void;
}) {
	const [sort, setSort] = useState<Metric | "errors" | "avgLatencyMs">(
		"requests",
	);
	const [page, setPage] = useState(0);
	const sorted = [...rows].sort(
		(a, b) => b[sort] - a[sort] || a.id.localeCompare(b.id),
	);
	const lastPage = Math.max(0, Math.ceil(rows.length / 10) - 1);
	const currentPage = Math.min(page, lastPage);
	const pageRows = sorted.slice(currentPage * 10, currentPage * 10 + 10);
	return (
		<section className="card" aria-label={title}>
			<div className="analytics-card-heading">
				<div>
					<h2>{title}</h2>
					<p className="card-note">{note}</p>
				</div>
				<label className="analytics-sort">
					Sort by
					<select
						aria-label={`Sort ${title.toLowerCase()}`}
						value={sort}
						onChange={(event) => {
							setSort(event.target.value as typeof sort);
							setPage(0);
						}}
					>
						<option value="requests">Calls</option>
						<option value="estimatedCostUsd">Spend</option>
						<option value="totalTokens">Tokens</option>
						<option value="errors">Errors</option>
						<option value="avgLatencyMs">Latency</option>
					</select>
				</label>
			</div>
			{rows.length ? (
				<>
					<div className="table-scroll">
						<table className="events analytics-table">
							<thead>
								<tr>
									<th>{kind === "model" ? "Model / connection" : "Caller"}</th>
									<th className="num">Calls</th>
									<th className="num">Tokens</th>
									<th className="num">Est. spend</th>
									<th className="num">Error rate</th>
									<th className="num">Avg latency</th>
									{kind === "caller" && <th>Last active</th>}
								</tr>
							</thead>
							<tbody>
								{pageRows.map((row) => {
									const agent = AGENT_ID.exec(row.id)?.[1];
									return (
										<tr key={row.id}>
											<td>
												<button
													className="analytics-link"
													type="button"
													onClick={() => onSelect(row.id)}
													title={`Filter by ${row.name}`}
												>
													{row.name}
												</button>
												<span className="analytics-subtext">
													{callerKindLabel(row)}
													{agent && workspaceId && (
														<>
															{" · "}
															<a
																href={`#/w/${encodeURIComponent(workspaceId)}/agents/${agent}`}
															>
																Open agent
															</a>
														</>
													)}
												</span>
											</td>
											<td className="num">{count(row.requests)}</td>
											<td
												className="num"
												title={`${plain.format(row.promptTokens)} prompt · ${plain.format(row.completionTokens)} completion`}
											>
												{count(row.totalTokens)}
												<span className="analytics-subtext">
													{count(row.promptTokens)} in ·{" "}
													{count(row.completionTokens)} out
												</span>
											</td>
											<td className="num">
												{cost(row)}
												{row.pricedRequests < row.requests && (
													<span className="analytics-subtext">
														{count(row.requests - row.pricedRequests)} unpriced
													</span>
												)}
											</td>
											<td
												className={`num ${row.errors ? "analytics-errors" : ""}`}
											>
												{percent(row.errors, row.requests)}
												<span className="analytics-subtext">
													{count(row.errors)} errors
												</span>
											</td>
											<td className="num">
												{row.requests > row.errors
													? `${count(row.avgLatencyMs)} ms`
													: "—"}
											</td>
											{kind === "caller" && (
												<td className="analytics-date">
													{dateTime(row.lastSeen)}
												</td>
											)}
										</tr>
									);
								})}
							</tbody>
						</table>
					</div>
					<div className="analytics-pagination">
						<span>
							{currentPage * 10 + 1}–
							{Math.min((currentPage + 1) * 10, rows.length)} of {rows.length}
						</span>
						<div>
							<button
								className="button"
								type="button"
								disabled={currentPage === 0}
								onClick={() => setPage(currentPage - 1)}
							>
								Previous
							</button>
							<button
								className="button"
								type="button"
								disabled={currentPage === lastPage}
								onClick={() => setPage(currentPage + 1)}
							>
								Next
							</button>
						</div>
					</div>
				</>
			) : (
				<p className="empty-state">No matching activity in this period.</p>
			)}
		</section>
	);
}

const OUTCOME_LABELS: Record<string, string> = {
	ok: "Returned a page",
	blocked: "Blocked by the site",
	"needs-render": "Needed JavaScript",
	"not-found": "Not found",
	"target-error": "The site failed",
	"provider-error": "A proxy failed",
	timeout: "Timed out",
	skipped: "No step could run",
	unknown: "Unknown (older history)",
};

function WebUsage({
	web,
	callerFiltered,
}: {
	web: WebAnalytics;
	callerFiltered: boolean;
}) {
	const { totals } = web;
	return (
		<>
			<section className="card" aria-labelledby="web-usage-heading">
				<h2 id="web-usage-heading">Web fetches</h2>
				<p className="card-note">
					Pages agents, people, and tokens read with web_fetch.{" "}
					{callerFiltered
						? "Filtered by caller; the model and connection filters do not apply."
						: "The model and connection filters do not apply."}
				</p>
				{totals.fetches ? (
					<>
						<dl className="web-stats">
							<div>
								<dt>Fetches</dt>
								<dd>{count(totals.fetches)}</dd>
							</div>
							<div>
								<dt>Returned a page</dt>
								<dd>{percent(totals.succeeded, totals.fetches)}</dd>
							</div>
							<div>
								<dt>Needed a proxy</dt>
								<dd>{percent(totals.proxied, totals.fetches)}</dd>
							</div>
							<div>
								<dt>Proxy cost</dt>
								<dd>{formatMoney(totals.costUsd)}</dd>
							</div>
							<div>
								<dt>From cache</dt>
								<dd>{count(totals.cached)}</dd>
							</div>
						</dl>
						<div className="analytics-split">
							<div>
								<h3 className="web-subheading">By connection</h3>
								<div className="table-scroll">
									<table
										className="events"
										aria-label="Web requests by connection"
									>
										<thead>
											<tr>
												<th>Connection</th>
												<th className="num">Requests</th>
												<th className="num">Succeeded</th>
												<th className="num">Cost</th>
											</tr>
										</thead>
										<tbody>
											{web.byConnection.map((row) => (
												<tr key={row.id}>
													<td>
														{row.id === "direct" ? "Plain request" : row.id}
													</td>
													<td className="num">{count(row.attempts)}</td>
													<td className="num">
														{percent(row.succeeded, row.attempts)}
													</td>
													<td className="num">{formatMoney(row.costUsd)}</td>
												</tr>
											))}
										</tbody>
									</table>
								</div>
							</div>
							<div>
								<h3 className="web-subheading">How fetches ended</h3>
								{web.byOutcome.map((row) => (
									<div className="operation-row" key={row.id}>
										<span>{OUTCOME_LABELS[row.id] ?? row.id}</span>
										<strong>{count(row.fetches)}</strong>
										<span>{percent(row.fetches, totals.fetches)}</span>
									</div>
								))}
							</div>
						</div>
					</>
				) : (
					<p className="empty-state">No web fetches in this period.</p>
				)}
			</section>
			{totals.fetches > 0 && (
				<div className="analytics-split">
					<section className="card" aria-labelledby="web-sites-heading">
						<h2 id="web-sites-heading">Sites fetched most</h2>
						<p className="card-note">
							Hosts only; the gateway never keeps paths.
						</p>
						<div className="table-scroll">
							<table className="events">
								<thead>
									<tr>
										<th>Site</th>
										<th className="num">Fetches</th>
										<th className="num">Needed a proxy</th>
										<th className="num">Cost</th>
									</tr>
								</thead>
								<tbody>
									{web.byHost.map((row) => (
										<tr key={row.id}>
											<td className="web-host">{row.name}</td>
											<td className="num">{count(row.fetches)}</td>
											<td className="num">{count(row.proxied)}</td>
											<td className="num">{formatMoney(row.costUsd)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
					<section className="card" aria-labelledby="web-callers-heading">
						<h2 id="web-callers-heading">Who fetched</h2>
						<p className="card-note">Agents, people, and API tokens.</p>
						<div className="table-scroll">
							<table className="events">
								<thead>
									<tr>
										<th>Caller</th>
										<th className="num">Fetches</th>
										<th className="num">Cost</th>
									</tr>
								</thead>
								<tbody>
									{web.byCaller.map((row) => (
										<tr key={row.id}>
											<td>
												{row.name}
												<span className="analytics-subtext">
													{callerKindLabel(row)}
												</span>
											</td>
											<td className="num">{count(row.fetches)}</td>
											<td className="num">{formatMoney(row.costUsd)}</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					</section>
				</div>
			)}
		</>
	);
}

/**
 * Usage analytics for a period, refreshed every 30 seconds while the tab is
 * visible. A report for other filters is never shown as this one's.
 */
function useAnalytics(range: Range, filters: Filters, refreshKey: number) {
	const [data, setData] = useState<UsageAnalytics | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const filterKey = JSON.stringify({ range, ...filters });
	const [loadedKey, setLoadedKey] = useState("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey deliberately triggers a manual refresh without clearing the last successful report; filterKey stands for range and filters.
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const query = (): AnalyticsQuery => ({ ...windowFor(range), ...filters });
		const refresh = async () => {
			setLoading(true);
			try {
				const result = await fetchDashboardData(query(), controller.signal);
				if (!stopped) {
					setData(result);
					setLoadedKey(filterKey);
					setError(null);
				}
			} catch (err) {
				if (!stopped)
					setError(
						err instanceof Error ? err.message : "Could not load analytics.",
					);
			} finally {
				if (!stopped) {
					setLoading(false);
					timer = setTimeout(poll, POLL_MS);
				}
			}
		};
		const poll = () => {
			if (!document.hidden) void refresh();
			else timer = setTimeout(poll, POLL_MS);
		};
		void refresh();
		return () => {
			stopped = true;
			controller.abort();
			clearTimeout(timer);
		};
	}, [filterKey, refreshKey]);
	return {
		current: data && loadedKey === filterKey ? data : null,
		loading,
		error,
	};
}

/** The workspace overview for a period, while the Overview tab is open. */
function useWorkspaceOverview(
	range: Range,
	refreshKey: number,
	enabled: boolean,
	onOverview?: (overview: WorkspaceOverview) => void,
) {
	const [state, setState] = useState<{
		key: Range | null;
		overview: WorkspaceOverview | null;
		error: string | null;
		loading: boolean;
	}>({ key: null, overview: null, error: null, loading: enabled });
	const report = useRef(onOverview);
	report.current = onOverview;
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey deliberately triggers a manual refresh.
	useEffect(() => {
		if (!enabled) return;
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const refresh = async () => {
			setState((current) => ({ ...current, loading: true }));
			try {
				const overview = await fetchWorkspaceOverview(
					windowFor(range),
					controller.signal,
				);
				if (!stopped) {
					setState({ key: range, overview, error: null, loading: false });
					report.current?.(overview);
				}
			} catch (err) {
				if (!stopped)
					setState((current) => ({
						...current,
						loading: false,
						error:
							err instanceof Error
								? err.message
								: "The overview could not be loaded.",
					}));
			} finally {
				if (!stopped) timer = setTimeout(poll, POLL_MS);
			}
		};
		const poll = () => {
			if (!document.hidden) void refresh();
			else timer = setTimeout(poll, POLL_MS);
		};
		void refresh();
		return () => {
			stopped = true;
			controller.abort();
			clearTimeout(timer);
		};
	}, [range, refreshKey, enabled]);
	return {
		current: state.key === range ? state.overview : null,
		error: state.error,
		loading: state.loading,
	};
}

type Chip = {
	tone: "good" | "warning" | "critical" | "muted";
	text: string;
	title?: string;
};

/** What the header says about the gateway, worst first. */
function healthChips(
	analyticsError: string | null,
	overviewError: string | null,
	health: WorkspaceOverview["health"] | null,
	loaded: boolean,
): Chip[] {
	const chips: Chip[] = [];
	if (analyticsError)
		chips.push({
			tone: "critical",
			text: "Analytics unavailable",
			title: analyticsError,
		});
	if (overviewError)
		chips.push({
			tone: "critical",
			text: "Overview unavailable",
			title: overviewError,
		});
	if (health?.telemetry === "failing")
		chips.push({
			tone: "critical",
			text: "Usage history failing",
			title:
				"Writing usage to MongoDB is failing. Reports show what this gateway process still holds.",
		});
	if (health?.persistence === "memory")
		chips.push({
			tone: "warning",
			text: "Not saved to a database",
			title:
				"Settings and history last until the API restarts. Connect MongoDB to keep them.",
		});
	if (health && !health.webAvailable)
		chips.push({
			tone: "warning",
			text: "Web access off",
			title:
				"The gateway's operator turned web access off. Agents cannot fetch pages.",
		});
	if (!chips.length)
		chips.push(
			loaded
				? { tone: "good", text: "Gateway healthy" }
				: { tone: "muted", text: "Connecting…" },
		);
	return chips;
}

function PeriodSelect({
	range,
	onChange,
}: {
	range: Range;
	onChange(range: Range): void;
}) {
	return (
		<label>
			Period
			<select
				value={range}
				onChange={(event) => onChange(event.target.value as Range)}
			>
				{Object.entries(ranges).map(([key, name]) => (
					<option key={key} value={key}>
						{name}
					</option>
				))}
			</select>
		</label>
	);
}

function UsagePanel({
	range,
	setRange,
	filters,
	setFilters,
	analytics,
	loading,
	error,
	workspaceId,
	onRetry,
}: {
	range: Range;
	setRange(range: Range): void;
	filters: Filters;
	setFilters(filters: Filters): void;
	analytics: UsageAnalytics | null;
	loading: boolean;
	error: string | null;
	workspaceId: string;
	onRetry(): void;
}) {
	const current = analytics;
	const hasFilters = Boolean(
		filters.model || filters.provider || filters.caller,
	);
	return (
		<>
			<fieldset className="analytics-filters" aria-label="Analytics filters">
				<PeriodSelect range={range} onChange={setRange} />
				<label>
					Connection
					<select
						value={filters.provider}
						onChange={(event) =>
							setFilters({
								...filters,
								provider: event.target.value,
								model: "",
							})
						}
					>
						<option value="">All connections</option>
						{filters.provider &&
							!current?.options.providers.includes(filters.provider) && (
								<option value={filters.provider}>{filters.provider}</option>
							)}
						{current?.options.providers.map((provider) => (
							<option key={provider}>{provider}</option>
						))}
					</select>
				</label>
				<label>
					Model
					<select
						value={filters.model}
						onChange={(event) =>
							setFilters({ ...filters, model: event.target.value })
						}
					>
						<option value="">All models</option>
						{filters.model &&
							!current?.options.models.some(
								(model) => model.id === filters.model,
							) && <option value={filters.model}>{filters.model}</option>}
						{current?.options.models
							.filter(
								(model) =>
									!filters.provider || model.provider === filters.provider,
							)
							.map((model) => (
								<option key={model.id}>{model.id}</option>
							))}
					</select>
				</label>
				<label>
					Caller
					<select
						value={filters.caller}
						onChange={(event) =>
							setFilters({ ...filters, caller: event.target.value })
						}
					>
						<option value="">All callers</option>
						{filters.caller &&
							!current?.options.callers.some(
								(caller) => caller.id === filters.caller,
							) && <option value={filters.caller}>{filters.caller}</option>}
						{current?.options.callers.map((caller) => (
							<option key={caller.id} value={caller.id}>
								{caller.name} ({caller.kind})
							</option>
						))}
					</select>
				</label>
				{hasFilters && (
					<button
						className="button"
						type="button"
						onClick={() => setFilters(NO_FILTERS)}
					>
						Clear filters
					</button>
				)}
				<button
					className="button"
					type="button"
					disabled={!current || loading || Boolean(error)}
					onClick={() => current && exportReport(current)}
				>
					Export CSV
				</button>
			</fieldset>
			{error && (
				<div className="banner-error" role="alert">
					<strong>Could not refresh analytics.</strong>{" "}
					{current
						? `Showing the last successful update from ${dateTime(current.generatedAt)}. `
						: "No report is available for this selection. "}
					Retrying automatically.{" "}
					<button className="button" type="button" onClick={onRetry}>
						Retry
					</button>
				</div>
			)}
			{!current ? (
				<div className="card empty-state" role="status">
					{loading
						? "Loading usage analytics…"
						: "Analytics could not be loaded."}
				</div>
			) : (
				<>
					<div className="analytics-meta">
						<span>
							{current.source === "mongodb"
								? "Durable history"
								: "In-memory history"}{" "}
							· Updated {dateTime(current.generatedAt)}
							{loading ? " · Refreshing…" : " · Refreshes every 30 seconds"}
						</span>
					</div>
					{(current.partial || current.durableUnavailable) && (
						<p className="analytics-notice" role="status">
							{current.durableUnavailable
								? "Durable analytics are unavailable. "
								: ""}
							This report uses retained activity from this gateway process
							{current.coverageFrom
								? ` since ${dateTime(current.coverageFrom)}`
								: ""}
							. Earlier activity may be missing.
						</p>
					)}
					<section
						className="tile-row analytics-tiles"
						aria-label="Usage totals"
					>
						<StatTile
							label="Model calls"
							value={count(current.totals.requests)}
							detail={`${count(current.byModel.length)} models · ${count(current.byProvider.length)} connections`}
						/>
						<StatTile
							label="Estimated spend"
							value={cost(current.totals)}
							detail={`${count(current.totals.pricedRequests)} of ${count(current.totals.requests)} calls priced${current.totals.pricedRequests < current.totals.requests ? " · partial" : ""}`}
						/>
						<StatTile
							label="Total tokens"
							value={count(current.totals.totalTokens)}
							detail={`${count(current.totals.promptTokens)} prompt · ${count(current.totals.completionTokens)} completion`}
						/>
						<StatTile
							label="Active callers"
							value={count(current.activeCallers)}
							detail={`${count(current.unattributedRequests)} unattributed calls`}
						/>
						<StatTile
							label="Success rate"
							value={percent(
								current.totals.requests - current.totals.errors,
								current.totals.requests,
							)}
							detail={`${count(current.totals.errors)} errors across all attempts`}
						/>
						<StatTile
							label="Avg latency"
							value={
								current.totals.requests > current.totals.errors
									? `${count(current.totals.avgLatencyMs)} ms`
									: "—"
							}
							detail="Successful calls · includes full streams"
						/>
					</section>
					{current.totals.requests === 0 && (
						<div className="card empty-state">
							<h2>No activity in this period</h2>
							<p>
								{hasFilters
									? "Try clearing filters or choosing a longer period."
									: "Usage will appear when calls pass through the gateway. Try a longer period to see earlier activity."}
							</p>
						</div>
					)}
					<ActivityChart data={current} />
					<BreakdownTable
						title="Usage by model"
						note="Compare token volume, cost, and reliability. Select a model to drill down."
						rows={current.byModel}
						kind="model"
						workspaceId={workspaceId}
						onSelect={(model) => setFilters({ ...filters, model })}
					/>
					<div className="analytics-split">
						<section className="card" aria-label="Spending by connection">
							<h2>Spending by connection</h2>
							<p className="card-note">Estimated USD from priced calls</p>
							{current.byProvider.length ? (
								[...current.byProvider]
									.sort((a, b) => b.estimatedCostUsd - a.estimatedCostUsd)
									.map((row) => (
										<div className="provider-spend" key={row.id}>
											<div>
												<button
													className="analytics-link"
													type="button"
													onClick={() =>
														setFilters({
															...filters,
															provider: row.id,
															model: "",
														})
													}
												>
													{row.name}
												</button>
												<span>{costLabel(row)}</span>
											</div>
											<div className="spend-track">
												<span
													style={{
														width: `${current.totals.estimatedCostUsd ? (row.estimatedCostUsd / current.totals.estimatedCostUsd) * 100 : 0}%`,
													}}
												/>
											</div>
											<p>
												{count(row.requests)} calls · {count(row.totalTokens)}{" "}
												tokens
											</p>
										</div>
									))
							) : (
								<p className="empty-state">No connection activity.</p>
							)}
						</section>
						<section className="card" aria-label="Call mix">
							<h2>Call mix</h2>
							<p className="card-note">
								Includes automatic routing selectors and fallback attempts.
							</p>
							{current.byOperation.map((row) => (
								<div className="operation-row" key={row.id}>
									<span>
										{row.id === "chat"
											? "Chat completions"
											: row.id === "routing"
												? "Routing selectors"
												: row.id === "decisions"
													? "Decisions"
													: "Legacy / unknown"}
									</span>
									<strong>{count(row.requests)}</strong>
									<span>{percent(row.requests, current.totals.requests)}</span>
								</div>
							))}
							<p className="analytics-explanation">
								A single gateway request can make several model calls. Errors
								count failed model attempts; latency measures successful calls.
							</p>
						</section>
					</div>
					<BreakdownTable
						title="Users & callers"
						note="Recorded identities (API tokens, team members, and agents) take priority over agent IDs a client reports. Shared credentials do not identify unique people."
						rows={current.byCaller}
						kind="caller"
						workspaceId={workspaceId}
						onSelect={(caller) => setFilters({ ...filters, caller })}
					/>
					<WebUsage
						web={current.web}
						callerFiltered={Boolean(filters.caller)}
					/>
					<p className="analytics-footnote">
						Spending estimates use{" "}
						<a href="https://models.dev" target="_blank" rel="noreferrer">
							models.dev
						</a>{" "}
						input/output rates captured when each call completes. They exclude
						cache discounts, tiered pricing, and other provider fees. Missing
						rates, failed calls, and older unpriced activity remain unknown.
						Proxy costs are what each proxy reported or the gateway estimated.
						These estimates are not invoices.
					</p>
				</>
			)}
		</>
	);
}

/**
 * A workspace's dashboard. Overview answers what needs the person, what
 * the agents are doing, and what it costs; Usage holds the full model and
 * web analytics.
 */
export function Dashboard({
	workspace,
	channels = null,
	overview: shellOverview = null,
	onOverview,
}: {
	workspace?: WorkspaceAccess;
	/** The shell's channel list, for channel names and unread channels. */
	channels?: ChannelSummary[] | null;
	/** The shell's latest overview, for health while Usage is open. */
	overview?: WorkspaceOverview | null;
	/** Hands each overview this page reads to the shell, for the sidebar. */
	onOverview?(overview: WorkspaceOverview): void;
} = {}) {
	const [tab, setTab] = useState<DashboardTab>(() =>
		parseDashboardTab(window.location.hash),
	);
	useEffect(() => {
		const sync = () => setTab(parseDashboardTab(window.location.hash));
		window.addEventListener("hashchange", sync);
		return () => window.removeEventListener("hashchange", sync);
	}, []);
	const showTab = useCallback((next: DashboardTab) => {
		const hash = dashboardHash(next);
		if (window.location.hash !== hash) window.history.pushState(null, "", hash);
		setTab(next);
	}, []);
	const [range, setRange] = useState<Range>("24h");
	const [filters, setFilters] = useState<Filters>(NO_FILTERS);
	const [refreshKey, setRefreshKey] = useState(0);
	const analytics = useAnalytics(
		range,
		tab === "usage" ? filters : NO_FILTERS,
		refreshKey,
	);
	const overview = useWorkspaceOverview(
		range,
		refreshKey,
		tab === "overview",
		onOverview,
	);
	const workspaceId = workspace?.id ?? currentWorkspaceId() ?? "";
	const health = (overview.current ?? shellOverview)?.health ?? null;
	const chips = healthChips(
		analytics.error,
		tab === "overview" ? overview.error : null,
		health,
		Boolean(analytics.current || overview.current),
	);
	const loading = analytics.loading || (tab === "overview" && overview.loading);
	const retry = () => setRefreshKey((key) => key + 1);
	return (
		<div className="dashboard analytics-dashboard">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">{workspace?.name ?? "Workspace"}</p>
					<h1>Dashboard</h1>
					<p className="page-description">
						What needs you, what your agents are doing, and what it costs.
					</p>
				</div>
				<div className="status-chips">
					{chips.map((chip) => (
						<span className="chip" key={chip.text} title={chip.title}>
							<span className={`dot dot-${chip.tone}`} />
							{chip.text}
						</span>
					))}
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={retry}
					>
						Refresh
					</button>
				</div>
			</header>
			<PageTabs
				label="Dashboard sections"
				idPrefix="dashboard"
				tabs={DASHBOARD_TABS}
				selected={tab}
				onSelect={showTab}
			/>
			<div
				role="tabpanel"
				id="dashboard-panel"
				aria-labelledby={`dashboard-tab-${tab}`}
			>
				{tab === "usage" ? (
					<UsagePanel
						range={range}
						setRange={setRange}
						filters={filters}
						setFilters={setFilters}
						analytics={analytics.current}
						loading={analytics.loading}
						error={analytics.error}
						workspaceId={workspaceId}
						onRetry={retry}
					/>
				) : (
					<>
						<fieldset
							className="analytics-filters overview-period"
							aria-label="Overview period"
						>
							<PeriodSelect range={range} onChange={setRange} />
							<p className="card-note">
								Spend, calls, replies, and fetches in this period. What is
								waiting is always current.
							</p>
						</fieldset>
						{overview.error && (
							<div className="banner-error" role="alert">
								<strong>Could not refresh the overview.</strong>{" "}
								{overview.current
									? `Showing the last update from ${dateTime(overview.current.generatedAt)}. `
									: `${overview.error} `}
								Retrying automatically.{" "}
								<button className="button" type="button" onClick={retry}>
									Retry
								</button>
							</div>
						)}
						{overview.current ? (
							<OverviewPanel
								overview={overview.current}
								analytics={analytics.current}
								channels={channels}
								workspaceId={workspaceId}
							>
								{analytics.current && (
									<ActivityChart data={analytics.current} />
								)}
							</OverviewPanel>
						) : (
							<div className="card empty-state" role="status">
								{overview.loading
									? "Loading the overview…"
									: "The overview could not be loaded."}
							</div>
						)}
					</>
				)}
			</div>
		</div>
	);
}
