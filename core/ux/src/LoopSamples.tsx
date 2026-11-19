import type { LoopDetail, LoopSamplesPage } from "@autonomo.us/common";
import { useState } from "react";
import { observedTime, useLoopRead } from "./loops-state.js";

function Samples({ workspace, loop }: { workspace: string; loop: LoopDetail }) {
	const [day, setDay] = useState(
		loop.current?.day ?? new Date().toISOString().slice(0, 10),
	);
	const [pages, setPages] = useState<string[]>([]);
	const [after, setAfter] = useState("");
	const query = new URLSearchParams({ day });
	if (after) query.set("after", after);
	const resource = useLoopRead<LoopSamplesPage>(
		workspace,
		day ? `/${encodeURIComponent(loop.id)}/samples?${query}` : null,
		0,
	);
	return (
		<>
			<label>
				Measurement day (UTC){" "}
				<input
					type="date"
					value={day}
					onChange={(e) => {
						setDay(e.target.value);
						setAfter("");
						setPages([]);
					}}
				/>
			</label>
			{resource.error ? (
				<p role="alert">{resource.error}</p>
			) : day && !resource.data ? (
				<p role="status">Loading measurements…</p>
			) : (
				resource.data &&
				(resource.data.observations.length ? (
					<div className="table-scroll">
						<table className="token-log-table">
							<thead>
								<tr>
									<th>Observed</th>
									<th>Work and revision</th>
									<th>Contribution</th>
									<th>Reported by</th>
									<th>Evidence</th>
								</tr>
							</thead>
							<tbody>
								{resource.data.observations.map((o) => (
									<tr key={o.eventId}>
										<td>
											<time dateTime={o.observedAt}>
												{observedTime(o.observedAt)}
											</time>
										</td>
										<td>
											{o.workId} · {o.workRevision}
										</td>
										<td>
											{o.numerator} / {o.denominator}
										</td>
										<td>
											{o.actor.kind} · <code>{o.actor.id}</code>
										</td>
										<td>{o.evidence ?? "—"}</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				) : (
					<p>No measurements contributed on this day.</p>
				))
			)}
			{(pages.length > 0 || resource.data?.next) && (
				<div className="org-actions">
					<button
						type="button"
						className="button"
						disabled={!pages.length}
						onClick={() => {
							setAfter(pages.at(-1) ?? "");
							setPages(pages.slice(0, -1));
						}}
					>
						Previous
					</button>
					<button
						type="button"
						className="button"
						disabled={!resource.data?.next}
						onClick={() => {
							if (resource.data?.next) {
								setPages([...pages, after]);
								setAfter(resource.data.next);
							}
						}}
					>
						Next
					</button>
				</div>
			)}
		</>
	);
}

export function LoopSamples({
	workspace,
	loop,
	expanded = false,
}: {
	workspace: string;
	loop: LoopDetail;
	expanded?: boolean;
}) {
	const [open, setOpen] = useState(expanded);
	return (
		<details open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
			<summary>Inspect metric samples</summary>
			{open && (
				<Samples
					key={`${workspace}/${loop.id}`}
					workspace={workspace}
					loop={loop}
				/>
			)}
		</details>
	);
}
