# Budgets, and the Models page's four tabs

*Built after the Video page ([jaredwray/autonomo.us#76](https://github.com/jaredwray/autonomo.us/pull/76)) merged. The Video page and the monthly video budget fold into this.*

## What changed for people

The **Models** page has four tabs: **LLM** (what was the Models tab), **Video** (what was the Video page, now one page with no tabs of its own), **Budget** (new), and **Routing** (unchanged). Each tab opens with its main action: **Add model**, **Add video provider**, **Add budget**. (At first each also had a line on what it is for; people know what the tabs are, so those lines went, and a tab mentions where its settings are kept only when they are temporary.) The **Video** item leaves the sidebar; `#/video`, `#/w/<id>/video`, and `#/w/<id>/video/settings` open the Video tab. A tab stays mounted once shown, so a typed prompt, a half-filled form, and the videos being followed survive a look at another tab.

## Budgets

A budget caps estimated spend over a UTC day or month:

| Field | Values |
| --- | --- |
| `appliesTo` | `{ kind: "everyone" }`: people, API tokens, and agents together. `{ kind: "agents", agentIds }`: the agents named, who **share** the budget. |
| `covers` | `{ kind: "all" }`, `{ kind: "llm" }`, `{ kind: "video" }`, `{ kind: "llm-model", model: "<routable id>" }`, `{ kind: "video-model", model: "<video model id>" }` |
| `limitUsd` | 0 to 1,000,000. Zero refuses everything it covers. |
| `period` | `day` or `month`, in UTC. |
| `enabled` | Off keeps the budget and its spend but limits nothing. |

**Every budget that covers a request must have room for it.** There is no precedence between budgets: a narrower one is simply another cap.

Matching uses the caller telemetry already records: agents are `agent:<id>` (an agent token, an OAuth agent, or a bot the gateway runs), the ids the Agents page lists. People and API tokens match only budgets for everyone.

### Enforcement

- **Language models.** Before each attempt of `POST /chat` (streaming or not), `models_chat`, a bot's reply, and `POST /decisions`, the gateway reads the budgets that cover the caller and model; one whose spend has reached its limit refuses. A refused candidate is passed over like a failed one, so failover moves on; when every candidate is refused the answer is `429 { error: { type: "budget_exceeded", message } }`, before a stream opens. All candidates are checked with one read of the budgets and one of their counters (`llmRefusals`), and each failover target is checked again just before it is tried. A stream announces a skipped model with a `failover` event. When a provider fails and the rest are refused, the error is that provider's, with how many models a budget kept from being tried. After a call, the estimate telemetry computes from models.dev prices is added to every covering budget (`TelemetryService.setSpendListener`), in the background, tried three times. Each charge carries its telemetry event id, and a counter remembers its last 200: a counter that already counted the id fails the update's filter, so a retry after a lost answer, or after a bulk write that reached only some counters, counts each once (a duplicate key on the first try is tried again, to tell a counter another write just created from one that already has the charge). So a retry counts once unless more than 200 other charges reach the same budget while it is being retried. The Worker waits for those writes before releasing the request (`settleBackgroundWork`). A call that starts under budget finishes, so spend can pass a limit by the calls running; models without a list price count as $0. The router's own selector call is counted but not checked.
- **Video.** The estimate is known first, so it is **held** against every covering budget, all or none (each counter is a conditional `$inc`, rolled back if a later budget has no room), before the caller's daily cap. The hold is stored on the job (`VideoHold.budget`) and given back with the rest when the provider bills nothing. A used-up budget, or a $0 one, refuses even a $0 estimate. A model a used-up budget covers is passed over for the next provider in the order; the request is refused with 429 only when budgets refused every candidate. When some were skipped for other reasons (backoff, a problem to fix), the failed job is recorded with each reason in `attempts`.
- **Changing a budget.** An edit is merged into the budget as it is on each retry, so two people changing different fields keep both changes, and only the fields sent are checked. Spend counts from `countsFrom`, part of the counter key: changing who a budget applies to, what it covers, or when it resets starts its spend again from $0; a new limit keeps it. A limit above $0 and under $0.01 is refused rather than rounded to $0.

### Storage

`gateway_budget_policies`: one document per workspace, `{ policies, revision }`, written with a revision check and retried on a lost race. `gateway_budget_usage`: one counter per budget and period, `<workspace>:<budget id>:<YYYY-MM or YYYY-MM-DD>`, in millionths of a dollar, expiring 2 days after a day ends or 400 days after a month ends. Both are cleared with the rest of the gateway's data.

### The video budget becomes a budget

The video policy loses `monthlyBudgetUsd`. A workspace's first read of its budgets **seeds** one: everyone, all video models, monthly, at the workspace's old monthly video budget (default $25), with this month's video spend carried over. The carried spend is counted first, under the new budget's own id, and then the document is inserted with a note of where the spend went (`carried`). If the count fails nothing is saved and the next read seeds again; a seed that loses the insert race leaves a counter nobody reads, so concurrent first reads count the spend once. A video held before budgets existed has no budget part of its own; when it fails unbilled, its estimate comes back from the carried counter, for the month that was carried only. Until then, saving the video policy writes field by field, so the old value survives to seed. `PUT /video/policy` refuses a body that still sends `monthlyBudgetUsd`, saying where it went, rather than dropping it silently. The month's video spend counter stays, without a cap, for the Video tab's "Estimated video spend this month".

### API and permissions

`GET /v1/<ws>/budgets` (each with `usage: { period, spentUsd, resetsAt }`), `POST`, `PATCH /:id`, `DELETE /:id`. Members hold `budgets:read`; admins also `budgets:edit`; API tokens can be given either. Agents named on a budget must exist when added; ones removed later stay listed (the form shows them as removed agents, to uncheck). At most 50 budgets per workspace and 100 agents per budget.

## Video limits

The video policy's daily cap and longest video became policies too, so a workspace can have more than one: **video limits**, on the Video tab under its own card.

- **A limit** applies to everyone or to chosen agents (the same `appliesTo` as a budget, and the same picker in the form), covers every video model or one, and sets **videos a day**, the **longest video** in seconds, or both (`null` leaves one unset; setting neither is refused). It can be switched off.
- **Every limit that covers a video applies**, so the strictest wins: the shortest longest-video, and each limit's own count of the caller's videos today. Counts are per caller id (`user:`, `api-token:`, `agent:`), so "everyone" means each person, token, and agent on their own, and an agents limit counts each picked agent on its own (unlike a budget, which picked agents share).
- **Holds.** Before the provider is called, the hold takes one from each covering limit's counter (`<workspace>:limit:<id>:<caller>:<day>` in `gateway_video_usage`, a conditional `$inc` against the cap), all or none, then the budgets and the month's spend. An unbilled failure gives every one of them back.
- **Passing over.** A used-up limit, like a used-up budget, passes its model over for the next provider in the order; the video is refused with 429 only when budgets or limits refused every candidate, with a message that names the model when the limit covers one ("Your Seedance 2.5 videos for today are used up.", or "A video limit blocks your Seedance 2.5 videos." for 0 a day).
- **What callers see.** `GET /video/models` and `video_models` give the longest video the caller's limits allow on every model, and shorter caps for single models (`modelMaxDurationSeconds`). A request for a longer video than any limit allows is refused with that length; a provider whose model a limit keeps shorter is passed over for the next in the order, and when none is left the refusal says why each was passed over.
- **Seeded.** A workspace's first read of its limits seeds one: everyone, every video model, at its old daily cap and longest video (10 and 10 by default), marked `origin: "video-policy"`. That limit keeps counting on the old per-caller daily counter, so today's videos still count after the change.
- **Storage and API.** `gateway_video_limits`: one document per workspace, `{ limits, revision }`, written with a revision check; an edit is merged into the limit as it is on each retry. `POST /v1/<ws>/video/limits` (201), `PATCH` and `DELETE /video/limits/:id`, all `video:edit`; the limits come back in `GET /video`. At most 50 limits per workspace and 100 agents per limit. `PUT /video/policy` now takes `{ order, revision }` and refuses `callerVideosPerDay` and `maxDurationSeconds`, saying where they went.
- **On the Video tab.** **Provider order** shows once there are two providers; each move up or down saves at once with the revision read, and focus stays on the moved row (on a stale revision the latest order is read again, with a message). **Video limits** lists who, what, videos a day, longest video, and On/Off, Edit, Delete for admins; the form has a sentence that says what the limit will do ("Researcher and Writer can each start up to 2 videos a day (UTC) on Runway Gen-4.5."). Members see both, read-only.

## The Budget tab

- **Add budget**.
- Overview: how many budgets, and how many are used up now.
- A table: who it applies to (agent names; "Shared by N agents"), what it covers, the limit, what is spent as a bar with "$X of $Y" and when it resets (red "Used up" when it is), and On/Off, Edit, Delete for admins. Delete asks to confirm; focus follows between Delete, Confirm, and Cancel.
- The form: **Applies to** (everyone, or specific agents from a searchable checkbox list), **Covers**, the model when one is chosen (chat models only for language models), **Limit (USD)**, and **Resets** every day or month. Below it, one sentence says what the budget will do ("Researcher and Writer can together spend up to $20.00 a day (UTC) on anthropic/claude-opus-4-8."), or what is missing.
- A footnote on how spend is estimated and when it can pass a limit.

## Tests

- `core/server/test/budgets.test.ts`: the store against memory and MongoDB (seeding once under concurrency, stale writes, periods rolling over, all-or-none holds, one of many concurrent holds taking the last of a budget, releases never below zero); the service (validation, removed agents, shared agent budgets, $0 and switched-off budgets, the refusal message); routes and permissions; and `POST /chat` answering 429, streaming or not, once spend reaches the limit.
- `core/server/test/video-*.test.ts`: video holds against budgets and limits, given back on a refusal or an unbilled failure; limits added, changed, and deleted, the strictest applying, and seeded from the old policy; and the refused `monthlyBudgetUsd`, `callerVideosPerDay`, and `maxDurationSeconds`.
- `core/ux/test/Budget.test.tsx`, `Video.test.tsx`, `Routing.test.tsx`: the tabs, the Budget tab and the video limits against a fake and a real gateway, the provider order, and old links.
