# Workspace loops

A loop tracks a measurable outcome, opens a decision when enough distinct observations qualify, and follows one work revision through execution and independent verification. Existing workspaces start empty. Choose **Loops → New loop** as a workspace admin to configure the first one.

## Set up a loop

1. Choose an occupied position from the workspace organization as the accountable owner. Define the outcome, metric name, source, percentage target, direction, and how long a measurement stays fresh.
2. In **Workflow**, set the number of qualifying observations on the same work revision and the organization decision key. Configure the assigned action, any intermediate tasks, and an independent verifier. Set an optional action ceiling in USD cents. The organization rule controls the decision reviewer, deadline, and fallback.
3. Use **Test workflow** to preview how distinct observations would trigger a run and where the decision would go. The preview uses the draft and sample events. Publishing assigns a version to future runs. A run keeps the steps and assignees it started with.
4. Connect your source to the observation endpoint on the loop's **Overview**. A first measurement populates the card. The UI identifies stale or missing data, shows the seven-day trend, and links pending requests to the **Decisions** tab.

## Report and inspect measurements

A source system posts to `/v1/{workspace}/loops/{loopId}/observations` with a workspace API token carrying `loops:report`. An agent can submit the same fields through `loops_observe` using its MCP credential. The server records the authenticated reporter. The source name on the card is the label chosen by the workspace admin.

```json
{
  "eventId": "qc:shot-014:r3:first-render",
  "workId": "shot-014",
  "workRevision": "r3",
  "observedAt": "2026-11-19T17:30:00Z",
  "numerator": 0,
  "denominator": 1,
  "trigger": true,
  "evidence": "work:qc/shot-014/r3/first-render"
}
```

This event records one first-render miss and one qualifying observation. A second distinct QC check on that revision can report zero for both counts and `trigger: true`. It contributes to the trigger while preserving the original metric population. A source can also report a batch, such as 18 accepted out of 25 evaluated. Use one stable event ID per upstream record. Replay the same body and credential on retry. A conflicting reuse of an ID returns HTTP 409.

Each UTC day's percentage is 100 times its summed numerator divided by its summed denominator. A completed retry leaves an original first-pass miss in place. Later first renders supply new evidence about whether the change helped. Select **Inspect metric samples** on Overview to see the contributing records, reporter identities, and opaque evidence references. Keep the underlying artifact and its access controls in the source system.

## Integrate an agent

| Agent job | Tool | Additional grant |
| --- | --- | --- |
| Read cards and inspect a loop or a specific run | `loops_list`, `loops_read` | `loops:read` |
| Read contributing samples for a UTC day | `loops_samples` | `loops:read` |
| Send measurements and trigger observations | `loops_observe` | `loops:report` |
| Discover assigned steps and act on them | `loops_assignments`, `loops_run_action` | `loops:act` |
| Review and decide on an assigned organization case | `organization_read_case`, `organization_act` | Existing organization access and `organization:decide` for the decision |

Use the existing MCP discovery and call grants. When assignment webhooks are enabled, subscribe to the **Loops** group for `loop.assigned` wakeups. An agent can also poll `loops_assignments` after reconnecting. A wakeup identifies a step to look up. Current assignment and permissions determine what the agent may do.

The actor claims the step using the run's current revision. Give the returned `executionKey` to the external provider as its idempotency key, and enforce the approved ceiling before submitting paid work. If the response is lost, reread the assignment and reuse the original key. With a provider that lacks idempotent execution, reconcile its existing job before retrying. Complete the action with a `work:` evidence reference and the actual cost when a ceiling applies. The designated verifier then records a pass or failure with its own evidence. The gateway records authorization, claims and results. Rendering, billing and source-system access take place in the integration that performed the work.

## Storage and testing

Configured gateways use MongoDB for loop definitions, observations, runs and pending handoffs. The in-memory backend is for development and lasts for the process lifetime. Workspace decisions use the same durable organization cases and escalation rules as other requests. Legacy decision links open the corresponding case under Loops.

The Rustboy integration test drives two gateways against the same MongoDB. It sends concurrent duplicate events, reviews the resulting decision through MCP, races two claims, records cost and verification evidence, and inspects the next measurement. Run it with the repository's MongoDB test service available.

```sh
pnpm exec vitest run core/server/test/loops-rustboy.integration.test.ts
```
