import type {
	AnalyticsBreakdown,
	AnalyticsQuery,
	UsageAnalytics,
	UsageMetrics,
} from "@autonomo.us/common";
import { useEffect, useState } from "react";
import { fetchDashboardData } from "./api.js";

const plain = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });
const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
	maximumFractionDigits: 4,
});
const count = (value: number) =>
	value >= 10_000 ? compact.format(value) : plain.format(value);
const percent = (value: number, total: number) =>
	total ? `${plain.format((value / total) * 100)}%` : "—";
const formatMoney = (value: number) =>
	value > 0 && value < 0.0001 ? "<$0.0001" : money.format(value);
const cost = (row: UsageMetrics) =>
	row.pricedRequests ? formatMoney(row.estimatedCostUsd) : "—";
const costLabel = (row: UsageMetrics) =>
	`${cost(row)}${row.pricedRequests && row.pricedRequests < row.requests ? " + unknown" : ""}`;
const dateTime = (value: string) => new Date(value).toLocaleString();
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

function BreakdownTable({
	title,
	note,
	rows,
	kind,
	onSelect,
}: {
	title: string;
	note: string;
	rows: AnalyticsBreakdown[];
	kind: "model" | "caller";
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
								{pageRows.map((row) => (
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
												{row.provider ??
													(row.kind === "api-token"
														? "API token"
														: row.kind === "agent"
															? "Reported agent ID"
															: row.kind === "owner"
																? "Owner credential"
																: "No caller identity")}
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
								))}
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

export function Dashboard() {
	const [range, setRange] = useState<Range>("24h");
	const [filters, setFilters] = useState({
		provider: "",
		model: "",
		caller: "",
	});
	const [data, setData] = useState<UsageAnalytics | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(true);
	const [refreshKey, setRefreshKey] = useState(0);
	const filterKey = JSON.stringify({ range, ...filters });
	const [loadedKey, setLoadedKey] = useState("");
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey deliberately triggers a manual refresh without clearing the last successful report.
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout>;
		let stopped = false;
		const refresh = async () => {
			setLoading(true);
			try {
				const to = new Date();
				const days = range === "24h" ? 1 : Number.parseInt(range, 10);
				const query: AnalyticsQuery = {
					from: new Date(to.getTime() - days * 86_400_000).toISOString(),
					to: to.toISOString(),
					...filters,
				};
				const result = await fetchDashboardData(query, controller.signal);
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
					timer = setTimeout(poll, 30_000);
				}
			}
		};
		const poll = () => {
			if (!document.hidden) void refresh();
			else timer = setTimeout(poll, 30_000);
		};
		void refresh();
		return () => {
			stopped = true;
			controller.abort();
			clearTimeout(timer);
		};
	}, [range, filters, filterKey, refreshKey]);
	const current = data && loadedKey === filterKey ? data : null;
	const hasFilters = Boolean(
		filters.model || filters.provider || filters.caller,
	);
	return (
		<div className="dashboard analytics-dashboard">
			<header className="dashboard-header">
				<div>
					<p className="eyebrow">Gateway intelligence</p>
					<h1>Dashboard</h1>
					<p className="page-description">
						Understand model usage, spending, and the callers behind it.
					</p>
				</div>
				<div className="status-chips">
					<span className="chip">
						<span
							className={`dot ${error ? "dot-critical" : data ? "dot-good" : "dot-muted"}`}
						/>
						{error
							? "Analytics unavailable"
							: data
								? "API connected"
								: "Connecting…"}
					</span>
					<button
						className="button"
						type="button"
						disabled={loading}
						onClick={() => setRefreshKey((key) => key + 1)}
					>
						Refresh
					</button>
				</div>
			</header>
			<fieldset className="analytics-filters" aria-label="Analytics filters">
				<label>
					Period
					<select
						value={range}
						onChange={(event) => setRange(event.target.value as Range)}
					>
						{Object.entries(ranges).map(([key, name]) => (
							<option key={key} value={key}>
								{name}
							</option>
						))}
					</select>
				</label>
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
							!data?.options.providers.includes(filters.provider) && (
								<option value={filters.provider}>{filters.provider}</option>
							)}
						{data?.options.providers.map((provider) => (
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
							!data?.options.models.some(
								(model) => model.id === filters.model,
							) && <option value={filters.model}>{filters.model}</option>}
						{data?.options.models
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
							!data?.options.callers.some(
								(caller) => caller.id === filters.caller,
							) && <option value={filters.caller}>{filters.caller}</option>}
						{data?.options.callers.map((caller) => (
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
						onClick={() => setFilters({ provider: "", model: "", caller: "" })}
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
					<button
						className="button"
						type="button"
						onClick={() => setRefreshKey((key) => key + 1)}
					>
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
							{current.source === "clickhouse"
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
						note="API token identities take priority over reported agent IDs. Shared credentials do not identify unique people."
						rows={current.byCaller}
						kind="caller"
						onSelect={(caller) => setFilters({ ...filters, caller })}
					/>
					<p className="analytics-footnote">
						Spending estimates use{" "}
						<a href="https://models.dev" target="_blank" rel="noreferrer">
							models.dev
						</a>{" "}
						input/output rates captured when each call completes. They exclude
						cache discounts, tiered pricing, and other provider fees. Missing
						rates, failed calls, and older unpriced activity remain unknown.
						These estimates are not invoices.
					</p>
				</>
			)}
		</div>
	);
}
