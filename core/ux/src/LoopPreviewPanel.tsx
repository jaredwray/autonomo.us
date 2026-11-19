import type { LoopPreview, LoopWorkflow } from "@autonomo.us/common";
import { useState } from "react";
import { loopsRequest } from "./api.js";

export function LoopPreviewPanel({
	workspace,
	ownerPositionId,
	workflow,
}: {
	workspace: string;
	ownerPositionId: string;
	workflow: LoopWorkflow;
}) {
	const [input, setInput] = useState(String(workflow.triggerCount));
	const count = /^\d{1,3}$/.test(input) ? Number(input) : NaN;
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const [result, setResult] = useState<{
		key: string;
		value: LoopPreview;
	} | null>(null);
	const key = JSON.stringify([workspace, ownerPositionId, workflow, count]);
	const preview = result?.key === key ? result.value : null;
	async function test() {
		setBusy(true);
		setError("");
		setResult(null);
		try {
			const observations = Array.from({ length: count }, (_, index) => ({
				eventId: `check-${index + 1}`,
				workId: "example-work",
				workRevision: "v1",
				trigger: true,
			}));
			const value = await loopsRequest<LoopPreview>(workspace, "/preview", {
				method: "POST",
				body: { ownerPositionId, workflow, observations },
			});
			setResult({ key, value });
		} catch (e) {
			setError(e instanceof Error ? e.message : "Unable to preview workflow.");
		} finally {
			setBusy(false);
		}
	}
	return (
		<details className="loop-evidence">
			<summary>Test workflow</summary>
			<p>
				Try a number of distinct observations for one work revision. This
				preview uses sample data.
			</p>
			<label>
				Sample observations (0–100){" "}
				<input
					type="text"
					inputMode="numeric"
					maxLength={3}
					value={input}
					onChange={(e) => setInput(e.target.value)}
				/>
			</label>
			<button
				className="button"
				type="button"
				onClick={() => void test()}
				disabled={
					busy ||
					!ownerPositionId ||
					!Number.isInteger(count) ||
					count < 0 ||
					count > 100
				}
			>
				{busy ? "Testing…" : "Run preview"}
			</button>
			{error && <p role="alert">{error}</p>}
			{preview && (
				<div role="status">
					<p>
						{preview.matched.length
							? "One workflow would start."
							: "The workflow would keep watching."}{" "}
						{preview.distinctEvents} distinct observations · trigger at{" "}
						{workflow.triggerCount}.
					</p>
					{preview.matched.length > 0 && (
						<>
							<p>{preview.steps.map((step) => step.name).join(" → ")}</p>
							<p>
								Decision routing follows{" "}
								{preview.route.steps
									.filter((s) => s.eligible)
									.map((s) => s.position.title)
									.join(" → ") || "Human triage"}
							</p>
						</>
					)}
				</div>
			)}
		</details>
	);
}
