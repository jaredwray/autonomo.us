import type { LoopSummary } from "@autonomo.us/common";
import {
	countNumber,
	loopLink,
	observedTime,
	percentNumber,
} from "./loops-state.js";

const statuses = {
	on_target: "On target",
	off_target: "Off target",
	stale: "Stale data",
	no_data: "No data",
} as const;

function MetricTrend({ loop }: { loop: LoopSummary }) {
	const samples = loop.trend.flatMap((p) =>
		p.value === null ? [] : [p.value],
	);
	if (!samples.length) return null;
	const low = Math.min(loop.metric.target, ...samples);
	const span = Math.max(1, Math.max(loop.metric.target, ...samples) - low);
	const x = (i: number) => 4 + (i * 142) / Math.max(1, loop.trend.length - 1);
	const y = (value: number) => 48 - ((value - low) / span) * 36;
	return (
		<svg
			className="loop-trend"
			viewBox="0 0 152 58"
			role="img"
			aria-label={`Seven-day ${loop.metric.name} trend, target ${percentNumber.format(loop.metric.target)}%`}
		>
			<line
				x1="4"
				x2="146"
				y1={y(loop.metric.target)}
				y2={y(loop.metric.target)}
				stroke="var(--text-muted)"
				strokeDasharray="4 3"
			/>
			{loop.trend.map((p, i) => {
				if (p.value === null) return null;
				const previous = loop.trend[i - 1];
				return (
					<g key={p.day}>
						{previous && previous.value !== null && (
							<line
								x1={x(i - 1)}
								x2={x(i)}
								y1={y(previous.value)}
								y2={y(p.value)}
								stroke="currentColor"
								strokeWidth="2"
							/>
						)}
						<circle cx={x(i)} cy={y(p.value)} r="2.4" fill="currentColor">
							<title>
								{p.day} · {percentNumber.format(p.value)}%
							</title>
						</circle>
					</g>
				);
			})}
		</svg>
	);
}

export function LoopMetric({
	loop,
	href,
}: {
	loop: LoopSummary;
	href?: string;
}) {
	const point = loop.current;
	const target = `${loop.metric.direction === "at_least" ? "≥" : "≤"} ${percentNumber.format(loop.metric.target)}%`;
	const improving =
		loop.change !== null &&
		(loop.metric.direction === "at_least" ? loop.change > 0 : loop.change < 0);
	const display =
		point?.value != null ? `${percentNumber.format(point.value)}%` : "—";
	return (
		<>
			<div className="loop-metric">
				<div>
					<div className="loop-muted">{loop.metric.name}</div>
					<strong className="loop-value">
						{href && point?.value != null ? (
							<a
								href={href}
								aria-label={`Inspect ${loop.metric.name} at ${display}`}
							>
								{display}
							</a>
						) : (
							display
						)}
					</strong>
				</div>
				<MetricTrend loop={loop} />
			</div>
			<p className="loop-comparison">
				{loop.change != null && (
					<span
						className={
							loop.change === 0
								? undefined
								: improving
									? "improving"
									: "declining"
						}
					>
						{loop.change > 0 ? "+" : ""}
						{percentNumber.format(loop.change)} pp over 7 days
					</span>
				)}
				<span>Target {target}</span>
			</p>
			<p className="loop-muted loop-sample">
				{point?.value != null
					? `${countNumber.format(point.numerator)} of ${countNumber.format(point.denominator)} · ${point.day} UTC`
					: "No measurements in the display window."}
			</p>
			{loop.lastObservedAt && (
				<p className="loop-muted loop-sample">
					Last observation{" "}
					<time dateTime={loop.lastObservedAt}>
						{observedTime(loop.lastObservedAt)}
					</time>
				</p>
			)}
		</>
	);
}

export function LoopStatus({ loop }: { loop: LoopSummary }) {
	return (
		<span className={`loop-status ${loop.status}`}>
			{loop.status === "off_target"
				? loop.metric.direction === "at_least"
					? "Below target"
					: "Above target"
				: statuses[loop.status]}
		</span>
	);
}

export function LoopCard({
	workspace,
	loop,
}: {
	workspace: string;
	loop: LoopSummary;
}) {
	const overview = loopLink(workspace, loop.id);
	return (
		<article className="card loop-card" aria-label={loop.name}>
			<div className="loop-title">
				<div>
					<p className="eyebrow">{loop.ownerName}</p>
					<h2>
						<a href={overview}>{loop.name}</a>
					</h2>
				</div>
				<LoopStatus loop={loop} />
			</div>
			<LoopMetric loop={loop} href={loopLink(workspace, loop.id, "samples")} />
			<div className="loop-totals">
				{loop.activeRuns ? (
					<a href={loopLink(workspace, loop.id, "workflow", "activity")}>
						{loop.activeRuns} active {loop.activeRuns === 1 ? "run" : "runs"}
					</a>
				) : (
					<span>0 active runs</span>
				)}
				{loop.pendingDecisions ? (
					<a href={loopLink(workspace, "decisions")}>
						{loop.pendingDecisions} pending{" "}
						{loop.pendingDecisions === 1 ? "decision" : "decisions"}
					</a>
				) : (
					<span>0 pending decisions</span>
				)}
			</div>
			<div className="org-actions">
				<a className="button" href={overview}>
					Overview
				</a>
				<a className="button" href={loopLink(workspace, loop.id, "workflow")}>
					Workflow
				</a>
			</div>
		</article>
	);
}
