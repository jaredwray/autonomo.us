import type { ModelUsage, TelemetryEvent } from "@autonomo.us/common";
import { useCallback, useEffect, useState } from "react";
import { type DashboardData, fetchDashboardData } from "./api.js";

const POLL_INTERVAL_MS = 4000;

const compact = new Intl.NumberFormat("en-US", {
	notation: "compact",
	maximumFractionDigits: 1,
});
const plain = new Intl.NumberFormat("en-US");

function formatCompact(value: number): string {
	return value >= 10_000 ? compact.format(value) : plain.format(value);
}

function formatTime(iso: string): string {
	const date = new Date(iso);
	return Number.isNaN(date.getTime()) ? iso : date.toLocaleTimeString();
}

function StatTile(props: { label: string; value: string; detail?: string }) {
	return (
		<div className="tile">
			<p className="label">{props.label}</p>
			<p className="value">{props.value}</p>
			{props.detail ? <p className="detail">{props.detail}</p> : null}
		</div>
	);
}

type TooltipState = {
	x: number;
	y: number;
	usage: ModelUsage;
};

function ModelBars(props: { byModel: ModelUsage[] }) {
	const [tooltip, setTooltip] = useState<TooltipState | null>(null);
	const maxTokens = Math.max(
		...props.byModel.map((usage) => usage.totalTokens),
		1,
	);

	return (
		<div>
			<div className="legend">
				<span className="key">
					<span className="swatch swatch-prompt" />
					Prompt tokens
				</span>
				<span className="key">
					<span className="swatch swatch-completion" />
					Completion tokens
				</span>
			</div>
			{props.byModel.map((usage) => {
				const share = usage.totalTokens / maxTokens;
				const promptShare =
					usage.totalTokens > 0 ? usage.promptTokens / usage.totalTokens : 0;
				return (
					<div className="model-row" key={`${usage.provider}/${usage.model}`}>
						<div className="name">
							{usage.model}
							<div className="provider">{usage.provider}</div>
						</div>
						{/* biome-ignore lint/a11y/noStaticElementInteractions: hover-only tooltip; data is duplicated in visible text */}
						<div
							className="bar-track"
							onMouseMove={(event) =>
								setTooltip({ x: event.clientX, y: event.clientY, usage })
							}
							onMouseLeave={() => setTooltip(null)}
						>
							<div
								className="bar"
								style={{ width: `${Math.max(share * 100, 1)}%` }}
							>
								{usage.promptTokens > 0 ? (
									<span
										className="segment segment-prompt"
										style={{ width: `${promptShare * 100}%` }}
									/>
								) : null}
								{usage.completionTokens > 0 ? (
									<span
										className="segment segment-completion"
										style={{ flex: 1 }}
									/>
								) : null}
							</div>
						</div>
						<div className="value">{formatCompact(usage.totalTokens)}</div>
					</div>
				);
			})}
			{tooltip ? (
				<div
					className="tooltip"
					style={{
						left: Math.min(tooltip.x + 14, window.innerWidth - 220),
						top: tooltip.y + 14,
					}}
				>
					<p className="tooltip-title">
						{tooltip.usage.provider}/{tooltip.usage.model}
					</p>
					<dl>
						<dt>
							<span className="swatch swatch-prompt" />
							Prompt
						</dt>
						<dd>{plain.format(tooltip.usage.promptTokens)}</dd>
						<dt>
							<span className="swatch swatch-completion" />
							Completion
						</dt>
						<dd>{plain.format(tooltip.usage.completionTokens)}</dd>
						<dt>Total tokens</dt>
						<dd>{plain.format(tooltip.usage.totalTokens)}</dd>
						<dt>Requests</dt>
						<dd>{plain.format(tooltip.usage.requests)}</dd>
						<dt>Errors</dt>
						<dd>{plain.format(tooltip.usage.errors)}</dd>
						<dt>Avg latency</dt>
						<dd>{plain.format(tooltip.usage.avgLatencyMs)} ms</dd>
					</dl>
				</div>
			) : null}
		</div>
	);
}

function EventRow(props: { event: TelemetryEvent }) {
	const { event } = props;
	const isError = event.type === "gateway.error";
	const tokens =
		typeof event.data.totalTokens === "number" ? event.data.totalTokens : 0;
	const latency =
		typeof event.data.latencyMs === "number" ? event.data.latencyMs : 0;
	return (
		<tr>
			<td>{formatTime(event.timestamp)}</td>
			<td>
				<span className="event-status">
					<span className={`dot ${isError ? "dot-critical" : "dot-good"}`} />
					{isError ? "error" : "ok"}
				</span>
			</td>
			<td className="model-cell">{String(event.data.model ?? "—")}</td>
			<td className="num">{plain.format(tokens)}</td>
			<td className="num">{plain.format(latency)} ms</td>
		</tr>
	);
}

export function App() {
	const [data, setData] = useState<DashboardData | null>(null);
	const [error, setError] = useState<string | null>(null);

	const refresh = useCallback(async () => {
		try {
			setData(await fetchDashboardData());
			setError(null);
		} catch (fetchError) {
			setError(
				fetchError instanceof Error ? fetchError.message : String(fetchError),
			);
		}
	}, []);

	useEffect(() => {
		void refresh();
		const timer = setInterval(() => {
			if (!document.hidden) void refresh();
		}, POLL_INTERVAL_MS);
		return () => clearInterval(timer);
	}, [refresh]);

	const summary = data?.summary;
	const hasTraffic = (summary?.totalRequests ?? 0) > 0;

	return (
		<div className="dashboard">
			<header className="dashboard-header">
				<div>
					<h1>autonomo.us</h1>
					<p className="subtitle">AI Platform Dashboard</p>
				</div>
				<div className="status-chips">
					<span className="chip">
						<span className={`dot ${error ? "dot-critical" : "dot-good"}`} />
						{error ? "API unreachable" : "API connected"}
					</span>
					<span className="chip">
						<span
							className={`dot ${
								data?.sink.configured
									? data.sink.healthy
										? "dot-good"
										: "dot-critical"
									: "dot-muted"
							}`}
						/>
						{data?.sink.configured
							? data.sink.healthy
								? "ClickHouse connected"
								: "ClickHouse unreachable"
							: summary?.source === "clickhouse"
								? "ClickHouse connected"
								: "ClickHouse off"}
					</span>
				</div>
			</header>

			{error ? (
				<div className="banner-error">
					<strong>Cannot reach the gateway API.</strong> Start it with{" "}
					<code>pnpm --filter @autonomo.us/api dev</code> — retrying every few
					seconds. ({error})
				</div>
			) : null}

			<section className="tile-row" aria-label="Usage totals">
				<StatTile
					label="Requests"
					value={formatCompact(summary?.totalRequests ?? 0)}
				/>
				<StatTile
					label="Total tokens"
					value={formatCompact(summary?.totalTokens ?? 0)}
					detail={`${formatCompact(summary?.promptTokens ?? 0)} prompt · ${formatCompact(summary?.completionTokens ?? 0)} completion`}
				/>
				<StatTile
					label="Avg latency"
					value={`${plain.format(summary?.avgLatencyMs ?? 0)} ms`}
				/>
				<StatTile
					label="Errors"
					value={formatCompact(summary?.totalErrors ?? 0)}
				/>
			</section>

			<section className="card">
				<h2>Usage by model</h2>
				<p className="card-note">
					Token volume per model ({summary?.source ?? "memory"} data)
				</p>
				{hasTraffic && summary ? (
					<ModelBars byModel={summary.byModel} />
				) : (
					<div className="empty-state">
						No traffic yet. Send a request through the gateway:
						<code>
							{`curl -X POST http://localhost:3000/v1/chat \\
  -H "content-type: application/json" \\
  -d '{"model": "anthropic/claude-opus-4-8", "messages": [{"role": "user", "content": "Hello"}]}'`}
						</code>
					</div>
				)}
			</section>

			<section className="card">
				<h2>Recent events</h2>
				<p className="card-note">
					Last {data?.events.length ?? 0} gateway events
				</p>
				{data && data.events.length > 0 ? (
					<table className="events">
						<thead>
							<tr>
								<th>Time</th>
								<th>Status</th>
								<th>Model</th>
								<th className="num">Tokens</th>
								<th className="num">Latency</th>
							</tr>
						</thead>
						<tbody>
							{data.events.map((event) => (
								<EventRow event={event} key={event.id} />
							))}
						</tbody>
					</table>
				) : (
					<div className="empty-state">No events recorded yet.</div>
				)}
			</section>

			<section className="card">
				<h2>Available models</h2>
				<p className="card-note">
					Routable ids from GET /v1/models — pass one as <code>model</code> in
					POST /v1/chat
				</p>
				{data && data.models.length > 0 ? (
					<ul>
						{data.models.map((model) => (
							<li key={model.id}>
								<code>{model.id}</code>
							</li>
						))}
					</ul>
				) : data && data.providers.length > 0 ? (
					<div className="empty-state">
						No advertised models, but{" "}
						{data.providers.map((provider, index) => (
							<span key={provider.name}>
								{index > 0 ? ", " : ""}
								<code>{provider.name}</code>
							</span>
						))}{" "}
						{data.providers.length === 1 ? "is" : "are"} configured — any{" "}
						<code>&lt;provider&gt;/&lt;model-id&gt;</code> routes. Set{" "}
						<code>OPENAI_COMPAT_MODELS</code> to advertise a model list.
					</div>
				) : (
					<div className="empty-state">
						No providers configured. Set <code>ANTHROPIC_API_KEY</code> and/or{" "}
						<code>OPENAI_COMPAT_BASE_URL</code> for the API service.
					</div>
				)}
			</section>
		</div>
	);
}
