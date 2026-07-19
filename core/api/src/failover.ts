import type { FailoverPolicy } from "@autonomo.us/common";

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
	enabled: false,
	targets: [],
	timeoutMs: 30_000,
};

/** Upper bound for `timeoutMs`, shared by the PUT schema and the store. */
export const MAX_FAILOVER_TIMEOUT_MS = 600_000;

function normalizeTargets(targets: string[]): string[] {
	return [
		...new Set(
			targets.map((target) => target.trim()).filter((target) => target.length),
		),
	];
}

function normalizeTimeout(timeoutMs: number): number {
	// Values past 2^31-1 ms overflow Node's setTimeout into a ~1ms timer, so
	// oversized configs must be clamped before they ever reach a timer.
	if (!Number.isFinite(timeoutMs)) return DEFAULT_FAILOVER_POLICY.timeoutMs;
	return Math.min(Math.max(0, Math.floor(timeoutMs)), MAX_FAILOVER_TIMEOUT_MS);
}

/**
 * Holds the gateway's failover policy: seeded from config at boot and mutable
 * at runtime through PUT /v1/failover (the dashboard or any API client).
 */
export class FailoverPolicyStore {
	private policy: FailoverPolicy;

	constructor(initial: Partial<FailoverPolicy> = {}) {
		this.policy = {
			enabled: initial.enabled ?? DEFAULT_FAILOVER_POLICY.enabled,
			timeoutMs: normalizeTimeout(
				initial.timeoutMs ?? DEFAULT_FAILOVER_POLICY.timeoutMs,
			),
			targets: normalizeTargets(initial.targets ?? []),
		};
	}

	get(): FailoverPolicy {
		return { ...this.policy, targets: [...this.policy.targets] };
	}

	/** Applies a partial update; omitted fields keep their current value. */
	update(patch: Partial<FailoverPolicy>): FailoverPolicy {
		this.policy = {
			enabled: patch.enabled ?? this.policy.enabled,
			timeoutMs: normalizeTimeout(patch.timeoutMs ?? this.policy.timeoutMs),
			targets: patch.targets
				? normalizeTargets(patch.targets)
				: this.policy.targets,
		};
		return this.get();
	}
}
