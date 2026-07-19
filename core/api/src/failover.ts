import type { FailoverPolicy } from "@autonomo.us/common";

export const DEFAULT_FAILOVER_POLICY: FailoverPolicy = {
	enabled: false,
	targets: [],
	timeoutMs: 30_000,
};

function normalizeTargets(targets: string[]): string[] {
	return [
		...new Set(
			targets.map((target) => target.trim()).filter((target) => target.length),
		),
	];
}

/**
 * Holds the gateway's failover policy: seeded from config at boot and mutable
 * at runtime through PUT /v1/failover (the dashboard or any API client).
 */
export class FailoverPolicyStore {
	private policy: FailoverPolicy;

	constructor(initial: Partial<FailoverPolicy> = {}) {
		this.policy = {
			...DEFAULT_FAILOVER_POLICY,
			...initial,
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
			timeoutMs: patch.timeoutMs ?? this.policy.timeoutMs,
			targets: patch.targets
				? normalizeTargets(patch.targets)
				: this.policy.targets,
		};
		return this.get();
	}
}
