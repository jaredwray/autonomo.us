# autonomo.us: MVP Implementation Plan

*Status: proposal v0.1, October 2026. Companion to [DESIGN.md](./DESIGN.md) section 9. Owner: Jared Wray.*

This plan turns the MVP scope in the design doc into an ordered sequence of small, independently reviewable PRs against this repository. It maps each MVP piece to what already exists in `core/`, proposes the package and module layout, pins down the key data models and interfaces as TypeScript types, takes a position on the open questions that block MVP work, and states the rubric every implementation PR will be reviewed against.

Nothing in this document is code. Each implementation PR is opened separately, after the owner decisions in [section 4](#4-open-questions-positions-and-decisions-needed) are made.

## Contents

1. [What the repo has today](#1-what-the-repo-has-today)
2. [MVP scope mapped to the repo](#2-mvp-scope-mapped-to-the-repo)
3. [Target layout, data models, and interfaces](#3-target-layout-data-models-and-interfaces)
4. [Open questions: positions and decisions needed](#4-open-questions-positions-and-decisions-needed)
5. [PR sequence](#5-pr-sequence)
6. [Testing approach](#6-testing-approach)
7. [Review rubric for implementation PRs](#7-review-rubric-for-implementation-prs)
8. [Exit criteria](#8-exit-criteria)

## 1. What the repo has today

The repository is a pnpm workspace (`core/*`) with four packages. The relevant three:

| Package | What it is | State |
| --- | --- | --- |
| `@autonomo.us/common` (`core/common`) | Shared types: `GatewayRequest`/`GatewayResponse`, `FailoverPolicy`, `TelemetryEvent`, `TokenUsage`, `ModelInfo`, `UsageSummary`, a placeholder `AgentConfig`. | Types only, no runtime code. |
| `@autonomo.us/api` (`core/api`) | Fastify gateway. `ProviderRegistry` maps `provider/model` ids to Vercel AI SDK language models (Anthropic direct, any OpenAI-compatible server). `POST /v1/chat` (JSON and SSE) with a sequential failover loop: per-attempt timeout, stale-target skipping, streaming fails over only until the first token. `FailoverPolicyStore` is in-memory and runtime-mutable via `PUT /v1/failover`. `ModelCatalogService` keeps a multi-provider catalog in `cacheable` with a daily refresh (provider APIs when keys exist, models.dev otherwise). `TelemetryService` aggregates in memory and batches to a `ClickHouseSink` (`ReplacingMergeTree`, reads with `FINAL`). CORS allowlist. No authentication. | Working, tested, deployed via `docker-compose.yml`. |
| `@autonomo.us/ux` (`core/ux`) | React + Vite dashboard: usage tiles, per-model token bars, recent events, routable models, and a failover policy editor. Polls `/v1/telemetry/*`, `/v1/models`, `/v1/failover`. | Working; tests boot a real `@autonomo.us/api` server. |

Infrastructure and conventions that constrain the plan:

- `docker-compose.yml` runs `api`, `ux`, `clickhouse`, `mongo`, and an optional `ollama` profile. MongoDB is declared (`MONGODB_URL`, the `mongodb` dependency in `core/api/package.json`) but **no code uses it**.
- Tests run against real services: a real OpenAI-compatible HTTP server (`core/api/test/openai-stub.ts`) over the production provider wire path, and a real ClickHouse (compose locally, a service container in `.github/workflows/tests.yml`). Suites probe the service and `describe.skipIf` with a loud warning when it is absent. Pure helpers get unit tests. Injected clocks (`now?: () => Date`) are used for time, not fake services.
- Supply chain: Aikido Safe Chain shims, pnpm `minimumReleaseAge` of 7 days (new dependencies must be at least a week old), `strictDepBuilds` with an `allowBuilds` allowlist (prefer pure-JS dependencies; any native build is a security exception), SHA-pinned GitHub Actions, Socket Firewall around installs. Biome (tabs, double quotes), tsdown builds, vitest with coverage.
- `GatewayRequest.model` is documented as "required until agent lookup by `agentId` is implemented". `agentId` is accepted and recorded but not authenticated or enforced.

## 2. MVP scope mapped to the repo

| MVP piece (design section 9) | Exists today | Reuse | New |
| --- | --- | --- | --- |
| **MCP gateway: registry** | `ProviderRegistry` (models only, in-memory, built from env). `ModelCatalogService` (model lists, no pricing, no tools). | `ProviderRegistry` becomes the model-server adapter behind the registry. `ModelCatalogService` is extended to carry models.dev pricing and modality metadata. | Persistent registry of *servers* (model and tool) with capability tags, per-tool verbs, egress class, data-class allowances, cost metadata, and health. Admin API and dashboard view. |
| **MCP gateway: secrets vault** | API keys read from env in `config.ts` and handed to the AI SDK. | `configFromEnv` stays as the boot-time seeder. | Encrypted-at-rest vault in Postgres (AES-256-GCM, master key from env for MVP), `secretRef` on registry entries, per-call injection, rotation and revocation. Agents never receive secret material; the API never returns it. |
| **MCP gateway: scopes with verbs and quotas** | `agentId` on requests, unauthenticated. | The `agentId` field becomes derived from the authenticated principal. | Gateway identities (hashed bearer tokens per agent), `ScopeGrant` with verbs, resource filters and quotas, a `PolicyEngine.authorize()` on every model and tool call, quota counters in Postgres. `send` is structurally ungrantable to agents. |
| **MCP gateway: cost metering** | `TelemetryService` + `ClickHouseSink`: tokens, latency, errors per model and agent. | The sink, batching, dedup, and dashboard summary stay. | Audit/cost schema v2: `run_id`, `routine_id`, `job_id`, `role`, `tool`, `verb`, `egress`, `cost_usd`, policy decision. Pricing from the catalog and registry. Per-call ceiling; soft and hard budgets per agent and routine; rollups per call, run, agent, routine, business unit. |
| **MCP gateway: egress classes** | Nothing. | — | `EgressClass` per tool in the registry; policy per class (human gate required or not, staging alternative); `production` and `public` always route through the approval service. Data classification on requests, checked against route and tool allowances. |
| **MCP transport** | HTTP/JSON and SSE only. | Fastify stays the host. | Gateway exposes an MCP server (Streamable HTTP) to agents; `tools/list` is filtered by the caller's scopes. Gateway holds an MCP client pool to external tool servers. Built-in tool servers (storage, memory, GitHub, X, Slack) run in-process and are registered the same way. |
| **Role-based model router with fallback across ≥2 providers + OpenRouter** | Failover loop in `routes/chat.ts` (candidate list, timeouts, streaming commit rules, telemetry per attempt). `FailoverPolicyStore`. Anthropic and OpenAI-compatible providers. | The attempt loop and streaming semantics are reused as-is. OpenRouter and xAI/OpenAI are OpenAI-compatible endpoints, so `providerFromConfig` already covers them. | `RoutingTable` (role → ordered targets with constraints, global/per-agent/per-task), `role` on chat requests, model-family derivation, fallback events in the audit log, `allowedDataClasses` on routes. `FailoverPolicyStore` folds into the global default route. |
| **`review()` primitive with author/reviewer family separation** | Nothing. | Router (reviewer role, family exclusion, vision modality). Audit log (who produced what). | `Artifact` records with provenance, `review(artifact, rubric, reviewerRole)` over HTTP and MCP, `ReviewResult` (pass/fail/revise with reasons), vision review against reference material, and the rule that the author principal cannot mark its own artifact reviewed. |
| **Scheduler with typed routines and missed-run detection** | `ModelCatalogService` has a trivial self-rescheduling timer; nothing general. | — | `core/orchestrator`: `Routine` with `recurring`/`one_off`/`window` schedules, timezone-aware next-run computation, leased run claiming, a reconciliation loop producing `routine.missed` incidents, `one_off` completing visibly. |
| **Durable agent records with restart** | Placeholder `AgentConfig` type. | — | `Agent` record (remit version, role, scopes, memory namespace, storage prefix, budget, runtime binding), `Job` with checkpoint state and leases, heartbeats, supervisor that restarts a runtime from the record, agent runtime harness in `core/agents`. |
| **Approval inbox (web + Slack) with batching and expiry** | Nothing. Dashboard shell in `core/ux`. | `core/ux` patterns (polling, cards, real-API tests). | Approval service in the gateway (it holds `send`), `ApprovalItem` lifecycle, batching by kind, pinning of blocking items, expiry sweeper, reject reasons into agent memory, execution of approved actions through the policy engine. Web inbox and Slack Block Kit messages with interaction webhook. |
| **Object storage with retention classes** | Nothing. | — | S3-compatible client (R2 in production, MinIO in dev/CI), four retention classes mapped to prefixes with bucket lifecycle rules, per-agent prefixes and quotas, `storage.*` tool with `internal` egress for our bucket and `production` egress for the CDN bucket. |
| **Morning brief** | Nothing. | Telemetry/cost queries, incidents, approvals, storage usage. | Brief composer that reads structured data only, a `recurring` routine owned by Captain at 06:00 Pacific, web view, Slack delivery, links into the inbox. |
| **Migrated agents** (Captain, social engagement, OSS promoter, Rustboy QC → chronicle) | Nothing. | — | Remits, scope grants, routes, routines, and runtime entrypoints for the four agents; the QC → chronicle path exercises vision review and production CDN gating. |

Out of MVP scope and deliberately not planned here: standing-rule suggestions, the full film DAG, cloud coding agent orchestration, the inter-agent message bus (Captain's escalations in the MVP arrive as incidents and approval items, and its delegated calls are recorded as `Decision` records), email as an approval channel, multi-tenancy.

## 3. Target layout, data models, and interfaces

### 3.1 Packages and modules

```
core/
  common/                    @autonomo.us/common — shared types (extended per PR; no runtime code)
  db/                        @autonomo.us/db — NEW. Postgres pool, SQL migrations, repositories, test env helper
    src/
      pool.ts                pg Pool from DATABASE_URL, health probe
      migrate.ts             forward-only runner over migrations/*.sql, records applied versions
      repositories/          one module per aggregate: agents, secrets, registry, scopes, quotas, routes,
                             artifacts, reviews, approvals, routines, jobs, incidents, decisions, memory, objects
    migrations/              0001_init.sql, 0002_vault.sql, ...
    test/postgres-env.ts     probe + skipIf helper, unique schema per suite (mirrors test/clickhouse-env.ts)
  api/                       @autonomo.us/api — the gateway
    src/
      auth/                  principals, gateway identity tokens, Fastify auth hook
      vault/                 Vault (encrypt/decrypt, rotate, revoke), env seeding
      registry/              ServerRegistry (models + tools), health checks, ProviderRegistry adapter
      policy/                PolicyEngine: scopes, verbs, quotas, egress, data classes, budgets, ceilings
      router/                RoutingTable, model families, resolveRoute(); chat.ts attempt loop moves here
      review/                review() primitive, artifact provenance, rubric handling, vision reviews
      approvals/             ApprovalService, expiry sweeper, batching, executors, Slack adapter
      storage/               ObjectStore (S3 API), retention classes, lifecycle configuration, quotas
      mcp/                   McpServer endpoint (agents → gateway), McpClientPool (gateway → tool servers)
      tools/                 built-in tool servers: memory, storage, github, x, slack, owner-notify
      audit/                 AuditLog + CostMeter (evolution of telemetry/), pricing, rollups
      routes/                HTTP routes: chat, registry, scopes, routes, review, approvals, costs, slack, ...
  orchestrator/              @autonomo.us/orchestrator — NEW. Separate process
    src/
      scheduler/             next-run computation, run claiming, dispatch
      reconciler/            missed-run detection, incidents
      supervisor/            heartbeats, restart from record, pause/revoke hooks
      jobs/                  durable job queue with leases and checkpoints
      brief/                 morning brief composer and delivery
  agents/                    @autonomo.us/agents — NEW. Runtime harness + migrated agents
    src/
      harness/               agent loop over the gateway's MCP endpoint, heartbeat, checkpointing
      captain/ social/ oss-promoter/ film-qc/ chronicle/
        remit.md, config.ts (role, routes, routines, scopes), entry.ts
  ux/                        @autonomo.us/ux — dashboard gains Inbox, Agents, Routines, Registry, Costs, Brief
  logo/                      unchanged
```

Why this split: the gateway (`api`) owns everything that must be enforced in one place (identity, secrets, policy, routing, review, approvals, audit). The orchestrator owns time and lifecycle (schedules, jobs, heartbeats, the brief). Agents are clients of the gateway and nothing else. `db` is shared because the gateway and the orchestrator read the same records, and it keeps migrations in one place. One deviation from the design's diagram: the approval service lives in the gateway rather than the orchestrator, because it is the only holder of `send` scopes and must execute approved actions through the policy engine and vault in-process.

Runtime topology for the MVP: one host running `docker compose` with `api`, `orchestrator`, `ux`, `postgres`, `clickhouse`, `minio` (dev only; R2 in production), plus one `agents` worker container per migrated agent launched by the orchestrator. See open question 2.

### 3.2 Identity and agents

```ts
export type AgentId = string;
export type BusinessUnit = "hyphen" | "oss" | "film" | "personal" | "platform";

/** Who is calling the gateway. Derived from the bearer token, never from the body. */
export type Principal =
	| { kind: "agent"; agentId: AgentId; runId?: string }
	| { kind: "approval-service" }
	| { kind: "orchestrator" }
	| { kind: "owner" };

export type RuntimeBinding =
	| { kind: "worker"; entry: string; heartbeatIntervalMs: number }
	| { kind: "script"; entry: string };
	// Phase 2: { kind: "cloud-coding-agent"; provider: string }

export type Agent = {
	id: AgentId;
	name: string;
	role: string; // "captain" | "social" | "oss-promoter" | "film-qc" | "chronicle" | ...
	businessUnit: BusinessUnit;
	remit: { version: number; markdown: string; compiledAt: string };
	status: "active" | "paused" | "revoked";
	runtime: RuntimeBinding;
	memoryNamespace: string;
	storagePrefix: string;
	budget?: Budget;
	createdAt: string;
	updatedAt: string;
};

export type GatewayIdentity = {
	id: string;
	principal: Principal;
	tokenHash: string; // sha256 of the bearer token; plaintext shown once at creation
	revokedAt?: string;
	createdAt: string;
};
```

### 3.3 Registry, vault, egress, data classes

```ts
export type EgressClass = "internal" | "private-external" | "public" | "production";
export type DataClass = "public" | "internal" | "finance" | "personal";
export type Verb = "read" | "draft" | "write" | "send" | "delete";
export type Capability = `${string}.${string}`; // "text.generate", "vision.judge", "email.draft", "storage.write"

export type ServerTransport =
	| { type: "builtin" }
	| { type: "mcp-http"; url: string }
	| { type: "provider-sdk"; sdk: "anthropic" | "openai-compatible"; baseURL?: string };

export type ServerEntry = {
	id: string; // "anthropic" | "openrouter" | "xai" | "github" | "storage" | ...
	kind: "model" | "tool";
	transport: ServerTransport;
	secretRef?: string; // vault key; redacted on every read path
	capabilities: Capability[];
	tools: ToolEntry[]; // empty for model servers
	health: { status: "healthy" | "degraded" | "down"; checkedAt: string; errorRate1h: number };
	enabled: boolean;
};

export type ToolEntry = {
	name: string; // "github.comments", "storage.objects", "x.replies"
	capability: Capability;
	verbs: Verb[];
	egress: EgressClass;
	allowedDataClasses: DataClass[];
	cost?: { perCallUsd?: number };
	inputSchema: Record<string, unknown>; // from MCP tools/list
};

export type ModelFamily =
	| "anthropic" | "openai" | "google" | "xai" | "mistral" | "deepseek" | "meta" | "qwen" | "other";

export type ModelEntry = {
	id: string; // "anthropic/claude-opus-4-8", "openrouter/x-ai/grok-4"
	serverId: string;
	family: ModelFamily; // derived from provider + model id; OpenRouter ids carry the vendor prefix
	modalities: Array<"text" | "vision">;
	contextTokens?: number;
	pricing?: { inputPerMTokUsd: number; outputPerMTokUsd: number };
	allowedDataClasses: DataClass[];
};

export type EgressPolicy = {
	class: EgressClass;
	requiresHumanGate: boolean; // public and production: true, non-overridable in MVP
	allowedDataClasses: DataClass[];
	stagingAlternative?: string; // tool name, e.g. "cdn.staging"
};

export interface Vault {
	put(ref: string, value: string, meta?: { serverId?: string; purpose?: string }): Promise<void>;
	/** Only callable by gateway internals; never surfaced through a route or MCP tool. */
	resolve(ref: string): Promise<string>;
	rotate(ref: string, value: string): Promise<void>;
	revoke(ref: string): Promise<void>;
	list(): Promise<Array<{ ref: string; serverId?: string; purpose?: string; updatedAt: string }>>;
}
```

### 3.4 Scopes, quotas, policy

```ts
export type Quota = { limit: number; per: "hour" | "day" | "week"; tz: string };

export type ResourceFilter = {
	repos?: string[]; // "jaredwray/*"
	buckets?: string[];
	prefixes?: string[];
	accounts?: string[]; // X handles, Slack channels
};

export type ScopeGrant = {
	id: string;
	agentId: AgentId;
	tool: string;
	verbs: Array<Exclude<Verb, "send">>; // the type system enforces the design rule
	resources?: ResourceFilter;
	quota?: Quota;
	expiresAt?: string;
	grantedBy: "owner";
	createdAt: string;
};

export type Budget = { softUsd: number; hardUsd: number; per: "day" | "month" };

export type PolicyRequest = {
	principal: Principal;
	tool: string;
	verb: Verb;
	egress: EgressClass;
	dataClass: DataClass;
	resource?: Record<string, string>;
	estimatedCostUsd?: number;
};

export type PolicyDenial =
	| "unauthenticated" | "agent_paused" | "agent_revoked" | "no_grant" | "verb_not_granted"
	| "resource_not_allowed" | "quota_exceeded" | "egress_requires_approval"
	| "data_class_blocked" | "budget_exhausted" | "ceiling_exceeded" | "server_disabled";

export type PolicyDecision =
	| { allow: true; grantId?: string; quotaRemaining?: number }
	| { allow: false; reason: PolicyDenial; detail?: string };

export interface PolicyEngine {
	authorize(request: PolicyRequest): Promise<PolicyDecision>;
	/** Called after a successful call so quotas and budgets reflect real usage. */
	record(request: PolicyRequest, actualCostUsd: number): Promise<void>;
}
```

### 3.5 Routing

```ts
export type Role = "writer" | "reviewer" | "vision_qc" | "coder" | "summarizer" | (string & {});

export type RouteConstraints = {
	modality?: "text" | "vision";
	minContextTokens?: number;
	allowedDataClasses?: DataClass[];
	maxCostPerCallUsd?: number;
};

export type RouteTarget = { model: string; constraints?: RouteConstraints };

export type RouteScope =
	| { level: "global" }
	| { level: "agent"; agentId: AgentId }
	| { level: "task"; task: string };

export type Route = {
	id: string;
	role: Role;
	scope: RouteScope;
	targets: RouteTarget[]; // tried in order; the existing failover loop runs them
	timeoutMs: number;
	updatedAt: string;
};

export type RouteRequest = {
	role: Role;
	principal: Principal;
	task?: string;
	dataClass: DataClass;
	excludeFamilies?: ModelFamily[]; // review() sets this to the author's family
	requireModality?: "vision";
};

export type RouteResolution = {
	route: Route;
	candidates: Array<{ model: ModelEntry; timeoutMs: number }>;
	excluded: Array<{ model: string; reason: string }>; // logged, visible in audit
};

export interface Router {
	resolve(request: RouteRequest): Promise<RouteResolution>;
}

/** Chat request after this plan: `role` replaces `model` for agents; `model` stays for the owner. */
export type GatewayChatRequest = {
	role?: Role;
	model?: string;
	task?: string;
	dataClass?: DataClass; // default "internal"
	messages: GatewayMessage[];
	stream?: boolean;
	temperature?: number;
	maxTokens?: number;
	artifact?: { kind: Artifact["kind"]; register: true }; // register the output as an artifact
};
```

### 3.6 Review

```ts
export type Artifact = {
	id: string;
	kind: "text" | "markdown" | "image" | "video" | "github_comment" | "github_pr" | "x_post" | "slack_message";
	inline?: string;
	uri?: string; // object storage key for media
	dataClass: DataClass;
	producedBy: { agentId: AgentId; runId: string; model: string; family: ModelFamily };
	createdAt: string;
};

export type Rubric = {
	name: string;
	criteria: string[];
	references?: Array<{ uri: string; description: string }>; // e.g. the character sheet
};

export type ReviewVerdict = "pass" | "fail" | "revise";

export type ReviewResult = {
	id: string;
	artifactId: string;
	verdict: ReviewVerdict;
	reasons: string[];
	reviewer: { model: string; family: ModelFamily; role: Role };
	authorFamily: ModelFamily;
	rubric: Rubric;
	runId: string;
	costUsd: number;
	createdAt: string;
};

export interface ReviewService {
	/**
	 * Picks a reviewer route excluding the author's family (and requiring vision
	 * for media artifacts), runs the rubric, stores and returns the result.
	 * Rejects when no non-author family is routable rather than self-reviewing.
	 */
	review(input: {
		artifactId: string;
		rubric: Rubric;
		reviewerRole: Role; // "reviewer" | "vision_qc"
		principal: Principal;
	}): Promise<ReviewResult>;
}
```

### 3.7 Approvals

```ts
export type ApprovalKind =
	| "x.reply" | "x.post" | "github.comment" | "github.pr" | "cdn.production_upload"
	| "slack.message" | (string & {});

export type ProposedAction = {
	tool: string;
	verb: "write" | "send" | "delete";
	egress: EgressClass;
	input: Record<string, unknown>;
	preview: string; // what the owner sees
};

export type ApprovalStatus =
	| "pending" | "snoozed" | "approved" | "executing" | "executed" | "failed" | "rejected" | "expired";

export type ApprovalDecision = {
	by: "owner";
	channel: "web" | "slack";
	action: "approve" | "edit_approve" | "reject" | "snooze";
	editedInput?: Record<string, unknown>;
	reason?: string;
	snoozeUntil?: string;
	at: string;
};

export type ApprovalItem = {
	id: string;
	kind: ApprovalKind;
	agentId: AgentId;
	runId: string;
	jobId?: string;
	action: ProposedAction;
	artifactId?: string;
	reviews: ReviewResult[]; // attached; an item with a failed required review cannot be approved
	blocks: string[]; // job ids waiting on this item; non-empty → pinned
	status: ApprovalStatus;
	expiresAt: string;
	decision?: ApprovalDecision;
	executionError?: string;
	createdAt: string;
	updatedAt: string;
};

export type ApprovalBatch = { kind: ApprovalKind; items: ApprovalItem[] };

export interface ApprovalService {
	request(input: Omit<ApprovalItem, "id" | "status" | "decision" | "createdAt" | "updatedAt">): Promise<ApprovalItem>;
	decide(itemId: string, decision: ApprovalDecision): Promise<ApprovalItem>;
	decideMany(itemIds: string[], decision: ApprovalDecision): Promise<ApprovalItem[]>;
	inbox(): Promise<{ pinned: ApprovalItem[]; batches: ApprovalBatch[] }>;
	expireStale(now: Date): Promise<ApprovalItem[]>;
}
```

### 3.8 Routines, jobs, incidents

```ts
export type RoutineSchedule =
	| { type: "recurring"; cron: string; tz: string }
	| { type: "one_off"; at: string }
	| { type: "window"; everyMinutes: number; start: string; end: string; tz: string; days?: number[] };

export type Routine = {
	id: string;
	name: string;
	agentId: AgentId;
	schedule: RoutineSchedule;
	task: string; // what the agent runtime is asked to do
	priority: "low" | "normal" | "high";
	status: "active" | "paused" | "completed"; // one_off → completed after its run
	nextRunAt?: string; // always present while active
	lastRunAt?: string;
	missedGraceMs: number;
	budget?: Budget;
	createdAt: string;
	updatedAt: string;
};

export type RoutineRun = {
	id: string;
	routineId: string;
	scheduledFor: string;
	startedAt?: string;
	finishedAt?: string;
	status: "scheduled" | "running" | "succeeded" | "failed" | "missed";
	jobId?: string;
	error?: string;
};

export type JobState =
	| "queued" | "running" | "waiting_review" | "waiting_approval" | "succeeded" | "failed" | "cancelled";

export type Job = {
	id: string;
	agentId: AgentId;
	routineRunId?: string;
	kind: string;
	state: JobState;
	checkpoint: Record<string, unknown>; // recovered on restart
	attempts: number;
	leaseOwner?: string; // runtime id
	leaseUntil?: string;
	createdAt: string;
	updatedAt: string;
};

export type Heartbeat = { agentId: AgentId; runtimeId: string; jobId?: string; at: string };

export type IncidentKind =
	| "routine.missed" | "routine.failed" | "agent.unreachable" | "agent.restarted"
	| "review.failed" | "budget.soft" | "budget.hard" | "server.down" | "approval.expired";

export type Incident = {
	id: string;
	kind: IncidentKind;
	severity: "info" | "warning" | "critical";
	subject: { agentId?: AgentId; routineId?: string; runId?: string; serverId?: string };
	summary: string;
	status: "open" | "acknowledged" | "resolved";
	createdAt: string;
	resolvedAt?: string;
};

/** A call Captain made under its standing delegation; reviewed in the brief. */
export type Decision = {
	id: string;
	agentId: AgentId; // captain
	runId: string;
	summary: string;
	reversible: boolean;
	reversedAt?: string;
	createdAt: string;
};
```

### 3.9 Storage, audit, cost, brief

```ts
export type RetentionClass = "scratch" | "working" | "record" | "sensitive";

export type StoredObject = {
	key: string; // `${class}/${agentId}/...`
	bucket: string;
	class: RetentionClass;
	agentId: AgentId;
	runId: string;
	contentType: string;
	bytes: number;
	sha256: string;
	expiresAt?: string; // scratch: +24h; working: workflow end + grace
	createdAt: string;
};

export type AuditEventType =
	| "gateway.chat" | "gateway.error" | "route.fallback" | "tool.call" | "tool.denied"
	| "review" | "approval.requested" | "approval.decided" | "approval.executed"
	| "routine.run" | "agent.lifecycle" | "secret.rotated" | "identity.revoked";

export type AuditEvent = {
	id: string;
	type: AuditEventType;
	principal: Principal;
	agentId?: AgentId;
	runId?: string;
	routineId?: string;
	jobId?: string;
	role?: Role;
	model?: string;
	family?: ModelFamily;
	tool?: string;
	verb?: Verb;
	egress?: EgressClass;
	dataClass?: DataClass;
	decision?: PolicyDecision;
	usage?: TokenUsage;
	costUsd: number;
	latencyMs?: number;
	error?: string;
	data: Record<string, unknown>;
	timestamp: string;
};

export type CostRollup = {
	by: "call" | "run" | "agent" | "routine" | "businessUnit";
	key: string;
	window: { from: string; to: string };
	calls: number;
	costUsd: number;
};

export type MorningBrief = {
	date: string;
	shipped: Array<{ agentId: AgentId; summary: string; link?: string }>;
	waitingOnMe: ApprovalItem[]; // sorted by blocks.length desc, then age
	decisions: Decision[];
	incidents: Incident[];
	spend: CostRollup[]; // by agent, with budget status
	storage: Array<{ agentId: AgentId; bytes: number; quotaBytes: number }>;
	inboxUrl: string;
};
```

### 3.10 Gateway surfaces

HTTP (owner and dashboard; bearer token with `owner` principal):

| Route | Purpose |
| --- | --- |
| `POST /v1/chat` | Existing. Gains `role`, `task`, `dataClass`, `artifact`; `model` allowed for the owner only. |
| `POST /v1/review` | `review()` over HTTP. |
| `GET/PUT /v1/registry/servers[/:id]` | Registry admin; `secretRef` values redacted. |
| `GET/PUT /v1/vault/secrets[/:ref]`, `POST .../rotate`, `DELETE` | Vault admin; write-only values. |
| `GET/POST/DELETE /v1/agents[/:id]`, `POST /v1/agents/:id/{pause,resume,revoke,restart}` | Agent records and recovery primitives. |
| `GET/PUT /v1/agents/:id/scopes` | Scope grants. |
| `GET/PUT /v1/routes` | Routing table. `GET/PUT /v1/failover` kept as a compatibility shim for the global default route for one release. |
| `GET /v1/inbox`, `POST /v1/approvals/:id/decide`, `POST /v1/approvals/decide` | Approval inbox and decisions (single and batch). |
| `POST /v1/slack/interactions`, `POST /v1/slack/events` | Slack webhooks, signature-verified. |
| `GET/POST /v1/routines[/:id]`, `POST /v1/routines/:id/{pause,resume}` | Routine admin (proxied to orchestrator tables). |
| `GET /v1/incidents`, `GET /v1/costs?by=...`, `GET /v1/brief/:date` | Observability and the brief. |
| `GET /v1/telemetry/*`, `GET /v1/models*`, `GET /health` | Existing. |

MCP (agents; Streamable HTTP at `/mcp`, bearer token with `agent` principal). Exposed tools, filtered per caller by scopes:

| Tool | Notes |
| --- | --- |
| `chat` | Role-based generation. Agents cannot name a model. |
| `review` | The primitive. The caller cannot review an artifact it produced. |
| `memory.get` / `memory.set` / `memory.search` | Agent memory in the caller's namespace. |
| `storage.put` / `storage.get` / `storage.list` | Caller's prefix plus explicitly shared prefixes; `class` required on put. |
| `approval.request` | Submits a `ProposedAction` for a `send`/`write`/`delete` on a gated egress class. Returns the item id; the job moves to `waiting_approval`. |
| `<tool>.<verb>` for granted tool entries | e.g. `github.comments.draft`, `x.replies.draft`. `send` never appears in any agent's `tools/list`. |

## 4. Open questions: positions and decisions needed

Positions are what the PR sequence assumes. "Decision needed" marks where the owner must confirm before the dependent PR starts; the rest can be changed later without rework.

### 4.1 Build the gateway or extend an existing MCP gateway/proxy? (design Q1)

**Position: build the gateway core on the existing `core/api`, borrow the MCP protocol layer.** The differentiators (registry with verbs and egress classes, scopes with quotas, `review()`, approval-held `send`) are policy decisions on every call, and the repo already has the pieces around them: the Fastify host, provider adapters, the failover loop, and ClickHouse telemetry. Off-the-shelf MCP proxies solve transport fan-out and auth, which the official `@modelcontextprotocol/sdk` already gives us (Streamable HTTP server and client, tool listing and invocation, schemas); they would put our enforcement logic in someone else's plugin model. We use the SDK for protocol, keep provider access on the Vercel AI SDK as today, and write the policy core ourselves.

**Decision needed before PR 7:** confirm this. If the owner prefers a specific existing proxy, PR 7 changes shape (the gateway becomes a policy plugin for that proxy) and PRs 3–5 lose their MCP-facing assumptions.

### 4.2 Where do agent runtimes execute? (design Q2)

**Position: our own workers for the MVP, one host, launched by the orchestrator.** An agent runtime is a Node process from `core/agents` (`RuntimeBinding.kind: "worker"`) that talks only to the gateway's MCP endpoint, heartbeats, and checkpoints into its `Job`. The orchestrator starts it as a container (compose) or child process (dev), and restarts it from the agent record when a heartbeat is missed. Recovery is then a database operation. The Rustboy QC → chronicle path uses `kind: "script"` runtimes for the measurement step. Provider-hosted sessions and cloud coding agents are a Phase 2 `RuntimeBinding` variant; their recovery story (re-attach vs. re-create) is what makes them harder, and the dev manager that needs them is out of MVP scope.

**Decision needed before PR 1:** confirm single-host `docker compose` on a VM the owner controls as the MVP deployment target, and confirm workers run there (not on provider-hosted sessions). This fixes the compose topology that PR 1 starts building.

### 4.3 Postgres replaces MongoDB (not in the design's list, but blocks PR 1)

**Position: Postgres, per design section 7; remove the unused MongoDB service and dependency.** The scheduler, approvals, quotas, and job leases all want transactions and `SELECT ... FOR UPDATE SKIP LOCKED`; `pgvector` covers the retrieval index later; `pg` is pure JS so it clears `strictDepBuilds`. Keyv stays available as the cache/light-state interface (`cacheable` is already a dependency).

**Decision needed before PR 1:** confirm dropping Mongo.

### 4.4 Captain's delegation and how to review it (design Q3)

**Position for MVP: narrow and visible.** Captain holds `read` on everything it coordinates and `draft` on Slack messages to the owner; it holds no `write`, `send`, or `delete` on any external tool. Its delegated calls are the film production calls the design mentions, recorded as `Decision` records, listed in the brief's "decisions" section with a one-click reverse where the action is reversible. The brief is the review surface; no second inbox. Broader delegation is a Phase 2 standing rule.

**No decision needed for MVP.** The default is conservative; widening it later is a scope-grant change.

### 4.5 Granularity of cross-model review (design Q4)

**Position for MVP: every artifact that becomes an approval item is reviewed, no sampling.** Sampling needs a track record; the audit log built in PR 5 and the review records from PR 9 are what will make a Phase 3 sampling decision evidence-based.

**No decision needed.**

### 4.6 LinkedIn (design Q5)

Out of MVP scope (the lead generator is Phase 2). **No decision needed now.**

### 4.7 Cost attribution across agents and businesses (design Q6)

**Position for MVP: attribute to the calling agent; roll up by the agent's `businessUnit`.** Every agent and routine carries a `BusinessUnit`; every audit event carries `agentId`, `runId`, `routineId`, and the derived business unit. A workflow that spans agents is reported per agent and summed per business unit, which is enough for the brief's spend section. Shared costs (Captain, the platform itself) land in `platform`.

**Decision needed before PR 15, not before:** confirm the four business units and which bucket Captain's spend belongs to. The schema is unaffected either way.

### 4.8 Which data classes may go to which model providers (design Q7)

**Position for MVP: a registry-maintained mapping with a conservative default.** `ModelEntry.allowedDataClasses` and `ToolEntry.allowedDataClasses` are data in the registry, edited through the admin API; the router and policy engine refuse mismatches. Default: `public` and `internal` go anywhere enabled; `finance` and `personal` go nowhere except `internal` egress and models explicitly cleared by the owner (none by default). The owner maintains the mapping; a monthly reminder to review it belongs in the brief in Phase 2.

**No decision needed for MVP** (no migrated MVP agent handles `finance` or `personal` data). Needed before migrating the money saver in Phase 2.

### 4.9 Further owner inputs the sequence depends on

These are not design questions, but PRs block on them:

| Needed by | Input |
| --- | --- |
| PR 2 | A `VAULT_MASTER_KEY` strategy for the MVP: a 32-byte key in the host's env (position), vs. a KMS. |
| PR 3 | Provider accounts for the two direct providers plus OpenRouter. Position: Anthropic (exists) and xAI direct, both already supported by `providerFromConfig` (xAI is OpenAI-compatible), plus OpenRouter (OpenAI-compatible). |
| PR 8 | An R2 bucket pair (artifacts, production CDN) and credentials; MinIO is used until then. |
| PR 11 | A Slack app in the owner's workspace with a bot token, signing secret, and the owner's user id. |
| PR 15 | GitHub and X API credentials for the social and OSS promoter agents; the Rustboy character reference material uploaded as `record` class. |

## 5. PR sequence

Fifteen implementation PRs, each small enough to review in one sitting, each landing behind the previous one on `main`. Dependencies are listed; PRs with the same prerequisites can be developed in parallel but should merge in order to keep migrations linear. Every PR follows the real-services testing style from [section 6](#6-testing-approach) and is reviewed against [section 7](#7-review-rubric-for-implementation-prs).

Numbering continues from this PR (PR 0).

### PR 1: `core/db` package, Postgres in compose and CI, drop MongoDB

**Depends on:** decisions 4.2, 4.3.

**Scope**

- New `@autonomo.us/db`: `pg` pool from `DATABASE_URL`, health probe, forward-only SQL migration runner (`migrations/0001_init.sql` creating `schema_migrations` only), a `repositories/` skeleton, and `test/postgres-env.ts` modeled on `core/api/test/clickhouse-env.ts` (probe `SELECT 1`, `describe.skipIf` with a warning, unique schema per suite, cleanup).
- `docker-compose.yml`: add `postgres:17` with a healthcheck; remove `mongo` and `MONGODB_URL`. Remove the `mongodb` dependency from `core/api`. Add a `postgres` service container to `.github/workflows/tests.yml` and `release.yaml`.
- `core/api/Dockerfile` copies `core/db` manifests and dist.
- README: Postgres in the getting-started and testing sections.

**Acceptance criteria**

- `pnpm build` and `pnpm test` pass; the db suite runs against the compose Postgres and skips loudly without one.
- The migration runner is idempotent (running twice applies nothing new) and refuses out-of-order versions.
- `docker compose up --build` still brings up `api` and `ux` healthy.

**Tests:** real Postgres: apply migrations to a fresh schema, re-apply, assert `schema_migrations`; pool health probe against a dead port times out within budget.

### PR 2: Gateway identities and the secrets vault

**Depends on:** PR 1; input 4.9 (`VAULT_MASTER_KEY`).

**Scope**

- `auth/`: `Principal`, `GatewayIdentity`, bearer-token issuance (plaintext returned once, `sha256` stored), revocation, a Fastify `onRequest` hook that sets `request.principal`. `GET /health` stays open. An `AUTH_MODE=disabled` escape hatch for local dev that logs loudly at boot; the default is enforced.
- `vault/`: AES-256-GCM envelope encryption with `VAULT_MASTER_KEY`, `secrets` table, `Vault` interface, admin routes that accept values and never return them, rotation and revocation with audit events.
- `configFromEnv` provider keys are seeded into the vault at boot (`seedVaultFromEnv`) and providers resolve `secretRef` at construction. Env-only operation still works.
- Owner identity bootstrap: `OWNER_TOKEN` env, or a one-time `pnpm --filter @autonomo.us/api identity:create --owner` script.
- Dashboard: reads `VITE_OWNER_TOKEN` (dev) or a token entered once and kept in session storage; every call sends `Authorization: Bearer`.

**Acceptance criteria**

- Every `/v1/*` route returns 401 without a valid token and 403 for a revoked one; the dashboard works with the owner token.
- A request that tries to read a secret value (vault route, registry route, MCP tool, log line) gets a redacted value; a test greps response bodies and the Fastify log stream for the plaintext.
- Rotating a secret changes what providers use on the next call without a restart.

**Tests:** real Postgres for identities and secrets; real server with the OpenAI-compatible stub: the stub asserts the `Authorization` header it receives equals the vault value after rotation; `core/ux` tests boot the real API with a token.

### PR 3: Server registry, egress classes, data classes, OpenRouter and a second direct provider

**Depends on:** PR 2; input 4.9 (provider accounts).

**Scope**

- `registry/`: `ServerEntry`, `ToolEntry`, `ModelEntry`, `EgressPolicy` tables and repository; `ServerRegistry` loads enabled entries and builds the existing `ProviderRegistry` from `model` servers (`transport.type: "provider-sdk"`). Model families derived from provider and id (`claude-*` → anthropic, `grok-*` → xai, OpenRouter `vendor/model` prefixes). Health checks per server (model servers: `GET /models` or a cheap call; tool servers: MCP `ping`) on a timer, status in the entry.
- Registry entries for `anthropic`, `xai`, `openrouter` (both OpenAI-compatible via the existing factory), seeded from env on first boot. `ModelCatalogService` gains models.dev `cost` and `modalities` per model and feeds `ModelEntry.pricing`/`modalities`.
- `EgressPolicy` defaults: `internal` and `private-external` no gate; `public` and `production` gate required and not editable in MVP.
- Routes: `GET/PUT /v1/registry/servers[/:id]` (secretRef redacted), `GET /v1/registry/egress`. Dashboard: a registry card listing servers, health, and tools with egress classes.

**Acceptance criteria**

- `GET /v1/models` lists models from all three model servers; `POST /v1/chat` (owner, `model` form) succeeds against each one that has credentials in the test environment (CI uses the stub as all three).
- Disabling a server in the registry removes its models from routing within one request.
- A tool entry cannot be saved with `egress: "production"` and `requiresHumanGate: false`.

**Tests:** real Postgres; three stub provider instances registered as separate servers through the registry (not env), proving the registry → `ProviderRegistry` path; health check flips to `down` when a stub is closed and back when restarted.

### PR 4: Scopes, verbs, quotas, and the policy engine

**Depends on:** PR 3.

**Scope**

- `policy/`: `ScopeGrant`, `Quota`, `ResourceFilter`, quota counters (Postgres, windowed by `per` and `tz`), `PolicyEngine.authorize()` and `record()`. Denial reasons as in 3.4. Agents in `paused`/`revoked` status are denied everything.
- Enforcement points: `POST /v1/chat` (capability `text.generate`, verb `read`), and a generic `executeTool(principal, tool, verb, input)` used by every later tool path. `send` is unrepresentable in `ScopeGrant.verbs` and rejected by the route schema; only the `approval-service` principal passes an `authorize()` for `send`.
- Minimal `agents` table (id, name, role, businessUnit, status) so grants have a subject; the full record lands in PR 13.
- Routes: `GET/PUT /v1/agents/:id/scopes`. Dashboard: scopes shown on an agent view.

**Acceptance criteria**

- An agent with `github.comments: [draft]` is denied `write` with `verb_not_granted` and denied a repo outside its filter with `resource_not_allowed`.
- A 3-per-day quota allows three calls and denies the fourth with `quota_exceeded`; the window rolls over at midnight in the grant's `tz`.
- A `PUT` with `verbs: ["send"]` returns 400; an `approval-service` principal is authorized for `send`.
- Every denial produces a `tool.denied` audit event (ClickHouse row).

**Tests:** real Postgres for grants and counters with an injected clock for window rollover; real server with two agent identities and the stub provider.

### PR 5: Audit log and cost metering

**Depends on:** PR 4.

**Scope**

- `audit/`: `AuditEvent` type; ClickHouse table `audit_events` (v2 of `telemetry_events`) with the new columns (`principal`, `run_id`, `routine_id`, `job_id`, `role`, `family`, `tool`, `verb`, `egress`, `data_class`, `decision`, `cost_usd`). `TelemetryService` becomes `AuditLog` with the same buffering, dedup, and in-memory summary; the old table is read for the dashboard's historical summary until a one-time backfill script copies it.
- `CostMeter`: price per call from `ModelEntry.pricing` (tokens) and `ToolEntry.cost`; per-call ceiling (`MAX_CALL_COST_USD`, refused before the call using `maxTokens`); `Budget` on agents and routines with soft (incident `budget.soft`) and hard (`budget_exhausted` denial, agent paused, incident `budget.hard`).
- Rollups: `GET /v1/costs?by=agent|routine|run|businessUnit&from&to` from ClickHouse. Dashboard: spend by agent tile.
- `run_id` propagation: the gateway accepts an `x-run-id` header from agents and the orchestrator and stamps every event.

**Acceptance criteria**

- A chat call with known pricing produces an audit row whose `cost_usd` equals tokens × price within rounding; a tool call produces one with `tool`, `verb`, `egress`.
- A hard budget of $0.01 denies the second call after a $0.009 first call and pauses the agent; the soft budget creates one incident, not one per call.
- From any `run_id`, a single ClickHouse query answers: agent, model, family, cost, and every policy decision.

**Tests:** real ClickHouse and Postgres; the stub provider reports fixed `usage`, so expected cost is exact; the per-call ceiling is tested with `maxTokens` large enough to exceed it.

### PR 6: Role-based router with fallback

**Depends on:** PR 5.

**Scope**

- `router/`: `Route`, `RouteTarget`, `RoutingTable` (Postgres), `Router.resolve()` with scope precedence task > agent > global, constraint filtering (modality, context, data class, cost per call), `excludeFamilies`. The attempt loop and streaming semantics from `routes/chat.ts` move to `router/attempt.ts` unchanged in behavior; `route.fallback` audit events replace the `requestedModel` convention.
- `POST /v1/chat` accepts `role` (agents must use it; `model` is owner-only), `task`, `dataClass`. `FailoverPolicyStore` is replaced by the global `default` route; `GET/PUT /v1/failover` remains as a shim mapping to that route and is marked deprecated in the README.
- Seed routes: `writer`, `reviewer`, `vision_qc`, `summarizer`, each with at least two families across the three servers.
- Dashboard: the failover card becomes a routes card (role → ordered targets, per-agent overrides read-only).

**Acceptance criteria**

- An agent request with `role: "writer"` is served by the first target; when that server's stub returns 500 the second target (a different family) serves it and a `route.fallback` event is logged with both models.
- A request with `dataClass: "finance"` is refused with `data_class_blocked` when no target allows it; a `requireModality: "vision"` resolution excludes text-only models.
- `excludeFamilies: ["anthropic"]` never yields an anthropic model even when it is first in the route.
- Existing `PUT /v1/failover` tests still pass through the shim.

**Tests:** real server with three stub servers registered as different families; the existing failover suites are ported to roles and kept green.

### PR 7: MCP transport: gateway as MCP server, MCP client pool, built-in tool servers

**Depends on:** PR 4 (policy), decision 4.1.

**Scope**

- `mcp/McpServer`: `@modelcontextprotocol/sdk` Streamable HTTP endpoint at `/mcp` on the same Fastify instance; auth via the PR 2 hook (`agent` principals). `tools/list` returns `chat`, `memory.*`, `storage.*` (wired in PR 8), `approval.request` (wired in PR 10), plus granted `<tool>.<verb>` entries; `tools/call` goes through `executeTool()`. Sessions are stateless per request so a restarted gateway loses nothing.
- `mcp/McpClientPool`: connects to `transport.type: "mcp-http"` tool servers with vault-injected headers, caches `tools/list` into `ToolEntry.inputSchema`, reconnects on failure, marks health.
- `tools/`: built-in server framework (`defineBuiltinTool`), the `memory` tool (Postgres `agent_memory` table, namespace enforced from the principal), and an `echo` tool used by tests.

**Acceptance criteria**

- A real MCP client (`@modelcontextprotocol/sdk` client over Streamable HTTP) with an agent token lists only its granted tools and can call `chat` with a role and `memory.set/get` in its own namespace; a second agent cannot read the first's memory.
- An external MCP server (a small real server from the SDK started in the test) registered via the registry appears in the agent's `tools/list` after a grant and its calls are audited with `egress` from the registry entry.
- Calls without a token are rejected at the MCP layer with an auth error, not a transport error.

**Tests:** real MCP client and a real external MCP server from the SDK over HTTP; real Postgres for memory.

### PR 8: Object storage with retention classes

**Depends on:** PR 4; input 4.9 (R2 later; MinIO now).

**Scope**

- `storage/ObjectStore` over the S3 API (`@aws-sdk/client-s3`) for R2 and MinIO; `RetentionClass` → key prefix; `applyLifecycleRules()` sets bucket lifecycle rules (`scratch/` expires after 1 day; `working/` after `WORKING_GRACE_DAYS`; `record/` never; `sensitive/` short and server-side encrypted). `objects` table in Postgres for `StoredObject` metadata and per-agent usage.
- Per-agent prefixes (`${class}/${agentId}/`) plus shared prefixes granted as `ResourceFilter.prefixes`; per-agent byte quotas enforced on put.
- Two registered tool servers: `storage` (our bucket, `egress: internal`) and `cdn` (production bucket, `egress: production`, so writes always become approval items in PR 10; `cdn.staging` as the staging alternative with `egress: public`).
- `docker-compose.yml` and CI gain a `minio` service; a `storage:init` script creates buckets and lifecycle rules.

**Acceptance criteria**

- `storage.put` with `class: "scratch"` writes under the agent's prefix and records `expiresAt` 24 hours out; the bucket's lifecycle configuration read back from MinIO contains the four rules.
- An agent cannot read or write another agent's prefix; a shared prefix works once granted; exceeding the quota is denied with `resource_not_allowed` and detail.
- `cdn.objects.write` from an agent is denied with `egress_requires_approval`.

**Tests:** real MinIO (compose, CI service container); lifecycle rules asserted via `GetBucketLifecycleConfiguration`; quota and prefix isolation through the MCP `storage.*` tools with two agent identities.

### PR 9: The `review()` primitive

**Depends on:** PRs 6, 7, 8 (media artifacts and rubric references are read from storage).

**Scope**

- `review/`: `artifacts` and `reviews` tables; `POST /v1/chat` with `artifact.register` stores the output as an `Artifact` with `producedBy` from the serving model and the principal's `runId`. `ReviewService.review()` resolves a route for `reviewerRole` with `excludeFamilies: [artifact.producedBy.family]` and `requireModality: "vision"` for image/video kinds, builds the rubric prompt with references pulled from storage, parses a structured verdict, and stores the `ReviewResult`.
- Structural rules: the caller cannot review an artifact its own agent produced (403 `self_review`); `review()` fails closed when no non-author family is routable; results are immutable.
- Exposed as `POST /v1/review` and the MCP `review` tool. Dashboard: review results shown on artifacts (and later on inbox items).

**Acceptance criteria**

- An artifact produced by family A is reviewed by family B even when A is first in the `reviewer` route; the audit row shows `authorFamily` ≠ `reviewer.family`.
- An image artifact goes to a vision-capable model with the reference image attached; a text-only `reviewer` route yields a clear error, not a text-only review.
- The producing agent calling `review` on its own artifact gets 403; an agent with no role grant for `review` is denied by policy.
- Verdicts other than `pass|fail|revise` from the model are rejected and retried once on the next target.

**Tests:** the OpenAI-compatible stub gains a `review-*` model family that returns a fixed structured verdict, and a `vision-*` model that asserts an image part was sent; three stub servers with distinct families; the reference image is read from real MinIO.

### PR 10: Approval service, inbox API, web inbox

**Depends on:** PRs 5, 9.

**Scope**

- `approvals/`: `approval_items` table; `ApprovalService.request()` (called by the MCP `approval.request` tool and by `executeTool` when policy returns `egress_requires_approval` for a `write`/`delete`), `decide()`/`decideMany()` with `approve`, `edit_approve`, `reject` (reason required), `snooze`; items with a failed required review cannot be approved; `blocks` from the requesting job; expiry sweeper (`expiresAt` default per kind, e.g. 72 hours for `x.reply`) producing `approval.expired` incidents and audit rows.
- Executors: on approval the service re-runs `authorize()` as the `approval-service` principal and executes the action through the tool server, recording `approval.executed` with cost; failures set `failed` with the error and notify.
- Reject reasons are written into the author agent's memory (`memory` tool namespace, key `rejections/<itemId>`).
- Routes: `GET /v1/inbox` (pinned first, then `ApprovalBatch[]` by kind), decision routes. Dashboard: an Inbox page with batch approve per kind, inline edit, reject with reason, snooze, and attached review results.

**Acceptance criteria**

- An agent's `x.replies.draft` followed by `approval.request` yields a pending item with its review attached; approving it executes `x.replies.send` as the approval service and the audit shows both principals.
- Ten `x.reply` items are approved in one batch call; one with a failed review is left pending with a 409 and a reason.
- An item past `expiresAt` is expired by the sweeper, logged, and shows in incidents; a snoozed item reappears at `snoozeUntil`.
- A rejected item's reason is readable by the author agent via `memory.get`.

**Tests:** real Postgres; built-in `x` and `github` tool servers pointed at local real-protocol HTTP servers (the openai-stub pattern) that record what was posted; `core/ux` Inbox tests boot the real API and drive approve/reject through the UI.

### PR 11: Slack channel for approvals and owner notifications

**Depends on:** PR 10; input 4.9 (Slack app).

**Scope**

- `tools/owner-notify`: the one built-in path that may message the owner without an approval item (`egress: private-external`, destination fixed to the owner's Slack user id, callable only by `approval-service`, `orchestrator`, and `owner` principals). Used for new inbox items, incidents, and the brief.
- `approvals/slack`: Block Kit message per item (preview, review verdicts, Approve / Reject / Snooze buttons; a "batch" message per kind when several arrive within a window), `POST /v1/slack/interactions` with signing-secret verification and replay protection, decisions routed through the same `ApprovalService.decide()`, message updated in place after a web or Slack decision so both surfaces agree.
- Slack API access via `fetch` against `SLACK_API_URL` (default `https://slack.com/api`), bot token from the vault.

**Acceptance criteria**

- A new item posts one Slack message; approving from Slack executes the action and the web inbox shows `executed`; approving from the web updates the Slack message.
- An interaction with a bad signature or a stale timestamp is rejected with 401 and audited.
- An agent principal cannot call `owner-notify`.

**Tests:** a local real-protocol Slack server (`core/api/test/slack-stub.ts`): implements `chat.postMessage`/`chat.update`, records calls, and can POST signed interaction payloads back to the gateway; the suite asserts the signature verification path with a real HMAC.

### PR 12: Scheduler with typed routines and missed-run detection

**Depends on:** PRs 1, 5.

**Scope**

- New `@autonomo.us/orchestrator` package and compose service. `routines`, `routine_runs`, `incidents` tables. `nextRun(schedule, from)` for all three types (`croner` for cron with `tz`; `window` expands to in-window instants; `one_off` once). Scheduler loop claims due runs with `FOR UPDATE SKIP LOCKED` (safe with two orchestrator instances), creates a `Job` (PR 13; until then a run record), and advances `nextRunAt`. `one_off` routines move to `completed` after their run and are shown as "completed, will not recur".
- Reconciler loop: any active routine with `nextRunAt + missedGraceMs < now` and no run row for that `scheduledFor` gets a `routine.missed` incident (`critical` for `high` priority, which also triggers `owner-notify` immediately) and `nextRunAt` advances. Pause/resume per routine.
- Gateway routes `GET/POST /v1/routines`, `/pause`, `/resume`, `GET /v1/incidents` read the shared tables. Dashboard: Routines page with type badge, next expected run, last run, and incidents.

**Acceptance criteria**

- A `recurring` routine at `0 6 * * *` in `America/Los_Angeles` has the correct `nextRunAt` across a DST change; a `window` routine of every 120 minutes between 08:00 and 20:00 produces exactly seven runs per day and none at night.
- A `one_off` routine runs once and is `completed`; the UI label is unambiguous.
- With the scheduler stopped and the clock advanced past grace, the reconciler opens exactly one `routine.missed` incident per missed routine and none once the scheduler resumes.
- Two orchestrator instances against one database never double-run a routine.

**Tests:** real Postgres with an injected clock for the scheduler and reconciler; two scheduler instances in one test process competing for the same due runs.

### PR 13: Durable agent records, jobs, heartbeats, restart, and the runtime harness

**Depends on:** PRs 7, 12.

**Scope**

- Full `Agent` record (3.2) replacing the PR 4 minimal table; remit stored and versioned; `jobs` and `heartbeats` tables; `Job` leases and checkpoints.
- Orchestrator `supervisor/`: launches a runtime for each queued job per the agent's `RuntimeBinding` (child process in dev, container in compose via the Docker socket), issues a short-lived gateway identity bound to the `runId`, watches heartbeats, and on a missed heartbeat kills the runtime, revokes the identity, re-leases the job, restarts from the record, and opens an `agent.restarted` incident. Recovery primitives behind routes: `pause`, `resume`, `revoke`, `restart`.
- New `@autonomo.us/agents` with `harness/`: connects to `/mcp` with its identity, loads remit and memory, runs a task loop over `chat`/tools, heartbeats on the binding's interval, checkpoints into the job after each step, and transitions the job to `waiting_review`/`waiting_approval`/`succeeded`/`failed`. Resumes from the checkpoint when started with an existing `jobId`.

**Acceptance criteria**

- Killing a runtime mid-job (SIGKILL in the test) leads to a restart from the record within two heartbeat intervals; the job resumes at its checkpoint and completes; exactly one `agent.restarted` incident is opened.
- A revoked agent's runtime fails its next gateway call with 403 and the job is `cancelled`.
- A runtime cannot act after its job's lease is taken over by another runtime (stale-lease writes are rejected).
- Agent memory and remit survive deleting and recreating the runtime; nothing about the agent lives only in the process.

**Tests:** real orchestrator, gateway, Postgres, and stub provider in one test process with child-process runtimes; heartbeat and lease timing driven by short intervals, not fake timers.

### PR 14: Morning brief

**Depends on:** PRs 10, 11, 12, 13.

**Scope**

- `orchestrator/brief/`: `composeBrief(date)` reading only structured data: `shipped` from `approval.executed` and succeeded jobs, `waitingOnMe` from the inbox sorted by `blocks.length` then age, `decisions` from the `decisions` table, `incidents` open or opened in the window, `spend` from `GET /v1/costs?by=agent` with budget status, `storage` per agent. Rendered as Markdown for Slack and JSON for the web.
- A seeded `recurring` routine `captain.morning-brief` at `0 6 * * *` `America/Los_Angeles`, owned by Captain, whose job calls `composeBrief` and delivers through `owner-notify`. A missed brief is therefore a `routine.missed` incident like any other.
- `GET /v1/brief/:date`; dashboard Brief page.

**Acceptance criteria**

- Given seeded approvals, incidents, decisions, and audit rows, the brief lists each section with correct counts and ordering; items link to the inbox.
- The brief contains no free text produced by a model; a test asserts the composer makes no `chat` calls.
- When Slack delivery fails the brief is still stored and an incident is opened.

**Tests:** real Postgres and ClickHouse seeded through public APIs; real Slack stub for delivery.

### PR 15: Migrate Captain, social engagement, OSS promoter, and the Rustboy QC → chronicle path

**Depends on:** PR 14; inputs 4.9 (GitHub, X credentials, reference material); decision 4.7.

**Scope**

- `core/agents/{captain,social,oss-promoter,film-qc,chronicle}`: remit Markdown, compiled config (role routes, scope grants with quotas, routines, budget), and `entry.ts` over the harness. Seed script `agents:seed` creates the records, grants, routes, and routines idempotently.
- Captain: brief routine (PR 14), a `window` routine every 2 hours 08:00–20:00 Pacific checking the film pipeline state (jobs, incidents) and recording `Decision` records for production calls under its delegation; `read` scopes only plus `owner-notify`-backed draft messages.
- Social engagement: drafts X replies and changelog posts (`x.replies: draft`, `x.posts: draft`, quota per day), every draft registered as an artifact, reviewed by `reviewer`, submitted via `approval.request`.
- OSS promoter: `github.comments: draft` with a repo filter and daily quota; same artifact → review → approval path.
- Rustboy QC → chronicle: `film-qc` (`script` runtime) measures a shot, registers the frame as an `image` artifact, and requests `vision_qc` review against the character sheet from `record` storage; `chronicle` may only open the daily blog PR (`github.prs: draft` → approval) and request a production CDN upload (`cdn.objects: write` → `production` egress → approval) when the QC review passed. Staging uploads go through `cdn.staging` without a gate.
- Built-in `github` and `x` tool servers gain the real executors (REST) for `send`/`write`, used only by the approval service.

**Acceptance criteria**

- End to end in the test environment: the social agent produces a draft, a different family reviews it, the item appears in the web inbox and Slack, approval posts it to the local X-protocol server, and the audit log ties every step to one `runId`.
- A QC frame produced by family A reviewed by family A is impossible (the test asserts the reviewer family differs); a failed vision review blocks chronicle's PR and CDN items with 409.
- A production CDN write never executes without a decision row; a staging write executes without one.
- Quotas from the remits are enforced (the fourth OSS comment draft of the day is denied) and the brief the next morning shows the day's spend per agent.

**Tests:** full-stack test (gateway, orchestrator, four runtimes, Postgres, ClickHouse, MinIO, stub provider servers per family, local GitHub-, X-, and Slack-protocol servers) driven by an injected clock for the routines.

### Dependency graph

```
PR1 db ─► PR2 identity+vault ─► PR3 registry ─► PR4 policy ─► PR5 audit+cost ─► PR6 router ─► PR9 review ─► PR10 approvals ─► PR11 slack ─► PR14 brief ─► PR15 agents
                                                  │                                  ▲                                         ▲
                                                  ├─► PR7 mcp ───────────────────────┤                                         │
                                                  ├─► PR8 storage ───────────────────┘                                         │
PR1 ──────────────────────────────────────────────┴─► PR12 scheduler ─► PR13 agents+jobs ──────────────────────────────────────┘
```

PRs 7, 8, and 12 can be developed in parallel with PRs 5–6; they merge in number order.

## 6. Testing approach

The repository's rule is real services, not mocks, and every PR above keeps it:

- **Databases and stores:** real Postgres, ClickHouse, and MinIO from `docker-compose.yml` locally and as service containers in `.github/workflows/tests.yml` and `release.yaml`. Each suite probes the service and `describe.skipIf`s with a loud warning when it is absent, exactly like `core/api/test/clickhouse-env.ts`. Each suite uses a unique schema, table, or bucket prefix and cleans up in `afterAll`.
- **Model providers:** the existing OpenAI-compatible stub server (`core/api/test/openai-stub.ts`) over the production AI SDK wire path. It grows model names for structured review verdicts and vision assertions, and it is started several times under different server ids to stand in for distinct model families.
- **Third-party APIs:** local HTTP servers that speak the real protocol and record calls (a Slack server with signed interaction callbacks, GitHub and X servers for the executors), in the same style as the provider stub. Signature verification is tested with real HMACs.
- **MCP:** the real `@modelcontextprotocol/sdk` client against the gateway and a real SDK server registered as an external tool server.
- **Time:** injected `now()` for scheduler, reconciler, quota windows, and expiry; short real intervals for heartbeats and leases. No fake timers around service calls.
- **Dashboard:** `core/ux` tests keep booting the real `@autonomo.us/api` on an ephemeral port and drive the UI with Testing Library.
- **Full stack:** PR 15 adds one end-to-end suite in `core/agents/test` that runs gateway, orchestrator, and runtimes in-process against the compose services.
- **Security assertions as tests:** secret plaintext never appears in any response body or log line; `send` never appears in any agent's `tools/list`; no `production` write executes without a decision row; author and reviewer families always differ. These are the exit criteria, so they are tests, not review notes.

## 7. Review rubric for implementation PRs

Each implementation PR is reviewed against every item. A PR is approved only when every item is met or the exception is written in the PR description and accepted by the owner.

**Scope and sequencing**

1. The PR implements exactly the scope of its entry in [section 5](#5-pr-sequence); unrelated changes, refactors, or "while I was here" cleanups are split out.
2. Its stated dependencies are merged; migrations are numbered after the latest on `main`.
3. The PR description lists the acceptance criteria from this plan with evidence (test names, output, screenshots for UX) against each.

**Correctness and structural invariants**

4. Every model and tool call passes `PolicyEngine.authorize()` and produces an audit event; there is no code path to a provider or tool server that bypasses the gateway.
5. `send` is not representable on an agent grant, is absent from every agent's `tools/list`, and is executed only by the `approval-service` principal.
6. `public` and `production` egress always create an approval item; `production` never executes without a decision row.
7. `review()` always selects a family different from the author's and refuses to run otherwise; the author principal cannot review or mark its own artifact.
8. Secret material never leaves the vault module: no route, MCP tool, log line, error message, or test snapshot contains it.
9. Agent identity, remit, memory, scopes, and in-flight job state live in Postgres or object storage, never only in a process.

**Testing**

10. Tests run against real services (Postgres, ClickHouse, MinIO, real-protocol HTTP servers, the real MCP SDK); no module mocks, no fetch mocks, no fake timers around service calls.
11. Suites that need a service probe it and skip loudly when absent; CI provides the service so nothing skips in CI.
12. New behavior has tests for the failure path (service down, timeout, denial, bad signature), not only the happy path.
13. `pnpm lint`, `pnpm build`, and `pnpm test` pass on Node 22 and 24; coverage for new modules is not below the package's current level.

**Operability**

14. Service failures degrade (skip, retry, queue, incident) and never crash the gateway or orchestrator; every outbound request has a timeout.
15. New configuration is in `configFromEnv` (or the orchestrator equivalent), documented in the README table, and seeded in `docker-compose.yml`.
16. Schema changes are forward-only SQL migrations that apply cleanly to a database at the previous `main`; destructive changes ship with a backfill.
17. Every new audit event type carries `runId` when one exists, and cost when money was spent.

**Security and supply chain**

18. New dependencies are pure JS where possible, at least 7 days old (pnpm `minimumReleaseAge`), and justified in the PR description; no change to `allowBuilds` without a stated reason.
19. Workflow changes keep actions SHA-pinned, `permissions: contents: read`, Socket Firewall around installs, and `persist-credentials: false`.
20. Inputs from the network (request bodies, Slack payloads, MCP tool arguments) are schema-validated before use; webhooks verify signatures and reject replays.

**Code quality**

21. Types shared across packages live in `@autonomo.us/common`; package boundaries from [3.1](#31-packages-and-modules) are respected (agents import nothing from `api` or `db`).
22. Biome passes with no new ignores; comments explain intent and constraints, not what the code does.
23. The README and this plan are updated when the PR changes a surface they describe (endpoints, env vars, compose services), and any deviation from this plan is called out in the PR description.

## 8. Exit criteria

The MVP is done when the four migrated agents have run for a sustained period (the design's Phase 1 exit criterion) and the following hold, each backed by a query or test rather than by observation:

- **No outbound action bypassed a gate:** every `approval.executed` audit row has a matching decision row; there are zero `tool.call` rows with `egress IN ('public', 'production')` from an `agent` principal.
- **No self-reviewed artifact reached the owner:** every approval item carries at least one `ReviewResult` whose `reviewer.family` differs from `authorFamily`.
- **No silently missed routine:** every active routine's `nextRunAt` is in the future, and every past `scheduledFor` has a run row in `succeeded`, `failed`, or `missed`, the last two with an incident.
- **Recovery works:** at least one `agent.restarted` incident during the period resolved without manual intervention.
- **Costs are attributable:** the brief's spend section reconciles with provider invoices to within pricing-table error.
