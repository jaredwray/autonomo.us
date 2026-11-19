# Workspace organization and decisions

Open **Organization** in a workspace to add positions, assign existing people or agents, and set a lead and accountable human fallback. Use **Reporting** to follow management lines. Select a position and open **Escalations** to trace a decision from that position. The snapshot on an existing case retains the rule version and the original route. A position title confers no permissions.

## Review the Rustboy flow

From a configured development checkout, build the dashboard and start the opt-in fixture.

```sh
pnpm build
pnpm --filter @autonomo.us/server exec node --import tsx scripts/demo-organization.ts
```

The command prints a loopback URL, a deep link to the case, and temporary sign-in details. The fixture uses an isolated, in-memory gateway and synthetic identities. It creates two distinct failures on shot 014, then retries opening the same case. The reporting map places Splice under Captain. The visual-continuity rule routes the question to Iris, then Jared after 30 minutes. Use the map link to start at Splice and switch to Escalations. Start a fresh demo with `--expired` to advance the fixture clock and act as Jared in **Loops → Decisions**.

```sh
pnpm --filter @autonomo.us/server exec node --import tsx scripts/demo-organization.ts --expired
pnpm exec vitest run core/server/test/organization-rustboy.test.ts core/server/test/organization.test.ts core/ux/test/Organization.test.tsx
```

The Rustboy tests exercise approval, a request for changes, and a timeout followed by a late approval. The simulated editor stores distinct check IDs, consumed outcome IDs, and shot state in SQLite. Recording an outcome and resuming the matching shot and revision happen in one transaction. A reconnect fetches the same outcome ID. Shot 015 keeps running throughout. No external renderer or model is called.

## Integration points

| Caller | Entry point | Contract |
| --- | --- | --- |
| Dashboard | `#/w/<workspace>/organization/positions/<id>` and `#/w/<workspace>/loops/decisions/cases/<id>` | Direct links recheck membership and case access. The Pending tab shows the open and triage cases visible to the viewer. |
| Signed-in member | `/v1/<workspace>/organization` | Get `/branch`, `/positions/:id`, `/rules`, `/cases`, or `/cases/:id`. Post to `/preview`, `/cases`, or `/cases/:id/act`. Paginate with the returned `next` as `after`. |
| Workspace admin | Same REST prefix | Search `/identities`, create or patch positions, update `/settings`, and put a versioned rule at `/rules/:key`. Preview a proposed rule before saving it. An archived manager's reports move to its former manager. |
| External or hosted agent | `organization_context`, `organization_lookup`, `organization_open_case`, `organization_list_cases`, `organization_read_case`, `organization_act` | The caller's credentials identify the actor. Specify `requesterPositionId` when the actor holds multiple positions. Read pending assignments or poll requested cases for outcomes. |

External agents use the existing MCP read and call grants. Deciding a case also requires `organization:decide` and current assignment. Hosted instruction agents need tools enabled and the explicit **Decide assigned organization cases** setting to act. An admin can hand off a triage case to an eligible position. Human fallback eligibility is checked again when authority or occupancy changes.

A request supplies a decision key, work ID, work revision, question, and optional evidence. The same immutable request returns the existing case. An action supplies its case ID, the `expectedRevision` that was reviewed, and `approve`, `request_changes`, or `handoff`. A request for changes includes a reason. A stale revision requires rereading the case. The outcome contains its stable ID, deciding actor, reason, source work ID, and revision.

Use `work:<opaque-id>` for references owned by an external system. Resolve content through that system's permissions. Native `channel:<channel-id>:<message-id>` evidence is filtered using current access. On deployments supporting durable agent webhooks and pinned outbound delivery, the `organization` event group emits `decision.assigned` and `decision.outcome` wakeups. Retrieve the case for its current state and apply each outcome ID once.

## Storage and scale

Existing workspaces begin empty. MongoDB creates `workspace_organizations` and `workspace_decision_cases` on use. Each workspace's graph has a revision. Case updates compare the reviewed case revision and fence changes to the routing graph. The persisted pending write is recoverable on standalone MongoDB. Indexed case queries serve the inbox, due work, and pending notifications. In-memory gateways keep their organization only for the process lifetime.

The 1,000-position fixture verifies that the first dashboard branch returns 25 positions and Splice's focused branch returns two. MongoDB projects the selected branch on the server. Search and pagination keep the browser payload bounded. Graph edits serialize per workspace and rewrite its graph document, with a 12 MiB graph cap. The scale test measures the returned page size, not sustained write throughput.
