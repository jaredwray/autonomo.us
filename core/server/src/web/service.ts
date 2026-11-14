import {
	levelFixes,
	levelRenders,
	PROXY_KIND_LABELS,
	type ProxyProblem,
	type ProxyTestRequest,
	stepLabel,
	type TelemetryCaller,
	WEB_LIMITS,
	type WebFetchAttempt,
	type WebFetchFormat,
	type WebFetchRequest,
	type WebFetchResult,
	type WebPolicy,
	type WebStep,
} from "@autonomo.us/common";
import { ServiceError } from "../service-error.js";
import type { TelemetryService } from "../telemetry/telemetry.js";
import type { WorkspaceRef } from "../workspaces/store.js";
import { classifyResponse } from "./classify.js";
import { type DirectTransport, directFetch } from "./direct.js";
import { htmlToMarkdown, truncateText } from "./markdown.js";
import { PROXY_ADAPTERS } from "./providers/index.js";
import {
	domainRule,
	type ProxyStore,
	type ReservationRefusal,
} from "./store.js";
import type {
	FetchLike,
	ProxyAdapter,
	ProxyConfig,
	StepFailure,
	StepResult,
	StepSuccess,
} from "./types.js";
import { checkTargetUrl, type Resolver } from "./url-guard.js";

/** Who is fetching. Bots bring their own daily proxy limit. */
export type WebCaller = TelemetryCaller & { proxyRequestsPerDay?: number };

/** How long a fetch may take, and what may stop it early. */
export type WebFetchContext = {
	/** Epoch milliseconds after which no step starts and running ones stop. */
	deadline: number;
	signal?: AbortSignal;
	/** A proxy step starts only with at least this much time left. */
	minProxyMs?: number;
};

export type WebServiceOptions = {
	store: ProxyStore;
	transport: DirectTransport;
	resolver?: Resolver;
	/** How provider APIs are called; the global fetch by default. */
	fetchImpl?: FetchLike;
	adapters?: Partial<Record<ProxyConfig["kind"], ProxyAdapter>>;
	telemetry?: Pick<TelemetryService, "recordWebFetch">;
	/** `WEB_FETCH_DISABLED`: every fetch is refused. */
	disabled?: boolean;
	now?: () => number;
	/** Plain requests one caller may make in a minute. */
	directPerMinute?: number;
};

const CACHE_MS = 10 * 60_000;
const DOMAIN_MEMORY_MS = 24 * 3_600_000;
const MAX_CACHE_ENTRIES = 500;
const MAX_DOMAIN_ENTRIES = 5_000;
const PROBLEM_HOLD_MS = 15 * 60_000;
const DIRECT_HOP_MS = 15_000;
const PROVIDER_CALL_MS = 90_000;
const DEFAULT_TEST_URL = "https://example.com/";

const REFUSALS: Record<ReservationRefusal, string> = {
	budget: "the workspace's monthly proxy budget is used up",
	caller: "your proxied requests for today are used up",
	connection: "this proxy's monthly request cap is reached",
};

type PlannedStep = {
	step: WebStep;
	config?: ProxyConfig;
	problem?: ProxyProblem | null;
};

type CacheEntry = {
	result: WebFetchResult;
	until: number;
};

/**
 * Fetches a page for an agent: a plain request first, then the workspace's
 * proxies in ladder order, climbing only as far as the last failure needs.
 * See docs/WEB_PROXIES_PLAN.md §5.
 */
export class WebService {
	private readonly adapters: Partial<Record<ProxyConfig["kind"], ProxyAdapter>>;
	private readonly fetchImpl: FetchLike;
	private readonly now: () => number;
	/** Finished pages, per workspace, URL, and format. */
	private readonly cache = new Map<string, CacheEntry>();
	/** The step that last worked for a host, per workspace. */
	private readonly domains = new Map<string, { step: string; until: number }>();
	/** Connections that asked the gateway to slow down. */
	private readonly backoff = new Map<string, number>();
	/** Plain requests per caller in the current minute. */
	private readonly directCounts = new Map<
		string,
		{ minute: number; count: number }
	>();

	constructor(private readonly options: WebServiceOptions) {
		this.adapters = options.adapters ?? PROXY_ADAPTERS;
		this.fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
		this.now = options.now ?? Date.now;
	}

	get available(): boolean {
		return !this.options.disabled;
	}

	private refuseWhenDisabled() {
		if (this.options.disabled)
			throw new ServiceError("Web access is turned off on this gateway.", 503);
	}

	/** Runs the workspace's ladder for one URL. */
	async fetch(
		workspace: WorkspaceRef,
		caller: WebCaller,
		request: WebFetchRequest,
		context: WebFetchContext,
	): Promise<WebFetchResult> {
		this.refuseWhenDisabled();
		const started = this.now();
		const url = checkTargetUrl(request.url);
		const format: WebFetchFormat =
			request.format === "html" ? "html" : "markdown";
		const maxChars = clamp(
			request.maxChars ?? WEB_LIMITS.defaultMaxChars,
			WEB_LIMITS.minChars,
			WEB_LIMITS.maxChars,
		);
		const policy = await this.options.store.policy(workspace);
		const host = canonicalHost(url.hostname);
		const rule = domainRule(policy, host);
		const refused = hostRefusal(policy, host, false);
		if (refused) throw new ServiceError(refused, 403);

		const cacheKey = `${workspace.id}\n${format}\n${url.href}`;
		const cached = this.cache.get(cacheKey);
		// Rules may have changed since the page was cached: where it landed
		// must still pass them.
		if (
			cached &&
			cached.until > started &&
			!refusedLanding(
				policy,
				cached.result.finalUrl,
				cached.result.via !== "direct",
			)
		) {
			const result: WebFetchResult = {
				...cached.result,
				...(() => {
					const cut = truncateText(cached.result.content, maxChars);
					return {
						content: cut.content,
						truncated: cut.truncated || cached.result.truncated,
					};
				})(),
				attempts: [],
				cached: true,
				costUsd: 0,
			};
			this.record(workspace, caller, host, result, started);
			return result;
		}

		const steps = await this.plan(workspace, policy, host, request, rule?.rule);
		const attempts: WebFetchAttempt[] = [];
		let success: { step: WebStep; result: StepSuccess } | undefined;
		let failure: StepFailure | undefined;
		/** What the next step has to fix. */
		let needs: "blocked" | "needs-render" | null = request.render
			? "needs-render"
			: null;

		for (const { step, config, problem } of steps) {
			if (context.signal?.aborted || this.now() >= context.deadline) break;
			if (step.kind === "proxy" && config) {
				const fixes = levelFixes(config.kind, step.level);
				if (needs && !fixes.includes(needs)) continue;
			}
			const result = await this.runStep(
				workspace,
				caller,
				policy,
				step,
				config,
				{
					url,
					format,
					context,
					attempts,
					problem,
				},
			);
			if (!result) continue;
			if (result.outcome === "ok") {
				success = { step, result };
				break;
			}
			failure = result;
			if (result.outcome === "blocked" || result.outcome === "needs-render")
				needs = result.outcome;
			else if (result.outcome !== "provider-error") break;
		}

		const costUsd = round(
			attempts.reduce((sum, attempt) => sum + attempt.costUsd, 0),
		);
		let result: WebFetchResult;
		if (success) {
			const { step, result: page } = success;
			const content =
				format === "markdown" && page.contentFormat === "html"
					? htmlToMarkdown(page.content, page.finalUrl)
					: page.content;
			result = {
				url: url.href,
				finalUrl: visibleUrl(page.finalUrl, url),
				status: page.status,
				ok: true,
				contentType: page.contentType,
				format,
				...truncateText(content, maxChars),
				via: stepLabel(step),
				attempts,
				cached: false,
				costUsd,
			};
			this.remember(workspace, host, step);
			// Kept at most as long as any caller may ask for, not the whole page,
			// and only when where it landed can be checked again on a later hit.
			if (readableUrl(page.finalUrl))
				this.store(
					cacheKey,
					{ ...result, ...truncateText(content, WEB_LIMITS.maxChars) },
					started,
				);
		} else
			result = {
				url: url.href,
				finalUrl: url.href,
				status: failure?.status ?? 0,
				ok: false,
				contentType: "",
				format,
				content: "",
				truncated: false,
				via: "",
				attempts,
				cached: false,
				costUsd,
				reason: this.reason(attempts, failure, steps.length, context),
			};
		this.record(workspace, caller, host, result, started);
		return result;
	}

	/**
	 * Fetches through one connection only, at one level, for the dashboard's
	 * Test button. A real, billable call within the same caps as any other.
	 */
	async test(
		workspace: WorkspaceRef,
		caller: WebCaller,
		name: string,
		input: ProxyTestRequest,
		context: WebFetchContext,
	): Promise<WebFetchResult> {
		this.refuseWhenDisabled();
		const started = this.now();
		const entry = (await this.options.store.entries(workspace)).find(
			(item) => item.config.name === name,
		);
		if (!entry) throw new ServiceError("Proxy not found.", 404);
		const config = entry.config;
		const url = checkTargetUrl(input.url?.trim() || DEFAULT_TEST_URL);
		const level = input.level ?? defaultLevel(config);
		const step: WebStep = { kind: "proxy", connection: name, level };
		const policy = await this.options.store.policy(workspace);
		const attempts: WebFetchAttempt[] = [];
		const page = await this.runStep(
			workspace,
			caller,
			policy,
			step,
			{ ...config, enabled: true },
			{
				url,
				format: "markdown",
				context,
				attempts,
				problem: entry.problem,
				test: true,
			},
		);
		const ok = page?.outcome === "ok";
		const content =
			ok && page.contentFormat === "html"
				? htmlToMarkdown(page.content, page.finalUrl)
				: ok
					? page.content
					: "";
		const result: WebFetchResult = {
			url: url.href,
			finalUrl: ok ? visibleUrl(page.finalUrl, url) : url.href,
			status: page?.status ?? 0,
			ok,
			contentType: ok ? page.contentType : "",
			format: "markdown",
			...truncateText(content, WEB_LIMITS.defaultMaxChars),
			via: ok ? stepLabel(step) : "",
			attempts,
			cached: false,
			costUsd: round(attempts.reduce((sum, item) => sum + item.costUsd, 0)),
			...(ok
				? {}
				: { reason: attempts.at(-1)?.detail ?? "The test did not run." }),
		};
		this.record(workspace, caller, url.hostname, result, started);
		return result;
	}

	/** The steps to try, in order, with their connections. */
	private async plan(
		workspace: WorkspaceRef,
		policy: WebPolicy,
		host: string,
		request: WebFetchRequest,
		rule: string | undefined,
	): Promise<PlannedStep[]> {
		const connections = new Map(
			(await this.options.store.entries(workspace)).map((entry) => [
				entry.config.name,
				entry,
			]),
		);
		let steps: PlannedStep[] = [];
		for (const step of policy.ladder) {
			if (step.kind === "direct") {
				steps.push({ step });
				continue;
			}
			const entry = connections.get(step.connection);
			if (!entry?.config.enabled || !this.adapters[entry.config.kind]) continue;
			// Domain rules check where a proxy landed; one that does not say
			// cannot be held to them, so a workspace with rules leaves it out.
			if (
				restrictsHosts(policy) &&
				!this.adapters[entry.config.kind]?.reportsFinalUrl
			)
				continue;
			steps.push({ step, config: entry.config, problem: entry.problem });
		}
		if (rule === "direct-only")
			return steps.filter(({ step }) => step.kind === "direct");
		const skipDirect = request.skipDirect === true || rule === "start-at-proxy";
		if (skipDirect) steps = steps.filter(({ step }) => step.kind !== "direct");
		if (request.render)
			steps = steps.filter(
				({ step, config }) =>
					step.kind === "proxy" &&
					config &&
					levelRenders(config.kind, step.level),
			);
		// Start where this host last needed to start, if that step still exists.
		const remembered = this.domains.get(`${workspace.id}\n${host}`);
		if (remembered && remembered.until > this.now()) {
			const index = steps.findIndex(
				({ step }) => stepLabel(step) === remembered.step,
			);
			if (index > 0) steps = steps.slice(index);
		}
		return steps;
	}

	/** Runs one step and records its attempt. Null when the step was skipped silently. */
	private async runStep(
		workspace: WorkspaceRef,
		caller: WebCaller,
		policy: WebPolicy,
		step: WebStep,
		config: ProxyConfig | undefined,
		input: {
			url: URL;
			format: WebFetchFormat;
			context: WebFetchContext;
			attempts: WebFetchAttempt[];
			problem?: ProxyProblem | null;
			test?: boolean;
		},
	): Promise<StepResult | null> {
		const { url, format, context, attempts } = input;
		const skip = (detail: string) => {
			attempts.push({
				step,
				outcome: "skipped",
				status: null,
				latencyMs: 0,
				costUsd: 0,
				detail,
			});
			return null;
		};
		const started = this.now();
		const remaining = context.deadline - started;
		if (step.kind === "direct") {
			if (!this.allowDirect(workspace, caller))
				return skip("Too many plain requests this minute; try again shortly.");
			const timer = deadlineSignal(context, Math.min(DIRECT_HOP_MS, remaining));
			let result: StepResult;
			try {
				result = await directFetch(url, {
					signal: timer.signal,
					transport: this.options.transport,
					resolver: this.options.resolver,
					hopTimeoutMs: Math.min(DIRECT_HOP_MS, remaining),
					// A redirect is held to the same workspace rules as the URL asked for.
					allowHop: (next) =>
						hostRefusal(policy, canonicalHost(next.hostname), false),
					// A host the workspace reaches through a proxy is not contacted directly.
					proxyOnlyHop: (next) => {
						const host = canonicalHost(next.hostname);
						return domainRule(policy, host)?.rule === "start-at-proxy"
							? `redirected to ${host}, which this workspace fetches through a proxy`
							: null;
					},
				});
			} finally {
				timer.clear();
			}
			attempts.push(attempt(step, result, this.now() - started));
			return result;
		}
		if (!config) return null;
		const adapter = this.adapters[config.kind];
		if (!adapter) return null;
		const key = `${workspace.id}\n${config.name}`;
		if ((this.backoff.get(key) ?? 0) > started)
			return skip(`${config.name} asked the gateway to slow down.`);
		const minimum = context.minProxyMs ?? 5_000;
		if (remaining < minimum)
			return skip(
				`Not enough time left for ${config.name} (${Math.max(0, Math.round(remaining / 1000))} s).`,
			);
		if (!config.apiKey) return skip(`${config.name} has no key.`);
		const flagged = input.problem ?? null;
		if (
			!input.test &&
			flagged &&
			Date.parse(flagged.at) + PROBLEM_HOLD_MS > started
		)
			return skip(`${config.name} needs attention: ${flagged.detail}`);
		const reservation = await this.options.store.reserve(workspace, {
			connection: config,
			callerId: caller.id,
			callerCap: caller.proxyRequestsPerDay ?? policy.callerProxyRequestsPerDay,
			budgetUsd: policy.monthlyBudgetUsd,
			maxCostUsd: adapter.maxCostUsd(config, step.level),
		});
		if ("refused" in reservation)
			return skip(`Not tried: ${REFUSALS[reservation.refused]}.`);
		const timer = deadlineSignal(
			context,
			Math.min(PROVIDER_CALL_MS, remaining),
		);
		let result: StepResult;
		try {
			result = await adapter.fetch(
				config,
				{
					url: url.href,
					level: step.level,
					format,
					...(config.country ? { country: config.country } : {}),
					signal: timer.signal,
				},
				this.fetchImpl,
			);
		} catch {
			result = {
				outcome: "provider-error",
				status: null,
				costUsd: 0,
				detail: `${PROXY_KIND_LABELS[config.kind]} failed unexpectedly.`,
				billed: false,
			};
		} finally {
			timer.clear();
		}
		const recorded = await this.options.store
			.settle(reservation, {
				billed: result.outcome === "ok" || result.billed,
				costUsd: result.costUsd,
			})
			.catch(() => false);
		// A provider follows redirects itself: the page it landed on must pass
		// the workspace's rules too, or its content is not returned.
		if (result.outcome === "ok") {
			const landed = refusedLanding(policy, result.finalUrl);
			if (landed)
				result = {
					outcome: "target-error",
					status: result.status,
					costUsd: result.costUsd,
					detail: landed,
					billed: true,
				};
		}
		// A provider can return a challenge page as content.
		if (result.outcome === "ok") {
			const verdict = classifyResponse({
				status: result.status,
				headers: new Headers(),
				body: result.content,
				contentType:
					result.contentFormat === "markdown"
						? "text/markdown"
						: result.contentType,
			});
			if (verdict.outcome === "blocked")
				result = {
					outcome: "blocked",
					status: result.status,
					costUsd: result.costUsd,
					detail: `${config.name} returned a challenge page (${verdict.detail}).`,
					billed: true,
				};
		}
		if (result.outcome !== "ok" && result.retryAfterMs)
			this.backoff.set(key, this.now() + result.retryAfterMs);
		if (result.outcome !== "ok" && result.problem)
			await this.options.store
				.setProblem(workspace, config.name, {
					kind: result.problem,
					detail: result.detail,
					at: new Date(this.now()).toISOString(),
				})
				.catch(() => {});
		else if (result.outcome === "ok" && flagged)
			await this.options.store
				.setProblem(workspace, config.name, null)
				.catch(() => {});
		const record = attempt(step, result, this.now() - started);
		if (!recorded)
			record.detail = `${record.detail ? `${record.detail} ` : ""}The gateway could not update its spend counters, so they read high until they expire.`;
		attempts.push(record);
		return result;
	}

	/** A fixed window per caller and minute; best effort, per process. */
	private allowDirect(workspace: WorkspaceRef, caller: WebCaller) {
		const limit = this.options.directPerMinute ?? 60;
		const minute = Math.floor(this.now() / 60_000);
		const key = `${workspace.id}\n${caller.id}`;
		const current = this.directCounts.get(key);
		if (!current || current.minute !== minute) {
			if (this.directCounts.size > 10_000) this.directCounts.clear();
			this.directCounts.set(key, { minute, count: 1 });
			return true;
		}
		if (current.count >= limit) return false;
		current.count += 1;
		return true;
	}

	private remember(workspace: WorkspaceRef, host: string, step: WebStep) {
		const key = `${workspace.id}\n${host}`;
		if (step.kind === "direct") {
			this.domains.delete(key);
			return;
		}
		if (this.domains.size >= MAX_DOMAIN_ENTRIES) {
			const oldest = this.domains.keys().next().value;
			if (oldest !== undefined) this.domains.delete(oldest);
		}
		this.domains.delete(key);
		this.domains.set(key, {
			step: stepLabel(step),
			until: this.now() + DOMAIN_MEMORY_MS,
		});
	}

	private store(key: string, result: WebFetchResult, now: number) {
		if (this.cache.size >= MAX_CACHE_ENTRIES) {
			const oldest = this.cache.keys().next().value;
			if (oldest !== undefined) this.cache.delete(oldest);
		}
		this.cache.delete(key);
		this.cache.set(key, { result, until: now + CACHE_MS });
	}

	/** Why nothing came back, in words an agent can act on. */
	private reason(
		attempts: WebFetchAttempt[],
		failure: StepFailure | undefined,
		planned: number,
		context: WebFetchContext,
	): string {
		if (!planned)
			return "No step in this workspace's ladder can fetch this page. A workspace admin can add proxies in Proxies.";
		if (context.signal?.aborted || this.now() >= context.deadline)
			return "Ran out of time before the page could be fetched.";
		if (!failure) return attempts.at(-1)?.detail ?? "Nothing was fetched.";
		const proxied = attempts.some(
			(item) => item.step.kind === "proxy" && item.outcome !== "skipped",
		);
		if (
			(failure.outcome === "blocked" || failure.outcome === "needs-render") &&
			!proxied
		) {
			const skipped = attempts.filter((item) => item.outcome === "skipped");
			return skipped.length
				? `${failure.detail}. No proxy could be tried: ${skipped.map((item) => item.detail).join(" ")}`
				: `${failure.detail}. This workspace has no proxy that can help; a workspace admin can add one in Proxies.`;
		}
		return failure.detail;
	}

	private record(
		workspace: WorkspaceRef,
		caller: WebCaller,
		host: string,
		result: WebFetchResult,
		started: number,
	) {
		this.options.telemetry?.recordWebFetch({
			workspaceId: workspace.id,
			caller: { id: caller.id, name: caller.name, kind: caller.kind },
			host,
			ok: result.ok,
			via: result.via,
			cached: result.cached,
			costUsd: result.costUsd,
			latencyMs: this.now() - started,
			attempts: result.attempts.map((item) => ({
				step: stepLabel(item.step),
				outcome: item.outcome,
				status: item.status,
				latencyMs: item.latencyMs,
				costUsd: item.costUsd,
			})),
		});
	}
}

/** A host as rules match it: lower case, without a trailing dot. */
export function canonicalHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, "");
}

/**
 * Why the workspace's rules refuse a host, or null. A proxy may not carry a
 * `direct-only` host.
 */
export function hostRefusal(
	policy: Pick<WebPolicy, "domains" | "allowOnly">,
	host: string,
	viaProxy: boolean,
): string | null {
	const rule = domainRule(policy, host);
	if (rule?.rule === "deny")
		return `${host} is blocked by this workspace's web rules.`;
	if (policy.allowOnly && !rule)
		return `This workspace fetches only the domains it lists, and ${host} is not one of them.`;
	if (viaProxy && rule?.rule === "direct-only")
		return `${host} may not be fetched through a proxy under this workspace's web rules.`;
	return null;
}

/** Whether a URL is an http(s) URL with a host. */
function readableUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return /^https?:$/.test(url.protocol) && Boolean(url.hostname);
	} catch {
		return false;
	}
}

/** Whether a redirect could break the workspace's domain rules. */
function restrictsHosts(policy: Pick<WebPolicy, "domains" | "allowOnly">) {
	return (
		policy.allowOnly ||
		policy.domains.some(
			(rule) => rule.rule === "deny" || rule.rule === "direct-only",
		)
	);
}

/** Why the page a proxy landed on breaks the rules, or null. */
function refusedLanding(
	policy: Pick<WebPolicy, "domains" | "allowOnly">,
	finalUrl: string,
	viaProxy = true,
): string | null {
	let landed: URL | null = null;
	try {
		landed = new URL(finalUrl);
	} catch {}
	if (!landed || !/^https?:$/.test(landed.protocol) || !landed.hostname)
		// A landing that cannot be read cannot be checked: refused when rules apply.
		return restrictsHosts(policy)
			? "The proxy reported a landing URL that cannot be checked against this workspace's rules."
			: null;
	const host = canonicalHost(landed.hostname);
	const refused = hostRefusal(policy, host, viaProxy);
	return refused ? `The site redirected to ${host}. ${refused}` : null;
}

/**
 * The final URL as results show it. A redirect can land on a signed URL whose
 * query string is a credential, so a URL other than the one asked for loses
 * its query and fragment.
 */
export function visibleUrl(finalUrl: string, requested: URL): string {
	let final: URL;
	try {
		final = new URL(finalUrl);
	} catch {
		return requested.href;
	}
	final.hash = "";
	if (final.href === requested.href) return final.href;
	return `${final.origin}${final.pathname}`;
}

function defaultLevel(config: ProxyConfig) {
	return config.kind === "zenrows"
		? "auto"
		: config.kind === "brightdata"
			? "unlock"
			: "render";
}

function attempt(
	step: WebStep,
	result: StepResult,
	latencyMs: number,
): WebFetchAttempt {
	return {
		step,
		outcome: result.outcome,
		status: result.status,
		latencyMs,
		costUsd: round(result.costUsd),
		...(result.detail ? { detail: result.detail } : {}),
	};
}

/** A signal that aborts at the deadline, after `ms`, or with the caller's signal. */
function deadlineSignal(context: WebFetchContext, ms: number) {
	const controller = new AbortController();
	const abort = () => controller.abort();
	const timer = setTimeout(abort, Math.max(0, ms));
	context.signal?.addEventListener("abort", abort, { once: true });
	if (context.signal?.aborted) controller.abort();
	return {
		signal: controller.signal,
		clear: () => {
			clearTimeout(timer);
			context.signal?.removeEventListener("abort", abort);
		},
	};
}

function clamp(value: number, min: number, max: number) {
	return Number.isFinite(value)
		? Math.min(max, Math.max(min, Math.floor(value)))
		: max;
}

function round(usd: number) {
	return Math.round(usd * 1_000_000) / 1_000_000;
}
