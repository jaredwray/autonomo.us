import type { AnalyticsBreakdown, UsageAnalytics } from "@autonomo.us/common";
import { useCallback, useEffect, useRef, useState } from "react";
import { fetchDashboardData } from "./api.js";
import { costLabel, count, dateTime } from "./dashboard-format.js";
import { dashboardHash } from "./dashboard-route.js";
import { LoadingBanner } from "./LoadingBanner.js";

type Metric = "totalTokens" | "requests" | "estimatedCostUsd";
const METRIC_LABELS: Record<Metric, string> = {
	totalTokens: "Tokens",
	requests: "Calls",
	estimatedCostUsd: "Spend",
};
/** The window the chart covers, in days, ending now. */
export const USAGE_DAYS = 30;
/** Models shown; the rest are counted below the bars. */
export const USAGE_TOP = 8;

/** What a row counts for a metric. Unpriced calls count no spend. */
function metricValue(row: AnalyticsBreakdown, metric: Metric): number {
	if (metric === "estimatedCostUsd")
		return row.pricedRequests ? row.estimatedCostUsd : 0;
	return row[metric];
}

/** The model's name, and its connection when the name does not already say it. */
function ModelName({ row }: { row: AnalyticsBreakdown }) {
	const name = row.name || row.id;
	const provider =
		row.provider && !name.startsWith(`${row.provider}/`) ? row.provider : "";
	return (
		<span className="name" title={row.id}>
			{name}
			{provider && <span className="provider"> · {provider}</span>}
		</span>
	);
}

/**
 * The LLM tab's usage chart: the models called most in the last 30 days,
 * by tokens, calls, or estimated spend, as ranked bars. It reads the same
 * analytics as the Dashboard's Usage tab and fails on its own, without
 * touching the list of models below it.
 */
export function ModelUsageChart({
	refreshKey = 0,
}: {
	/** Changing it reads the usage again. */
	refreshKey?: number;
}) {
	const [data, setData] = useState<UsageAnalytics | null>(null);
	const [error, setError] = useState(false);
	const [loading, setLoading] = useState(true);
	const [metric, setMetric] = useState<Metric>("totalTokens");
	const controller = useRef<AbortController | null>(null);

	const load = useCallback(async () => {
		controller.current?.abort();
		const current = new AbortController();
		controller.current = current;
		setLoading(true);
		const to = new Date();
		const from = new Date(to.getTime() - USAGE_DAYS * 86_400_000);
		try {
			const result = await fetchDashboardData(
				{ from: from.toISOString(), to: to.toISOString() },
				current.signal,
			);
			if (current.signal.aborted) return;
			setData(result);
			setError(false);
		} catch {
			if (current.signal.aborted) return;
			setError(true);
		} finally {
			if (!current.signal.aborted) setLoading(false);
		}
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: refreshKey asks for a fresh read.
	useEffect(() => {
		void load();
	}, [load, refreshKey]);
	useEffect(() => () => controller.current?.abort(), []);

	const rows = (data?.byModel ?? [])
		.map((row) => ({ row, value: metricValue(row, metric) }))
		.filter(
			({ row, value }) =>
				value > 0 || (metric === "estimatedCostUsd" && row.requests > 0),
		)
		.sort(
			(a, b) =>
				b.value - a.value ||
				b.row.requests - a.row.requests ||
				a.row.id.localeCompare(b.row.id),
		);
	const shown = rows.slice(0, USAGE_TOP);
	const more = rows.length - shown.length;
	const max = Math.max(...shown.map((item) => item.value), 0);
	const empty = data !== null && data.totals.requests === 0;
	const unpriced =
		metric === "estimatedCostUsd" &&
		data !== null &&
		data.totals.pricedRequests < data.totals.requests;

	return (
		<section
			className="card model-usage"
			aria-labelledby="model-usage-heading"
			aria-busy={loading && Boolean(data)}
		>
			<div className="analytics-card-heading">
				<div>
					<h2 id="model-usage-heading">Usage by model</h2>
					<p className="card-note">Last {USAGE_DAYS} days.</p>
				</div>
				{data && !empty && (
					<fieldset className="metric-switch" aria-label="Usage metric">
						{(Object.keys(METRIC_LABELS) as Metric[]).map((key) => (
							<button
								type="button"
								key={key}
								aria-pressed={metric === key}
								onClick={() => setMetric(key)}
							>
								{METRIC_LABELS[key]}
							</button>
						))}
					</fieldset>
				)}
			</div>
			{!data ? (
				<div className="model-usage-state">
					{loading ? (
						<LoadingBanner>Loading usage…</LoadingBanner>
					) : (
						<p>
							Usage could not be loaded.{" "}
							<button
								className="button"
								type="button"
								onClick={() => void load()}
							>
								Retry
							</button>
						</p>
					)}
				</div>
			) : empty ? (
				<div className="model-usage-state">
					<h3>No model calls in the last {USAGE_DAYS} days</h3>
					<p>Usage shows here once agents or people call a model.</p>
				</div>
			) : (
				<>
					{error && (
						<p className="field-hint" role="status">
							Usage could not be refreshed; this is the last read.{" "}
							<button
								className="link-button"
								type="button"
								onClick={() => void load()}
							>
								Retry
							</button>
						</p>
					)}
					{metric === "totalTokens" && (
						<div className="legend" aria-hidden="true">
							<span className="key">
								<span className="swatch swatch-prompt" />
								Prompt
							</span>
							<span className="key">
								<span className="swatch swatch-completion" />
								Completion
							</span>
						</div>
					)}
					<ol
						className="model-usage-list"
						aria-label={`${METRIC_LABELS[metric]} by model, last ${USAGE_DAYS} days`}
					>
						{shown.map(({ row, value }) => {
							const width = max > 0 ? Math.max((value / max) * 100, 1) : 0;
							const split =
								metric === "totalTokens" &&
								row.promptTokens + row.completionTokens > 0;
							return (
								<li className="model-row" key={row.id}>
									<ModelName row={row} />
									<span className="bar-track" aria-hidden="true">
										{value > 0 && (
											<span className="bar" style={{ width: `${width}%` }}>
												{split ? (
													<>
														{row.promptTokens > 0 && (
															<span
																className="segment segment-prompt"
																style={{ flex: row.promptTokens }}
															/>
														)}
														{row.completionTokens > 0 && (
															<span
																className="segment segment-completion"
																style={{ flex: row.completionTokens }}
															/>
														)}
													</>
												) : (
													<span
														className="segment segment-prompt"
														style={{ flex: 1 }}
													/>
												)}
											</span>
										)}
									</span>
									<span className="value">
										{metric === "estimatedCostUsd"
											? costLabel(row)
											: count(value)}
									</span>
								</li>
							);
						})}
					</ol>
					{shown.length === 0 && (
						<p className="field-hint">
							No {METRIC_LABELS[metric].toLowerCase()} recorded in the last{" "}
							{USAGE_DAYS} days.
						</p>
					)}
					<p className="card-note model-usage-foot">
						{more > 0 && <>And {count(more)} more models. </>}
						{unpriced && "Spend counts priced calls only. "}
						{(data.partial || data.durableUnavailable) && (
							<>
								Counts activity this gateway process kept
								{data.coverageFrom
									? ` since ${dateTime(data.coverageFrom)}`
									: ""}
								; earlier calls may be missing.{" "}
							</>
						)}
						<a href={dashboardHash("usage")}>See all usage</a>
					</p>
				</>
			)}
		</section>
	);
}
