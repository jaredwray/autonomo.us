import type { LoopPreviewInput } from "@autonomo.us/common";
import { boundedText } from "../organization/chart.js";
import { ServiceError } from "../service-error.js";

/** A preview only examines the submitted sample. It never records an event or opens work. */
export function previewTriggers(
	observations: LoopPreviewInput["observations"],
	threshold: number,
) {
	if (!Array.isArray(observations) || observations.length > 100)
		throw new ServiceError("Preview up to 100 observations.");
	const seen = new Map<string, string>();
	const counts = new Map<
		string,
		{ workId: string; workRevision: string; count: number }
	>();
	for (const input of observations) {
		const eventId = boundedText(input?.eventId, "Event ID", 160),
			workId = boundedText(input?.workId, "Work ID", 200),
			workRevision = boundedText(input?.workRevision, "Work revision", 120);
		if (typeof input.trigger !== "boolean")
			throw new ServiceError(
				"Specify whether the observation counts toward the trigger.",
			);
		const payload = JSON.stringify([workId, workRevision, input.trigger]);
		const prior = seen.get(eventId);
		if (prior && prior !== payload)
			throw new ServiceError(
				"This event ID already identifies a different observation.",
				409,
			);
		if (prior) continue;
		seen.set(eventId, payload);
		if (!input.trigger) continue;
		const key = JSON.stringify([workId, workRevision]),
			group = counts.get(key) ?? { workId, workRevision, count: 0 };
		group.count++;
		counts.set(key, group);
	}
	return {
		distinctEvents: seen.size,
		matched: [...counts.values()].filter((group) => group.count >= threshold),
	};
}
