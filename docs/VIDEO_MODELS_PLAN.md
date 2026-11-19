# Video models plan

*Status: v0.2, 2026-11-19. Built; see [What was built](#what-was-built) for step V0's findings and where the build differs from this plan. In the style of [WEB_PROXIES_PLAN.md](WEB_PROXIES_PLAN.md).*

**Read this first.** Three things I found change the brief:

1. **OpenAI Sora is gone.** OpenAI's docs say the Sora 2 models and the Videos API (`/v1/videos`) were shut down on 2026-09-24 with "no one-to-one replacement". It cannot be one of the three.
2. **Veo is gone from the Gemini API.** Google's deprecations page lists every Veo model there as shut down (the 3.1 previews on 2026-10-22) and names `gemini-omni-1.2-flash` (Gemini Omni Flash, Interactions API) as the replacement. Veo 3.1 is still reachable through Runway.
3. **One gate before the Google adapter is written.** Google's docs do not say whether `background: true` works with Omni video. If it does not, Google cannot fit an asynchronous job model. Step V0 of the checklist tests this, and section 13 (D2) says what to do if it fails. That is the only item that may need the owner.

Provider facts come from the official documentation pages fetched on 2026-11-19 through a summarising fetch tool. I had no API keys, so no real call was made. Each fact is marked **[V]** (read in official docs) or **[U]** (not confirmed; design defensively).

The plan is a server + common + docs change, plus two small permission entries in the dashboard so the new grants can be given. The video settings page is deferred.

## Contents

1. What exists today
2. Goals and non-goals
3. Provider choice
4. Provider API contracts
5. Concept model and job lifecycle
6. Shared types (`@autonomo.us/common`)
7. Server architecture, file by file
8. MCP tools
9. REST API and authorization
10. Configuration and availability
11. Limits, cost, and telemetry
12. Security invariants
13. Decisions
14. Testing
15. Docs
16. Out of scope and follow-ups
17. Implementation checklist

## 1. What exists today

The gateway cannot generate video. The web proxies feature is the same shape, and video copies its structure:

| Piece | Where | What video takes from it |
| --- | --- | --- |
| Tool sets | `McpToolSet` in `core/server/src/mcp/server.ts`; `webToolSet(web)` in `core/server/src/web/mcp.ts`; wired as `toolSets` in `server.ts` | A fifth set, `videoToolSet(video)`, left out when the operator turns video off, exactly as `webTools` is. |
| Per-workspace credentials | `ProxyStore` in `core/server/src/web/store.ts`: memory mode without `MONGODB_URI`, environment connections overlaid on the default workspace only, safe projections (`publicConnection`), `problem` flags | `VideoStore`, same shape, in its own collections. |
| Adapters | `ProxyAdapter` in `web/types.ts`, `PROXY_ADAPTERS` in `web/providers/index.ts`, `FetchLike` injected for tests | `VideoAdapter`, `VIDEO_ADAPTERS`, the same `FetchLike`. |
| Spend caps | `ProxyStore.increment` / `adjust`: a conditional `$inc` so two calls cannot both take the last unit | The same two helpers, copied. The durable reservation ledger is not needed (section 11). |
| Route scopes | `ROUTE_RULES`, `MEMBER_ACTIONS`, `ADMIN_ACTIONS` in `core/server/src/auth/access.ts`; `requireRouteScopes` fails startup for an undeclared `/v1` route | New rules for every video route. |
| Grants | `API_TOKEN_PERMISSIONS` (`common/src/api-tokens.ts`), `AGENT_TOKEN_PERMISSIONS` (`common/src/agent-tokens.ts`), `requireGrant` | `video:read`, `video:edit`, `video:generate` for API tokens; `video:generate` for agents. |
| Errors | `ServiceError` (`service-error.ts`): routes send `{ error: { message } }`, MCP returns `isError` | Unchanged. |
| URL guard | `checkTargetUrl` in `web/url-guard.ts` | Checks an image URL before it is handed to a provider. |
| Telemetry | `TelemetryService.recordWebFetch`, event type `gateway.web` | `recordVideo`, event type `gateway.video`. |
| Clearing data | `GATEWAY_COLLECTIONS` in `gateway-data.ts`; `test/gateway-data.test.ts` scans the source for every `"gateway_*"` literal and fails if one is missing | The four new collections are added. |

Constraints that shape the design:

- **`tools/list` is static.** `mcpRoutes` builds `definitions` once from `toolSets` and announces `listChanged: false`. A tool cannot be listed for one workspace and hidden for another. The convention (`web_fetch`) is: listed whenever the operator has not turned the feature off; the call explains what is missing.
- **An agent token cannot call REST.** `agt_` and `oat_` tokens authenticate `/mcp` only. Whatever an agent gets back must be usable without a gateway credential.
- **No timers on the Worker.** The retained legacy Worker has no work between requests, so jobs are polled lazily, on read.
- **Bots get tools from an allowlist** (`BOT_TOOLS` in `bots/runner.ts`). Video tools are not added, so bots do not get them.

## 2. Goals and non-goals

Goals:

- An agent or a script asks for a video from a prompt, gets a job id at once, and later gets a link to an MP4.
- One request and response shape, whichever provider made the video.
- Workspace admins add provider keys, order them, and cap spend. Keys are handled like proxy keys.
- Jobs belong to a workspace. An agent sees only its own jobs.
- Runs on Node and the Worker, with plain `fetch` and no new dependency.

Non-goals:

- Storing video files. The gateway keeps a job record and a link, never the bytes.
- Editing, extending, reframing, or video-to-video.
- Image generation.
- A dashboard page for video settings (section 16).

## 3. Provider choice

| Rank | Service | Why | API maturity |
| --- | --- | --- | --- |
| 1 | **Google Gemini Omni Flash** (Gemini API, `gemini-omni-1.2-flash`) | Google's current first-party video model and the named successor to Veo. Native audio. Cheapest of the three: about $0.07 a second at 720p. The gateway already has Google users. | GA on the paid tier. The Interactions API is general, not built for video, and its background mode is unconfirmed for Omni (D2). |
| 2 | **Runway API** | The most mature video job API: one task endpoint, clear status and failure codes, a published OpenAPI spec. One key also reaches Runway Gen-4.5, Seedance 2.5, Kling 4.0, Veo 3.1 and others, so it covers most of the field. | High. Version-pinned by header; old versions kept four months. |
| 3 | **Luma (Ray 3.2, Luma Agents API)** | A strong first-party model with the cleanest contract of all: bearer key, one create endpoint, one poll endpoint, typed failure codes. | High, but new (opened June 2026). |

Not chosen:

- **OpenAI Sora.** Shut down (above).
- **Kling (official API).** Top of the quality rankings in the secondary sources I found, but its official docs would not load for verification, and its auth is a signed JWT from two secrets. Kling 4.0 is reachable through Runway (`kling_4`), so it can be added to the Runway catalogue later without a new adapter.
- **fal, Replicate.** Good aggregators. Runway already plays that role here, and a second one adds little. fal is the fallback if the Google gate fails (D2).
- **MiniMax Hailuo, Seedance, WAN.** Reachable through Runway.

Quality rankings came only from vendor and affiliate blogs, so the choice above rests on API quality and availability, which I could read first-hand.

## 4. Provider API contracts

Every adapter keeps its endpoint in one constant and accepts a `baseUrl` override from environment connections only, for tests.

### 4.1 Google Gemini Omni Flash (`kind: "google"`)

| Item | Value | Status |
| --- | --- | --- |
| Base URL | `https://generativelanguage.googleapis.com/v1beta` | [V] |
| Auth | `x-goog-api-key: <key>` header. Never the `?key=` form. | [V] |
| Extra header | `Api-Revision: 2026-05-20` appears in the background-execution examples; the API reference does not mention it. Send it. | [U] |
| Create | `POST /interactions` | [V] |
| Body | `{ "model": "gemini-omni-1.2-flash", "input": "<prompt>", "background": true, "store": true, "response_format": { "type": "video", "aspect_ratio": "16:9", "resolution": "720p", "duration": 5 } }` | Fields [V]. Whether `duration` is a number or `"5s"` is [U]. `background: true` with Omni is [U] (D2). `store: false` with background is a 400 [V]. |
| Limits | Duration 3 to 15 whole seconds, default 10. Aspect `16:9` (default) or `9:16`. Resolution `360p`, `720p` (default), `1080p` and `4k` (both upscaled). No negative prompt, no system instruction. | [V] |
| Create answer | An interaction with `id` and `status`. | [V] that an id returns at once; exact body [U] |
| Poll | `GET /interactions/{id}`. `status`: `in_progress`, `requires_action`, `completed`, `failed`, `cancelled`, `incomplete`, `requires_continuation`. Google's example polls every 5 s. | [V] |
| Result | `steps[]` holds a step with `type: "model_output"` and a `content` array; the video block is `{ "type": "video", "mime_type": "video/mp4", "data": "<base64>" }` or has `uri`. **The GET returns inline base64 even when the job was created with `delivery: "uri"`**; the `uri` is only promised in the create answer or the stream. | [V]; exact nesting of the block [U], so the parser searches every step for an object with `type: "video"` |
| Size | URI delivery is advised for videos "larger than 4MB (>720p)". At 720p and below a video is a few megabytes. | [V] |
| Download by URI | `GET /files/{id}:download?alt=media`, which needs the API key. A provider URL can therefore never be given to an agent. | [V] |
| Cancel | `POST /interactions/{id}/cancel` | [V] |
| Retention | Stored interactions: 55 days on the paid tier (1 day free tier; Omni has no free tier). | [V] |
| Errors | HTTP error body `{ "error": { "code", "message" } }`. A failed interaction has `errors[]` with `code` and `message`. Blocked prompts are refused; no code is documented for it. | Shape [V], codes [U] |
| Price | About $0.023 a second at 360p, $0.07 at 720p, $0.104 at 1080p, $0.209 at 4K. | [V] |
| Image input | A content part `{ "type": "image", "data": "<base64>", "mime_type" }` or a Files API `uri`. Not a public URL. | [V] |

Consequences for the adapter: v1 offers **360p and 720p only**, so the inline result stays small, and reads the poll answer with `readLimited(response, 16 MB)` from `web/providers/read.ts`. Image input is not supported on this provider in v1 (the gateway would have to download the image itself). `requires_action`, `incomplete`, and `requires_continuation` are treated as failed.

### 4.2 Runway (`kind: "runway"`)

| Item | Value | Status |
| --- | --- | --- |
| Base URL | `https://api.dev.runwayml.com` | [V] |
| Auth | `Authorization: Bearer <key>` and `X-Runway-Version: 2024-11-06` | [V] |
| Create (text) | `POST /v1/text_to_video` with `{ "model": "seedance2_5", "promptText": "...", "ratio": "1280:720", "duration": 5 }` | [V] |
| Create (image) | `POST /v1/image_to_video`, the same body plus required `promptImage` (an HTTPS URL string) | [V] |
| Create answer | `{ "id": "<uuid>" }` | [V] for a sibling endpoint in the spec; assumed the same here |
| Models used in v1 | `seedance2_5` (text and image; 4 to 30 s; default 720p `1280:720`), `gen4.5` (text and image; text ratios `1280:720` and `720:1280`) | Model ids and those ratios [V]. `gen4.5` durations [U] (plan assumes 5 and 10). `720:1280` for Seedance [U]. |
| Image URL rules | HTTPS, a domain name (no IP), no redirects, at most 2048 characters, a real `Content-Type` and `Content-Length`, HEAD supported, at most 16 MB, JPEG/PNG/WebP. Runway downloads it itself. | [V] |
| Poll | `GET /v1/tasks/{id}`, at 5 s or more with jitter | [V] |
| Statuses | `PENDING`, `THROTTLED` (stored, not yet queued; treat as pending), `RUNNING`, `SUCCEEDED`, `FAILED`, and cancelled, spelled `CANCELED` in one place and `CANCELLED` in another. Accept both. | [V]; `progress` field [U] |
| Result | `output`: an array of URLs. They "expire within 24-48 hours". | [V] |
| Failure | `failure` (text) and `failureCode`: `SAFETY.INPUT.*` (not retried, credits not refunded), `SAFETY.OUTPUT.*`, `INPUT_PREPROCESSING.SAFETY.TEXT`, `INPUT_PREPROCESSING.INTERNAL`, `INTERNAL.BAD_OUTPUT.*`, `ASSET.INVALID`, `THIRD_PARTY.UNAVAILABLE`, `INTERNAL` or null | [V] |
| Cancel | `DELETE /v1/tasks/{id}`, idempotent; a repeat is a 404 | [V] |
| HTTP errors | 400 (body `{ "error", "docUrl", "issues": [{ "code", "path", "message" }] }`), 401 bad key, 404, 405, 429 (daily generation limit), 502/503/504 load shedding. Tasks over the concurrency limit are queued, not refused. | [V] |
| Price | $0.01 a credit. `seedance2_5` at 720p: 30 credits a second, 80-credit minimum. `gen4.5`: 12 credits a second. | [V] |

Before coding, read `https://docs.dev.runwayml.com/openapi.json` (it is about 900 KB; I could not read past the first part) for the exact `ratio` enums and `duration` rules of the two models and the task schema.

### 4.3 Luma Ray 3.2 (`kind: "luma"`)

| Item | Value | Status |
| --- | --- | --- |
| Base URL | `https://agents.lumalabs.ai` | [V] |
| Auth | `Authorization: Bearer <key>` | [V] |
| Create | `POST /v1/generations` with `{ "model": "ray-3.2", "type": "video", "prompt": "...", "aspect_ratio": "16:9", "video": { "duration": "5s", "resolution": "720p" } }`. Answers 201 with the generation. | Fields [V]; no full video example is published, so the combination is [U] |
| Limits | `prompt` at most 6000 characters. `duration` `5s` or `10s`. `resolution` `360p`, `540p`, `720p`, `1080p`. Many aspect ratios, validated by the server per model. | [V] |
| Image input | `video.start_frame`: `{ "url": "<public image URL>" }` | [V] shape; behaviour [U] |
| Poll | `GET /v1/generations/{id}` every 2 to 3 s | [V] |
| States | `queued`, `processing`, `completed`, `failed` | [V] |
| Result | `output[]` items `{ "type": "video", "url": "<presigned>" }`. The URL lasts 1 hour; **every poll mints a fresh one**. | [V] |
| Failure | `failure_code`: `content_moderated`, `generation_failed`, `budget_exhausted`, `output_not_found`, `image_too_large`, `unsupported_format`, `corrupt_input`, `invalid_request`, `rate_limited`; plus `failure_reason` | [V] |
| Cancel | None documented. | [U] |
| HTTP errors | Body `{ "detail": "..." }`. 422 for invalid parameters. 429 with detail "Rate limit exceeded" or "Too many concurrent jobs". Status codes for a bad key and for no balance are not stated. | Partly [V] |
| Price | Credits: 5 s costs 20 / 50 / 100 / 400 at 360p / 540p / 720p / 1080p; 10 s costs 60 / 150 / 300 / 1200. The dollar value of a credit depends on the plan. `usage.credits_charged` appears once billing settles. | [V]; dollars per credit [U] |
| Retention | Output files are kept "long enough to serve presigned URLs"; no number given. | [U] |

## 5. Concept model and job lifecycle

| Concept | What it is |
| --- | --- |
| **Video connection** | A named, per-workspace connection to one provider: kind, key, on/off, optional default model. Stored and projected like a proxy connection. |
| **Video policy** | Per workspace: the order connections are tried in, videos per caller per day, a monthly dollar budget, and the longest video allowed. |
| **Job** | One request for one video. It has the gateway's own id (`vid_<uuid>`), never the provider's. |
| **Download link** | A gateway URL holding an unguessable token for one finished video. |

**Lifecycle.** `queued` → `running` → `succeeded` | `failed` | `canceled`; a succeeded job becomes `expired` when the provider no longer has the video.

1. **Create** checks the request, picks candidates (below), holds the estimated cost against the caps, writes the job record, then calls the provider. The record is written first so a crash cannot leave a paid job nobody knows about. The provider's id is saved on the record when it answers. The call returns the job at once (HTTP 202).
2. **Read** returns the stored job. If it is not finished and was last polled 5 s or more ago (`VIDEO_LIMITS.pollIntervalMs`), the gateway polls the provider first and saves the answer. A finished job is never polled again. There is no background poller, so this works the same on Node and the Worker. A job nobody reads stays `running` in the record until its record expires; its hold stays counted, which reads high, never low.
3. **Wait.** A read may pass `waitSeconds` (0 to 60, default 0). The gateway then polls every 5 s until the job finishes, the time is up, or the client hangs up. This saves an agent a string of calls.
4. **Finish.** The move to a finished state is one conditional update (`status` still unfinished), so two readers cannot both apply it. The reader that wins releases the hold if the provider billed nothing and records telemetry.
5. **Cancel** asks the provider where it can (Google, Runway) and marks the job `canceled`. Luma has no cancel: the job is marked `canceled` here, the hold stays, and the result is discarded.
6. **Records expire** 30 days after creation (a TTL index).

A job whose record has no provider id two minutes after creation never started (the process died mid-create): the next read marks it `failed` and releases the hold.

**How the video is returned (D3).** The gateway never stores video bytes. Every finished job carries one link, `video.url`, of the form `<gateway origin>/video/downloads/<token>`:

- For Runway and Luma the link answers **302** to the provider's presigned URL. For Luma the gateway polls again first when the saved URL is within five minutes of expiring, so the link keeps working after Luma's one hour. No bytes pass through the gateway.
- For Google the link **streams** the MP4: the gateway fetches the interaction with its key, decodes the inline video, and sends it. These are a few megabytes at 720p.

Why not hand out provider URLs directly: Google has none that work without the key; Luma's die after an hour; and an agent cannot call an authenticated gateway route. One link form that always works is simpler to explain than three.

**Provider selection (D4).** Consistent with the ladder: the admin orders connections; the first usable one is the default; a failure that billed nothing moves on to the next.

1. Take the workspace's connections that are on and have a key, in `policy.order`, then the rest in the order `VideoStore.entries` returns them. Skip one whose `problem` is younger than 15 minutes, as the ladder does.
2. If the request names `provider` (a connection name), keep only that one.
3. If it names `model`, keep connections whose kind offers it. Otherwise each uses its `defaultModel`, or `DEFAULT_VIDEO_MODEL[kind]`.
4. Drop candidates whose model cannot do what was asked (image input, duration, aspect ratio, resolution). If the caller pinned a provider or model, that is a 400 naming the allowed values. If nothing is left, a 400 says why for each.
5. Try candidates in order. Move to the next **only** on `provider-error` (refused key, no credits, rate limit, 5xx, unreachable), where nothing was accepted. Stop on `refused` (moderation: the same prompt is not shopped to another provider), on `invalid`, and on a create call that timed out (the provider may have accepted it; trying another could pay twice).
6. Never fail over once a provider accepted the job.

Unlike `web_fetch`, an agent may name a provider and model. Models differ in look, length, and price, which is a legitimate choice for the caller; the caps bound what it can cost.

## 6. Shared types (`@autonomo.us/common`)

New file `core/common/src/video.ts`, exported from `core/common/src/index.ts` in the same alphabetical block style as `./web.js`.

```ts
export const VIDEO_KINDS = ["google", "runway", "luma"] as const;
export type VideoKind = (typeof VIDEO_KINDS)[number];
export const VIDEO_KIND_LABELS: Record<VideoKind, string> = {
	google: "Google Gemini Omni",
	runway: "Runway",
	luma: "Luma Ray",
};

export const VIDEO_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;
export const VIDEO_ASPECT_RATIOS = ["16:9", "9:16", "1:1"] as const;
export type VideoAspectRatio = (typeof VIDEO_ASPECT_RATIOS)[number];
export const VIDEO_RESOLUTIONS = ["360p", "540p", "720p", "1080p"] as const;
export type VideoResolution = (typeof VIDEO_RESOLUTIONS)[number];

export const VIDEO_LIMITS = {
	connections: 10,
	promptLength: 4000,
	urlLength: 2048,
	minDurationSeconds: 3,
	maxDurationSeconds: 30,
	maxWaitSeconds: 60,
	defaultListLimit: 20,
	maxListLimit: 100,
	maxCallerVideosPerDay: 10_000,
	maxMonthlyBudgetUsd: 100_000,
	keyLength: 4096,
	jobRetentionDays: 30,
	pollIntervalMs: 5000,
} as const;

/** What one model can make. Prices stay on the server. */
export type VideoModel = {
	id: string; // the provider's own id
	label: string;
	inputs: ReadonlyArray<"text" | "image">;
	/** Whole seconds: a range, or the only values allowed. */
	durations: { min: number; max: number } | readonly number[];
	aspectRatios: readonly VideoAspectRatio[];
	resolutions: readonly VideoResolution[];
	defaults: {
		durationSeconds: number;
		aspectRatio: VideoAspectRatio;
		resolution: VideoResolution;
	};
	audio: boolean;
};

export const VIDEO_MODELS: Record<VideoKind, readonly VideoModel[]>;
export const DEFAULT_VIDEO_MODEL: Record<VideoKind, string>;
export function videoModel(kind: VideoKind, id: string): VideoModel | undefined;
/** Why a model cannot make this, or null. */
export function videoModelProblem(model: VideoModel, want: {
	durationSeconds: number; aspectRatio: VideoAspectRatio;
	resolution: VideoResolution; image: boolean;
}): string | null;
```

v1 catalogue (confirm the [U] rows in section 4 before shipping):

| Kind | Model | Inputs | Durations | Aspect | Resolutions | Defaults |
| --- | --- | --- | --- | --- | --- | --- |
| google | `gemini-omni-1.2-flash` (default) | text | 3–15 | 16:9, 9:16 | 360p, 720p | 5 s, 16:9, 720p |
| runway | `seedance2_5` (default) | text, image | 4–30 | 16:9, 9:16 | 720p | 5 s, 16:9, 720p |
| runway | `gen4.5` | text, image | 5, 10 | 16:9, 9:16 | 720p | 5 s, 16:9, 720p |
| luma | `ray-3.2` (default) | text, image | 5, 10 | 16:9, 9:16, 1:1 | 360p, 540p, 720p, 1080p | 5 s, 16:9, 720p |

```ts
export type VideoPolicy = {
	/** Connection names, first tried first. Ones not listed follow in the order added. */
	order: string[];
	/** Videos one person, token, or agent may start in a UTC day. */
	callerVideosPerDay: number;
	/** What every video together may cost in a calendar month (UTC), estimated, in US dollars. */
	monthlyBudgetUsd: number;
	/** The longest video anyone may ask for, in seconds. */
	maxDurationSeconds: number;
	revision: number;
};
export const DEFAULT_VIDEO_POLICY: Omit<VideoPolicy, "revision"> = {
	order: [], callerVideosPerDay: 10, monthlyBudgetUsd: 25, maxDurationSeconds: 10,
};
export type UpdateVideoPolicyRequest = Omit<VideoPolicy, "revision"> & { revision: number };

export type VideoProblem = { kind: "key" | "credits"; detail: string; at: string };

/** A connection as the API shows it. Never the key. */
export type VideoConnection = {
	name: string;
	kind: VideoKind;
	keyConfigured: boolean;
	enabled: boolean;
	defaultModel?: string;
	/** Luma only: what one credit costs on your plan, in US dollars. */
	creditPriceUsd?: number;
	source: "saved" | "environment";
	usage: { month: string; videos: number; costUsd: number };
	problem: VideoProblem | null;
};
export type CreateVideoConnectionRequest = {
	name: string; kind: VideoKind; apiKey: string;
	enabled?: boolean; defaultModel?: string; creditPriceUsd?: number;
};
export type UpdateVideoConnectionRequest =
	Partial<Omit<CreateVideoConnectionRequest, "name" | "kind">>;

export type VideoSettings = {
	/** False when the operator turned video off (`VIDEO_DISABLED`). */
	available: boolean;
	/** True when this workspace has a connection that can be used now. */
	configured: boolean;
	connections: VideoConnection[];
	policy: VideoPolicy;
	budget: { month: string; spentUsd: number; limitUsd: number };
	persistence: "mongodb" | "memory";
};

export type VideoGenerateRequest = {
	prompt: string;
	/** A connection name. Omitted: the workspace's first usable one. */
	provider?: string;
	model?: string;
	durationSeconds?: number;
	aspectRatio?: VideoAspectRatio;
	resolution?: VideoResolution;
	/** An https image to start from, for models that take one. */
	imageUrl?: string;
};

export const VIDEO_JOB_STATUSES =
	["queued", "running", "succeeded", "failed", "canceled", "expired"] as const;
export type VideoJobStatus = (typeof VIDEO_JOB_STATUSES)[number];
export const videoJobFinished = (status: VideoJobStatus) =>
	status !== "queued" && status !== "running";

export type VideoJobErrorCode =
	| "moderated" | "invalid_input" | "provider_error" | "timeout" | "not_started";

export type VideoAttempt = {
	provider: string; // connection name
	model: string;
	outcome: "accepted" | "provider-error" | "refused" | "invalid" | "timeout" | "skipped";
	/** Short, and never a key or a provider URL. */
	detail?: string;
};

export type VideoJob = {
	id: string; // vid_<uuid>
	status: VideoJobStatus;
	/** 0 to 100 where the provider says; otherwise null. */
	progress: number | null;
	provider: string; // connection name
	kind: VideoKind;
	model: string;
	prompt: string;
	durationSeconds: number;
	aspectRatio: VideoAspectRatio;
	resolution: VideoResolution;
	hasImage: boolean;
	createdBy: TelemetryCaller;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	/** An estimate from list prices, held against the budget. */
	costUsd: number;
	/** Set when succeeded. */
	video: { url: string; contentType: "video/mp4"; expiresAt: string } | null;
	/** Set when failed. */
	error: { code: VideoJobErrorCode; message: string } | null;
	/** What was tried to start it. */
	attempts: VideoAttempt[];
};
export type VideoJobList = { jobs: VideoJob[]; nextBefore: string | null };

/** What `video_models` returns. */
export type VideoModelList = {
	available: boolean;
	/** Why not, in words an agent can pass on. */
	reason?: string;
	canGenerate: boolean;
	providers: Array<{
		name: string; kind: VideoKind; defaultModel: string; models: VideoModel[];
	}>;
	limits: { maxDurationSeconds: number; promptLength: number };
};
```

Grants (existing files):

- `core/common/src/api-tokens.ts`: add `"video:read": "Video: Read"`, `"video:edit": "Video: Edit"`, `"video:generate": "Video: Generate"` to `API_TOKEN_PERMISSIONS`. `DEFAULT_API_TOKEN_PERMISSIONS` is unchanged.
- `core/common/src/agent-tokens.ts`: add `"video:generate": "Video: Generate"` to `AGENT_TOKEN_PERMISSIONS` and one sentence to the comment above it: "`video:generate` lets an agent start videos on the workspace's video providers, within the workspace's limits."

## 7. Server architecture, file by file

### New files

**`core/server/src/video/types.ts`** (mirrors `web/types.ts`; import `FetchLike` from `../web/types.js`)

```ts
/** A connection as the server holds it, key included. Never sent to a client. */
export type VideoConfig = {
	name: string; kind: VideoKind; apiKey?: string; enabled: boolean;
	defaultModel?: string; creditPriceUsd?: number;
	/** Environment connections only: another endpoint, for tests. */
	baseUrl?: string;
};

export type VideoCall = {
	model: string; prompt: string; durationSeconds: number;
	aspectRatio: VideoAspectRatio; resolution: VideoResolution;
	imageUrl?: string; signal: AbortSignal;
};

/** A call that did not go through. */
export type VideoFailure = {
	outcome: "provider-error" | "refused" | "invalid" | "timeout";
	/** Short and safe to show: never a key or a provider URL. */
	detail: string;
	/** False when the provider charged nothing. */
	billed: boolean;
	problem?: "key" | "credits";
	retryAfterMs?: number;
};
export type VideoCreateResult =
	| { outcome: "accepted"; providerJobId: string; status: "queued" | "running" }
	| VideoFailure;

export type VideoPollResult =
	| { state: "queued" | "running"; progress: number | null }
	| { state: "succeeded";
	    /** `url`: a provider link people can fetch. `bytes`: only `content()` can get it. */
	    delivery: { kind: "url"; url: string; expiresAt: number } | { kind: "bytes" };
	    costUsd?: number }
	| { state: "failed"; code: VideoJobErrorCode; detail: string; billed: boolean }
	| { state: "canceled" }
	| { state: "gone" } // the provider no longer has it
	| { state: "unknown"; detail: string; retryAfterMs?: number; problem?: "key" | "credits" };

export interface VideoAdapter {
	readonly kind: VideoKind;
	/** How long a finished video can be fetched, counted from completion. */
	readonly resultTtlMs: number;
	/** A list-price estimate, held against the budget before the call. */
	estimateCostUsd(config: VideoConfig, call: Omit<VideoCall, "signal">): number;
	create(config: VideoConfig, call: VideoCall, fetchImpl: FetchLike): Promise<VideoCreateResult>;
	poll(config: VideoConfig, providerJobId: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<VideoPollResult>;
	/** Absent where the provider has no cancel. Never throws. */
	cancel?(config: VideoConfig, providerJobId: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<void>;
	/** Only for `bytes` delivery. */
	content?(config: VideoConfig, providerJobId: string, signal: AbortSignal, fetchImpl: FetchLike): Promise<{ bytes: Uint8Array; contentType: string } | null>;
}
```

**`core/server/src/video/providers/index.ts`**: `VIDEO_ADAPTERS: Record<VideoKind, VideoAdapter>` and re-exports, like `web/providers/index.ts`.

**`core/server/src/video/providers/shared.ts`**: helpers every adapter uses.

- `failure(label, outcome, detail, extra)`: builds a `VideoFailure` with the provider's label prefixed, as `brightdata.ts` does.
- `retryAfterMs(response)`: copy from `brightdata.ts`.
- `providerMessage(text, apiKey)`: takes a provider's error text, cuts it to 300 characters, replaces any occurrence of the key with `[key]`, and strips URLs. Every provider message goes through it.
- `httpFailure(label, response, body, apiKey)`: the common mapping: 401/403 → `provider-error` with `problem: "key"`; 402 → `provider-error` with `problem: "credits"`; 429 → `provider-error` with `retryAfterMs`; 400/422 → `invalid` with the provider's message; anything else → `provider-error`. All `billed: false`.
- Network error → `provider-error`, or `timeout` when `signal.aborted`.

**`core/server/src/video/providers/google.ts`, `runway.ts`, `luma.ts`**: one adapter each, per section 4. Notes:

- All three read bodies with `readLimited` (1 MB for everything except Google's poll and content, 16 MB).
- Status maps:
  - Google: `in_progress` → running; `completed` → succeeded with `{ kind: "bytes" }` (or `{ kind: "url" }` is never used for Google); `failed` → failed (`moderated` when a code or message says blocked or safety, else `provider_error`); `cancelled` → canceled; the other three → failed `provider_error`; HTTP 404 → gone. A `completed` interaction with no video block is failed `provider_error`.
  - Runway: `PENDING`, `THROTTLED` → queued; `RUNNING` → running (`progress` × 100 when it is a number between 0 and 1); `SUCCEEDED` → url delivery with `output[0]`, `expiresAt` = now + 24 h; `FAILED` → by `failureCode`: `SAFETY.*` and `INPUT_PREPROCESSING.SAFETY.*` → `moderated`, billed; `ASSET.INVALID` → `invalid_input`, not billed; everything else → `provider_error`, not billed; `CANCELED` / `CANCELLED` → canceled; HTTP 404 → gone.
  - Luma: `queued` → queued; `processing` → running; `completed` → url delivery with the first `output` item whose `type` is `video`, `expiresAt` = now + 55 min; `failed` → `content_moderated` → `moderated`; `image_too_large`, `unsupported_format`, `corrupt_input`, `invalid_request` → `invalid_input`; `output_not_found` → gone; `budget_exhausted` → `provider_error` and `problem: "credits"`; others → `provider_error`. All not billed except `moderated` ([U]: treat as billed).
- A provider URL returned for delivery must be `https:` and pass `checkTargetUrl`; otherwise the poll result is failed `provider_error`.
- `resultTtlMs`: Google 30 days (the job record's own life), Runway 24 h, Luma 7 days ([U]; a `gone` poll ends it sooner).
- `estimateCostUsd`: Google `{ "360p": 0.023, "720p": 0.07 }` × seconds. Runway: `seedance2_5` `max(0.30 × seconds, 0.80)`, `gen4.5` `0.12 × seconds`. Luma: the credit table in 4.3 × `config.creditPriceUsd ?? 0.01`. An unknown model or resolution uses $0.50 a second so a gap in the table cannot slip under the budget.
- Runway aspect and resolution become `ratio`: `16:9` → `1280:720`, `9:16` → `720:1280`.
- Luma duration becomes `"5s"` / `"10s"`.

**`core/server/src/video/store.ts`**: `VideoStore`, modelled closely on `ProxyStore`.

- Constructor `(envConnections: VideoConfig[], mongo?: string | MongoConnection, now = () => new Date())`.
- Collections: `gateway_video_connections` (`_id` = `<workspaceId>:<name>`, `{ workspaceId, config, problem }`), `gateway_video_policy` (`_id` = workspace id, `{ policy, revision }`), `gateway_video_usage` (counters with `expiresAt`).
- Methods, same meaning as their `ProxyStore` namesakes: `persistence`, `ensureIndexes`, `entries(workspace)`, `list(workspace)`, `create`, `update`, `remove`, `setProblem`, `policy`, `updatePolicy` (revision compare-and-set, 409 when stale; names in `order` must exist), `budget`, `close`.
- Validation in `validate(config)`: name pattern, kind, key present and within `VIDEO_LIMITS.keyLength`, `defaultModel` in `VIDEO_MODELS[kind]`, `creditPriceUsd` only for Luma and between 0 and 10, at most `VIDEO_LIMITS.connections`.
- Environment connections are read-only and belong to the default workspace, with the same refusal text pattern as `ProxyStore.update`.
- Removing a connection takes it out of `policy.order`.
- Spend: copy `increment` and `adjust`. `hold(workspace, { connection, callerId, callerCap, budgetUsd, costUsd })` takes, in order, the monthly budget counter (`<ws>:budget:<YYYY-MM>`), the caller's day counter (`<ws>:caller:<callerId>:<YYYY-MM-DD>`), and the connection's month counter (no cap, for the usage shown), undoing what it took if a later one refuses. It returns `{ keys, costMicros }` or `{ refused: "budget" | "caller" }`. `release(hold)` gives all three back. Use `usagePeriods` and `toMicros` from `web/store.ts` (both are exported).
- The first read of a policy for a workspace returns `DEFAULT_VIDEO_POLICY` with `revision: 0` and writes nothing.

**`core/server/src/video/jobs.ts`**: `VideoJobStore`, one class with a memory mode, in the shape of `BotWebRequestStore` (`bots/web-requests.ts`).

- Collection `gateway_video_jobs`, `_id` = job id. The stored record is `VideoJob` minus `video`, plus: `workspaceId`, `providerJobId: string | null`, `delivery: { kind: "url"; url; expiresAt } | { kind: "bytes" } | null`, `resultExpiresAt: Date | null`, `downloadToken`, `hold: { keys, costMicros } | null`, `settled: boolean`, `lastPolledAt: Date | null`, `expiresAt: Date`.
- Indexes: `{ workspaceId: 1, createdAt: -1 }`, `{ workspaceId: 1, "createdBy.id": 1, createdAt: -1 }`, `{ downloadToken: 1 }` unique, `{ expiresAt: 1 }` with `expireAfterSeconds: 0`.
- Methods: `insert(record)`, `get(workspaceId, id)`, `byToken(token)`, `list(workspaceId, { createdById?, before?, limit })`, `started(id, providerJobId, status)`, `polled(id, patch)` (only while unfinished), `finish(id, patch)` (conditional on unfinished; returns whether this caller won), `settle(id)` (flips `settled` false → true; returns whether this caller won), `refreshDelivery(id, delivery)`, `markExpired(id)`, `ensureIndexes`, `close`.
- Every query compares with `$eq`, and every lookup by id also filters `workspaceId`. Memory mode drops records past `expiresAt` on read.

**`core/server/src/video/service.ts`**: `VideoService`.

```ts
export type VideoCaller = TelemetryCaller;
export type VideoContext = {
	/** The gateway's address, for download links. */
	origin: string;
	signal?: AbortSignal;
	/** Epoch milliseconds; a wait stops here. */
	deadline?: number;
};
export type VideoServiceOptions = {
	store: VideoStore; jobs: VideoJobStore;
	fetchImpl?: FetchLike;
	adapters?: Partial<Record<VideoKind, VideoAdapter>>;
	telemetry?: Pick<TelemetryService, "recordVideo">;
	/** `VIDEO_DISABLED`. */
	disabled?: boolean;
	now?: () => number;
	/** For tests: how a wait sleeps. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};
```

- `get available()`; `refuseWhenDisabled()` throws `ServiceError("Video generation is turned off on this gateway.", 503)`.
- `models(workspace, canGenerate)` → `VideoModelList`. With no usable connection: `available: false`, `reason: "This workspace has no video provider. A workspace admin can add one."`.
- `generate(workspace, caller, request, context)` → `VideoJob`. Steps: validate (below); read policy; build candidates (section 5); for each candidate: hold, insert the record (first candidate only; later candidates update `provider`, `kind`, `model`, `costUsd`, `hold`), call `adapter.create` under a 30 s signal, then on `accepted` call `jobs.started` and return; on a failure release the hold unless the outcome is `timeout`, record the attempt, set or clear the connection's `problem` and backoff as `WebService.runStep` does, and move on or stop by the rules in section 5. When nothing accepted, the record is finished as `failed` with the last detail and returned (so the attempt is visible), except a pure validation failure, which throws a 400 and writes nothing. With no usable connection it throws `ServiceError("Video generation is not set up in this workspace. A workspace admin can add a video provider.", 409)`. A refused hold throws 429 with "the workspace's monthly video budget is used up" or "your videos for today are used up".
- `status(workspace, viewer, id, { waitSeconds }, context)` → `VideoJob`. `viewer` is `{ ownOnly?: string }`: when set, a job whose `createdBy.id` differs is a 404, the same answer as a job that does not exist.
- `cancel(workspace, viewer, id, context)` → `VideoJob`. A finished job is returned unchanged.
- `list(workspace, viewer, { before?, limit? })` → `VideoJobList`.
- `download(token, signal)` → `{ kind: "redirect"; url } | { kind: "bytes"; bytes; contentType } | { kind: "gone" } | null`.
- Private `refresh(record)` implements read step 2 and finish step 4. Poll calls get a 20 s signal (60 s for `content`). A poll answer of `unknown` changes nothing but `lastPolledAt` and the connection's problem; the job is returned as stored. The connection's config is looked up by name at poll time; if the connection was deleted, the job is returned as stored with no poll, and after its record expires it is gone.
- Private `view(record, origin)` builds the public `VideoJob`; `video` is set only when `succeeded`, with `url: ${origin}/video/downloads/${record.downloadToken}` and `expiresAt` = `resultExpiresAt`. A succeeded record past `resultExpiresAt` is marked and shown as `expired`.
- Validation: `prompt` trimmed, 1 to `VIDEO_LIMITS.promptLength`; `durationSeconds` a whole number within `VIDEO_LIMITS` and at most `policy.maxDurationSeconds`; `imageUrl` passes `checkTargetUrl`, must be `https:`, and at most `VIDEO_LIMITS.urlLength`.
- Ids: `vid_${randomUUID()}`. Tokens: `randomBytes(32).toString("base64url")` from `node:crypto`.

**`core/server/src/video/mcp.ts`**: `VIDEO_MCP_INSTRUCTIONS`, `VIDEO_MCP_TOOLS`, `videoJobText(job)`, `videoModelsText(list)`, `videoToolSet(video)`. Section 8.

**`core/server/src/routes/video.ts`**: `videoRoutes` (under `/v1/:workspace`) and `videoDownloadRoutes` (outside `/v1`). Section 9. Copy the `onRequest` no-store hook, the error handler (log label "Video request failed", fallback text "Video hit an unexpected error."), `caller(request)`, and `closeSignal(reply)` from `routes/web.ts`.

### Modified files

| File | Change |
| --- | --- |
| `core/common/src/index.ts` | Export everything from `./video.js`. |
| `core/common/src/api-tokens.ts`, `agent-tokens.ts` | The grants in section 6. |
| `core/server/src/config.ts` | `VideoConfig` import; `ApiConfig.video?: { disabled: boolean; connections: VideoConfig[] }`; environment parsing (section 10); extend the doc comment. |
| `core/server/src/server.ts` | `CreateServerOptions.videoFetch?: FetchLike` ("How video provider APIs are called, for tests."). Build `videoStore = new VideoStore(config.video?.connections ?? [], mongo)`, `videoJobs = new VideoJobStore(mongo)`, `video = new VideoService({ store, jobs, telemetry, disabled, fetchImpl })`. `const videoTools = video.available ? videoToolSet(video) : undefined;` and `...(videoTools ? [videoTools] : [])` at the end of `toolSets`. Register `videoRoutes` inside the `/v1/:workspace` scope with `{ store: videoStore, video, origin }`, and `videoDownloadRoutes` beside `oauthRoutes` with `{ video }`. Add both stores' `ensureIndexes()` to `initialize` and `close()` to `closeAll`. |
| `core/server/src/mcp/server.ts` | `McpCallContext.origin?: string` ("The address the request reached the gateway at."), set in the `dispatch` call: `{ signal: closed.signal, origin: options.origin(request) }`. |
| `core/server/src/auth/access.ts` | Route rules and actions (section 9). |
| `core/server/src/telemetry/telemetry.ts` | `VideoTelemetry` type and `recordVideo` (section 11). |
| `core/server/src/gateway-data.ts` | Add `gateway_video_connections`, `gateway_video_policy`, `gateway_video_usage`, `gateway_video_jobs` to `GATEWAY_COLLECTIONS`. |
| `core/server/src/index.ts` | Export the new public pieces if the web ones are exported there (follow what it does for `web`). |
| `core/ux/src/ApiTokensView.tsx` | One `permissionGroups` entry `{ resource: "video", label: "Video", choices: ["video:read", "video:edit"] }`, one `{ resource: "video-generate", label: "Video generation", choices: ["video:generate"] }`, and a sentence in `permissionHint`: "Video: Edit changes video provider keys and limits. Video: Generate starts videos on the workspace's providers, within its limits." |
| `core/ux/src/AgentMcp.tsx` | One `permissionGroups` entry `{ resource: "video", label: "Video", choices: ["video:generate"], hint: "Lets this agent start videos with video_generate on the workspace's video providers, within the workspace's daily and monthly limits." }`. |
| `docker-compose.yml` | Pass the new variables through, next to the `ZENROWS_*` lines. |
| `README.md` | Section 15. |

Without the two dashboard entries nobody could grant the new permissions except through the REST API, so they are part of this change. Nothing else in `core/ux` changes.

## 8. MCP tools

A new tool set served on `POST /mcp`. `tools/list` shows the tools to every agent unless `VIDEO_DISABLED` is set, in which case the set is not registered. Calls need `mcp:call`; all but `video_models` also need `video:generate` (`requireGrant(agent, "video:generate")`).

`VIDEO_MCP_INSTRUCTIONS`: "video_generate starts a video from a prompt on the workspace's video providers and returns a job id at once; a video takes from half a minute to several minutes. video_status says how the job is going and, when it is done, gives a link to the MP4. video_models lists what this workspace can make. Videos cost the workspace money, so make one only when asked to."

| Tool | Input (`schema(...)`) | Returns |
| --- | --- | --- |
| `video_models` | none | `VideoModelList` |
| `video_generate` | `prompt` (string, 1–4000, required); `provider` (string, ≤64); `model` (string, ≤100); `durationSeconds` (integer, 3–30); `aspectRatio` (enum `16:9`, `9:16`, `1:1`); `resolution` (enum `360p`, `540p`, `720p`, `1080p`); `imageUrl` (string, ≤2048) | `VideoJob` |
| `video_status` | `id` (string, pattern `^vid_[0-9a-f-]{36}$`, required); `waitSeconds` (integer, 0–60) | `VideoJob` |
| `video_cancel` | `id` (as above, required) | `VideoJob` |
| `video_list` | `limit` (integer, 1–20) | `VideoJobList`, the agent's own jobs, newest first |

Descriptions follow the existing voice, for example `video_generate`: "Starts one video from a prompt and returns its job at once. Check it with video_status. Leave provider and model out to use the workspace's default. Needs the video:generate grant."

Handlers:

- The caller is `{ id: \`agent:${agent.token.id}\`, name: agent.token.name, kind: "agent" }`, as in `web/mcp.ts`.
- The viewer is `{ ownOnly: \`agent:${agent.token.id}\` }` for status, cancel, and list. An agent can never read another agent's job, nor one a person made.
- `origin` comes from `context?.origin`. Without one (an in-process caller) the handler throws `ServiceError("Video tools need the gateway's address.", 500)`; no such caller exists in this change.
- `video_status` passes `deadline: context?.deadline ?? Date.now() + 90_000` and `context.signal`.
- `video_models` passes `agent.token.permissions.includes("video:generate")` as `canGenerate`, as `models_list` reports `canChat`.

Text forms (`text:` on the set):

```
Video vid_3f… is running (40%) on runway (seedance2_5): 5 s, 720p, 16:9. Estimated cost $1.50. Check again with video_status; pass waitSeconds to wait.
Video vid_3f… is ready: https://gateway.example.com/video/downloads/… (MP4, 5 s, 720p, 16:9, made by runway seedance2_5). The link works until 2026-11-20T14:05Z. Estimated cost $1.50.
Video vid_3f… failed: Runway refused the prompt (SAFETY.INPUT.TEXT). Tried: runway seedance2_5: accepted.
```

Failures a caller can act on are `ServiceError`s, which `callTool` already turns into `isError` results: not set up, turned off, cap reached, bad arguments, unknown job.

## 9. REST API and authorization

Under `/v1/<workspace id>`, all declared in `ROUTE_RULES`:

| Route | Action | Body / query | Answers |
| --- | --- | --- | --- |
| `GET /video` | `video:read` | | 200 `VideoSettings` |
| `POST /video/connections` | `video:edit` | `CreateVideoConnectionRequest` | 201 `VideoConnection`; 400 invalid; 409 duplicate or too many |
| `PATCH /video/connections/:name` | `video:edit` | `UpdateVideoConnectionRequest` | 200; 404; 409 for an environment connection |
| `DELETE /video/connections/:name` | `video:edit` | | 204; 404; 409 for an environment connection |
| `PUT /video/policy` | `video:edit` | `UpdateVideoPolicyRequest` | 200 `VideoPolicy`; 409 stale revision |
| `GET /video/models` | `video:read` | | 200 `VideoModelList` |
| `POST /video/jobs` | `video:generate` | `VideoGenerateRequest` | **202** `VideoJob` (also when no provider accepted it: the job is `failed` and says why); 400 invalid; 409 not set up; 429 a cap is reached; 503 turned off |
| `GET /video/jobs` | `video:generate` | `?limit=1..100&before=<job id>` | 200 `VideoJobList`, every job in the workspace |
| `GET /video/jobs/:id` | `video:generate` | `?wait=0..60` | 200 `VideoJob`; 404 |
| `POST /video/jobs/:id/cancel` | `video:generate` | | 200 `VideoJob`; 404 |

Outside `/v1` (so no route rule, like `/mcp` and the OAuth routes):

| Route | Who | Answers |
| --- | --- | --- |
| `GET /video/downloads/:token` | Anyone holding the link | 302 to the provider's URL, or 200 `video/mp4`; 404 unknown token or job not succeeded; 410 the video has expired; 502 the provider could not be reached; 503 turned off |

Schemas follow `routes/web.ts`: `additionalProperties: false` everywhere, `name` `{ type: "string", minLength: 1, maxLength: 64 }`, job id `{ type: "string", pattern: "^vid_[0-9a-f-]{36}$" }`, token `{ type: "string", pattern: "^[A-Za-z0-9_-]{43}$" }`, `kind: { enum: VIDEO_KINDS }`.

`access.ts` changes:

```ts
// Video providers hold keys and spend money: members look, admins change them.
["GET /v1/:workspace/video", workspace("video:read")],
["GET /v1/:workspace/video/models", workspace("video:read")],
["POST /v1/:workspace/video/connections", workspace("video:edit")],
["PATCH /v1/:workspace/video/connections/:name", workspace("video:edit")],
["DELETE /v1/:workspace/video/connections/:name", workspace("video:edit")],
["PUT /v1/:workspace/video/policy", workspace("video:edit")],
// Starting a video spends the workspace's video budget, so admins only among people.
["POST /v1/:workspace/video/jobs", workspace("video:generate")],
["GET /v1/:workspace/video/jobs", workspace("video:generate")],
["GET /v1/:workspace/video/jobs/:id", workspace("video:generate")],
["POST /v1/:workspace/video/jobs/:id/cancel", workspace("video:generate")],
```

- `MEMBER_ACTIONS` gains `"video:read"`.
- `ADMIN_ACTIONS` gains `"video:edit"` and `"video:generate"`, with the comment "Video provider keys, the video limits, and videos that spend the budget."
- `ACTION_LABELS` picks the labels up from `API_TOKEN_PERMISSIONS`.
- `tokenMay` already lets `video:edit` satisfy `video:read`.

This is the web feature's rule (D10 there): members see settings, admins and tokens with the grant spend. An API token or a person sees every job in the workspace; the workspace boundary is enforced by the access hook and by `workspaceId` in every job query. A job id from another workspace is a 404.

Download responses: `cache-control: private, no-store`, `referrer-policy: no-referrer`. A streamed video also sends `content-type: video/mp4` (fixed, never the provider's), `x-content-type-options: nosniff`, `content-security-policy: default-src 'none'; sandbox`, and `content-disposition: attachment; filename="<job id>.mp4"`. The dashboard is served from the same origin, so nothing a provider returns may ever render as a page.

## 10. Configuration and availability

Environment variables (default workspace only, read-only connections, like proxies):

| Variable | Effect |
| --- | --- |
| `GOOGLE_VIDEO_API_KEY` | A Google connection named `google-video`. A separate variable from `GEMINI_API_KEY` on purpose: a chat key must not start paid video on its own (the precedent is `CLOUDFLARE_BROWSER_API_TOKEN`). `GOOGLE_VIDEO_BASE_URL` overrides the endpoint for tests. |
| `RUNWAY_API_KEY` | A Runway connection named `runway`. `RUNWAYML_API_SECRET` (Runway's own name) is an alias. `RUNWAY_BASE_URL` for tests. |
| `LUMA_API_KEY` | A Luma connection named `luma`. `LUMA_AGENTS_API_KEY` is an alias. `LUMA_CREDIT_PRICE_USD` sets what a credit costs on your plan (default 0.01); a value that is not a number from 0 to 10 fails startup, as `BRIGHTDATA_PRICE_PER_1000` does. `LUMA_BASE_URL` for tests. |
| `VIDEO_DISABLED` | `true` or `1` turns video off in every workspace: the tools are not served and every video route answers 503, except `GET /video`, which answers with `available: false`. |

Parsing goes in `configFromEnv` after the proxies block, with the same `KEY || BASE_URL` condition, and fills `video: { disabled, connections }`.

What "available" means, at three levels:

| Level | Decided by | Effect |
| --- | --- | --- |
| Gateway | `VIDEO_DISABLED` | Off: no tools in `tools/list`, routes 503, `VideoSettings.available: false`. |
| Workspace | At least one connection that is on and has a key | None: tools are listed (the list is static), `video_models` and `GET /video/models` say `available: false` with the reason, `video_generate` and `POST /video/jobs` refuse with the 409 message. |
| Caller | The `video:generate` grant | Missing: MCP error -32001 from `requireGrant`; REST 403 from the access hook. |

## 11. Limits, cost, and telemetry

**Time.** Create call to a provider: 30 s. Poll: 20 s. Google content fetch: 60 s. A wait: up to 60 s, and never past the MCP deadline (90 s by convention) or the client hanging up. Polls of one job are at least 5 s apart whoever asks.

**Size.** Prompts up to 4000 characters. Provider answers are read with `readLimited`: 1 MB, or 16 MB for Google's result. Nothing larger is ever held in memory, and nothing is written to disk or MongoDB except the job record.

**Spend.** Video is far more expensive per call than a web fetch: a 5-second 720p clip is about $0.35 on Google, $1.50 on Runway Seedance, and roughly $1 on Luma.

- Each workspace has `monthlyBudgetUsd` (default $25) and `callerVideosPerDay` (default 10), counted per caller id (`user:<id>`, `api-token:<id>`, `agent:<id>`), and `maxDurationSeconds` (default 10).
- The estimated cost is held before the provider is called, with the same conditional increment the proxy caps use, so two calls cannot both take the last of the budget.
- The hold is given back when the provider billed nothing: a refused key, a provider error, an invalid input, a job that never started, a cancel that the provider honoured before it ran is **not** assumed free (the hold stays). The job record's `settled` flag, flipped by one conditional update, makes sure a hold is released once.
- Costs are estimates from list prices. Actual charges are on the provider's bill. This is said in the README and in every tool result ("Estimated cost").
- A job nobody reads keeps its hold. Counters read high, never low.

**Telemetry.** `TelemetryService.recordVideo(video: VideoTelemetry)` records an event of type `gateway.video`, built like `recordWebFetch`:

```ts
export type VideoTelemetry = {
	workspaceId: string;
	caller: TelemetryCaller;
	jobId: string;
	phase: "started" | "finished";
	provider: string; // connection name
	kind: string;
	model: string;
	status: string;
	durationSeconds: number;
	resolution: string;
	costUsd: number;
	/** Since the job was created. */
	latencyMs: number;
	attempts: Array<{ provider: string; model: string; outcome: string }>;
	errorCode?: string;
};
```

`data.operation` is `"video"`. The prompt, the image URL, and any provider URL are never recorded. The event goes to the recent-events feed and the MongoDB sink. It stays out of model analytics automatically, because analytics select `GATEWAY_EVENT_TYPES` and `WEB_EVENT_TYPE` only; do not add it to either.

## 12. Security invariants

1. **Provider keys are credentials.** Stored, projected, and logged like proxy keys: never returned, never in a log line, error, tool result, telemetry event, or job record. Keys travel in headers only (Google's `?key=` form is never used). Every provider message passes through `providerMessage`, which removes the key and URLs.
2. **A job belongs to its workspace.** Every job query filters `workspaceId` with `$eq`. Over MCP an agent reads only jobs whose `createdBy.id` is its own. A job that exists elsewhere and a job that does not exist give the same 404.
3. **Ids are the gateway's.** Provider job ids never leave the server, so a caller cannot use one provider id to probe another account's job.
4. **The download link is a capability for one video.** 256 random bits, valid only while the job is `succeeded` and unexpired, bound to one job. It reveals nothing else and grants nothing else. Unknown tokens all get the same 404.
5. **Nothing a provider returns renders in the gateway's origin.** Streamed content is always `video/mp4`, `nosniff`, sandboxed, and an attachment. A redirect goes only to an `https` URL that passes `checkTargetUrl`.
6. **Image URLs pass the URL guard before a provider sees them.** `checkTargetUrl` plus `https` only. The gateway does not fetch the image itself, so there is no request forgery from the gateway; the check stops internal host names leaking to a provider (invariant 2 of the web plan).
7. **Spend is capped before the call.** Hold first, then call.
8. **Agents cannot widen the request.** No headers, no provider endpoints, no keys, no callback URLs from the caller. `baseUrl` exists only on environment connections.
9. **Prompts are the workspace's own data.** They are stored on the job (for listing) and sent to the chosen provider, and nowhere else.

## 13. Decisions

Built as recommended unless the owner says otherwise. Only D2 can block.

| # | Question | Recommendation |
| --- | --- | --- |
| D1 | Which three? | Google Gemini Omni Flash, Runway, Luma Ray 3.2 (section 3). Sora and Gemini-API Veo no longer exist. |
| D2 | What if Omni does not support `background: true`? | Step V0 finds out with one real call or the API reference. If it does not: do not hold a request open for minutes. Ship Runway and Luma, reach Omni through Runway (`gemini_omni_flash_1.2`, a catalogue row), and ask the owner whether the third adapter should be fal or Kling. **Needs the owner only in that case.** |
| D3 | Pass provider URLs through, proxy bytes, or store? | Never store. One gateway link per video that redirects to the provider (Runway, Luma) or streams a small file (Google). Reasons in section 5. The alternative, returning provider URLs as they are, is less code but cannot serve Google at all and leaves Luma links dead after an hour. |
| D4 | Who picks the provider? | The admin orders connections; the caller may name a provider or model; failover only before a job is accepted and only on errors that billed nothing. |
| D5 | Separate keys from chat connections? | Yes: own store, own collections, own environment variables. A chat key must not turn on paid video, and Runway and Luma have no chat connection to reuse. |
| D6 | May ordinary members start videos? | No, as with paid fetches: admins among people; API tokens and agents by grant. |
| D7 | Poll in the background? | No. Poll on read, with an optional wait. It needs no timer, so it behaves the same on the Worker. Webhooks from providers are a follow-up. |
| D8 | One grant or more for agents? | One, `video:generate`, covering start, status, cancel, and list of the agent's own jobs. |

## 14. Testing

Same conventions as the web suites: vitest, fake `FetchLike`s, no real provider in CI, MongoDB variants run when `mongoAvailable()` (see `test/web-store.test.ts` and `test/mongo-env.ts`). There are no coverage thresholds in the vitest configs; match the web feature's depth, which exercises every adapter branch.

| File | Covers |
| --- | --- |
| `core/common/test/index.test.ts` (extend) | Every `DEFAULT_VIDEO_MODEL` is in `VIDEO_MODELS`; every model's defaults pass its own `videoModelProblem`; `videoModelProblem` names the allowed values. |
| `core/server/test/video-providers.test.ts` | Per adapter, with the `fake(answer)` helper from `web-providers.test.ts`: the exact URL, method, headers, and body of create, poll, cancel; every status mapped; every failure code mapped; 401, 402, 429 (with `Retry-After`), 400/422, 500, a network error, an aborted signal; an oversized body; Google's video block found at more than one nesting depth, and a completed interaction without one; Runway's two spellings of cancelled; Luma's fresh URL on each poll; a non-https or private result URL refused; cost estimates including the unknown-model fallback. |
| `core/server/test/video-store.test.ts` | Memory and MongoDB: create, list without the key, duplicate and limit refusals, validation per kind, environment connections in the default workspace only and read-only, key kept unless sent, a new key clears a problem, removal leaves `order`, stale policy revision refused, holds against budget and caller under concurrency, release. |
| `core/server/test/video-jobs.test.ts` | Memory and MongoDB: workspace filter on every read, own-only listing, paging, `finish` and `settle` won by exactly one of two concurrent callers, token lookup, expiry. |
| `core/server/test/video-service.test.ts` | Selection order; pinned provider and model; incompatible request messages; failover on provider error and not on refused, invalid, or timeout; record written before the provider call; a job with no provider id after two minutes fails and releases; poll throttling; wait ends on finish, deadline, and abort; finished jobs never polled again; hold released once; problem flag set, held 15 minutes, cleared; deleted connection; expired result; disabled gateway; download returns redirect, bytes, gone; Luma URL refreshed near expiry. |
| `core/server/test/video-routes.test.ts` | Through `startChannels(cleanups, config, { videoFetch })`: every REST route's status codes; a member reads settings but cannot start a job; API tokens with and without each permission; an agent without `video:generate` gets -32001 naming the grant; agent A cannot read agent B's job or a person's; a job from another workspace is 404; `tools/list` has the five tools, and none with `VIDEO_DISABLED`; the download link redirects for Runway and streams with the fixed headers for Google; every `/v1` video route is in `ROUTE_RULES`. |
| Key leak test (in `video-routes.test.ts` or the service suite) | Fails each provider in every way the adapters handle, with a provider error body that echoes the key, and asserts the key appears in no response, tool result, job record, telemetry event, or log line. |
| Existing suites to rerun and fix | `test/token-permissions.test.ts` (iterates `API_TOKEN_PERMISSIONS`), `test/gateway-data.test.ts` (passes once the collections are listed), `test/oauth.test.ts` (lists agent grants near line 176), the suite that covers `configFromEnv` (search the tests for `ZENROWS_API_KEY`), and `core/ux/test/ApiTokens.test.tsx` and `Agents.test.tsx`. |

`pnpm lint` (biome, tabs) and `pnpm build` must pass. `scripts/test-worker.ts` is not extended, as for web.

## 15. Docs

- Save this file as `docs/VIDEO_MODELS_PLAN.md`. After the build, add a "What was built" section, as the web plan has.
- `README.md`:
  - A new `### Video generation` section after `### Web access and proxies`: what it does, the three providers in a table (what each is, models, rough price), the job lifecycle, the five tools, the REST routes in the compact style of the web section's last paragraph, the limits, that costs are estimates, that links redirect or stream and nothing is stored, and where the data lives.
  - Four rows in the environment variable table, after the `WEB_FETCH_DISABLED` row.
  - The routes in `### Endpoints`.
  - The new permissions in `### API tokens` and the new grant in `### Agents`.
  - `MONGODB_URI` row: mention video settings and jobs if it lists what is stored.
- `docker-compose.yml`: the new variables.
- `docs/CLOUDFLARE-CONTAINERS.md`: add the secrets only if that file lists the proxy ones.

## 16. Out of scope and follow-ups

- **A Video page in the dashboard** (connections, policy, a job list with a player). This change adds only the two permission entries. Until then admins manage video through the REST API or environment variables.
- **Bots.** The tools are not in `BOT_TOOLS`. A bot's 90-second run cannot wait for a video, and its web fences would need thought.
- **Agent webhooks and MCP events** for a finished job (`video.finished`), and a `video.changed` app event like `onWebChanged`. Until then agents poll.
- **Provider webhooks** instead of polling.
- **Image input on Google**, which needs the gateway to download the image safely. Runway and Luma take URLs today.
- **1080p and 4K on Google**, which need URI delivery and a streamed download.
- **More Runway models** (`kling_4`, `veo3.1`, `gemini_omni_flash_1.2`): catalogue rows once their fields are read from the OpenAPI spec.
- **Editing, extending, reframing, video-to-video, audio controls, negative prompts, seeds.**
- **Settling to actual cost** (Luma reports `usage.credits_charged`).
- **Idempotency keys** on create, for clients that retry.
- **A video section in analytics and the overview page.**
- **A per-caller limit on jobs running at once.**
- **Kling's own API, fal, Replicate; Kling on Cloudflare Workers AI** (a search result suggested Cloudflare hosts `kling-v3`; not checked).

## 17. Implementation checklist

One pull request, in this order. Each step leaves the suite green.

- **V0. Verify.** With a paid Gemini key, or from the Interactions API reference: confirm `background: true` works with `gemini-omni-1.2-flash`, the type of `response_format.duration`, where the video block sits in `steps`, and whether `Api-Revision` is needed. Read Runway's `openapi.json` for the `text_to_video` and `image_to_video` variants of `seedance2_5` and `gen4.5` and the task schema. Confirm Luma's text-to-video body with one call if a key is at hand. Correct section 4 and the catalogue. If the Google gate fails, apply D2 and tell the owner.
- **V1. Common.** `video.ts`, the exports, the grants, the common tests.
- **V2. Adapters.** `video/types.ts`, `providers/shared.ts`, the three adapters, `providers/index.ts`, `video-providers.test.ts`.
- **V3. Stores.** `video/store.ts`, `video/jobs.ts`, `GATEWAY_COLLECTIONS`, their tests.
- **V4. Service.** `video/service.ts`, `recordVideo`, `video-service.test.ts`.
- **V5. Config and wiring.** `config.ts`, `server.ts`, `McpCallContext.origin`, `video/mcp.ts`, `routes/video.ts`, `access.ts`, `video-routes.test.ts`, the leak test.
- **V6. Dashboard grants.** The two `permissionGroups` entries; rerun the ux tests.
- **V7. Docs.** README, `docker-compose.yml`, "What was built" in this file.
- **V8. Check.** `pnpm lint`, `pnpm build`, `pnpm test`. Installs, if any are needed, go through the Safe Chain shims; this plan adds no dependency.

## What was built

Everything in sections 6 to 12, in one change, with these findings and differences.

**Step V0 findings** (read from the providers' own documentation on 2026-11-19; no paid call was made):

- **Google.** The Omni guide's best practices name `background=false` as the switch for synchronous runs, so background mode is an accepted setting for Omni; D2 did not trigger. `response_format.duration` is a string such as `"15s"` (whole seconds, 3 to 15, default 10). The REST examples send `Api-Revision: 2026-05-20` and `x-goog-api-key`, and the adapter does the same. It also accepts a create answer that is already `completed`.
- **Runway.** The full `openapi.json` was read. `gen4.5` takes 2 to 10 seconds (not 5 or 10) and prompts of up to 1000 characters; text-to-video ratios are `1280:720` and `720:1280`. `seedance2_5` takes 4 to 30 seconds and offers 480p, 720p, and 1080p sizes in 16:9, 9:16, and 1:1 (`854:480`, `1280:720`, `1920:1080`, `960:960`, …). A create answers 200 with `{ id, estimatedCost }`. A task's statuses are `PENDING`, `THROTTLED`, `RUNNING`, `SUCCEEDED`, `FAILED`, and `CANCELLED`; finished tasks report `cost.credits`, which now decides whether a failure was billed. `DELETE /v1/tasks/{id}` answers 204. Pricing: `seedance2_5` costs 20, 30, or 68 credits a second at 480p, 720p, or 1080p, 80 at least; `gen4.5` costs 12.
- **Luma.** The create reference confirms `video.duration` (`"5s"` or `"10s"`), `video.resolution`, and `video.start_frame.url`, with `aspect_ratio` and `type` at the top level.

**Differences from the plan:**

- The catalogue follows the V0 findings. `VIDEO_RESOLUTIONS` gains `480p`, `VIDEO_LIMITS.minDurationSeconds` is 2, and `VideoModel` gains `promptLength`, which `videoModelProblem` checks.
- **Cloudflare routing.** `/video/downloads/*` is added to `run_worker_first` in `wrangler.jsonc` and `wrangler.legacy.jsonc`; without it the edge would answer download links with the dashboard. The video variables are added to the container's settings allowlist (`container-environment.ts`).
- A job that never got a provider id is failed after two minutes, but its hold **stays**: the provider may have accepted it, and counters read high, never low.
- There is no `settled` flag. The move to a finished state is already conditional, so its winner releases the hold and sets the record's `hold` to null.
- Adapters return a link's lifetime (`ttlMs`), and the service turns it into a time with its own clock.
- `GET /video/models` reports `canGenerate` for the caller through a new `requestMay` helper in `auth/access.ts`; an API token's request now carries its permissions for it.
- `GET /video/jobs` accepts `limit` up to 100. `video_list` caps it at 20.
- `test/auth-helpers.ts` rewrites `/v1/video` paths to the default workspace, as it does for the other resources.

**After review.** Fable's review and Codex's automated review of the first commit found these, all fixed:

- A create call that threw after the request may have left (a connection that broke off, or a successful answer too large to read) was treated as "nothing accepted": the hold was released and the next provider tried, which could pay twice. Now only an error that proves the request never left (DNS failure, refused connection, certificate errors) moves on; anything else is a `timeout` that keeps the hold and stops.
- Concurrent readers who all found a poll due all polled. Each poll is now claimed with a compare-and-set on `lastPolledAt`.
- A first hold of a month or day that lost the race to create its counter (a duplicate key on the upsert) was refused as if over the cap. It is now retried without the upsert. `ProxyStore.increment` in `web/store.ts` has the same pattern and is left for its own change.
- The budget was not given back when the caller's counter write threw.
- `cancel` acted on the stored status: on Runway, a cancel of a task that had finished unseen deletes its video. It now checks with the provider first.
- A wait on a job whose connection was removed re-read the store every 250 ms.
- A 429 whose message mentioned a quota was recorded as an out-of-credits problem. Rate limits are now read first, and `Retry-After` is capped at 10 minutes.
- Download tokens were logged in full by the legacy Worker's own request log; it now masks them, as the Node server does.
- Gemini Omni is capped at 10 seconds until URI delivery is built (Google advises it above 4 MB), and its results are promised for 7 days, the shortest retention a project can set.
- Smaller items: a job canceled between failover attempts starts nothing more; "never started" is measured from the last attempt; a job whose hold was given back shows a cost of 0; Luma's `usage.credits_charged` decides whether a refusal was billed; the memory store's counters behave as MongoDB's do; an unused `onChanged` option was removed from the routes.

Tests: `core/common/test/video.test.ts`, and `video-providers`, `video-store` (memory and MongoDB), `video-service`, and `video-routes` (REST, MCP, permissions, download headers, and a key-leak check) under `core/server/test`.

### Critical Files for Implementation

- /home/user/autonomo.us/core/server/src/web/service.ts (the pattern for `VideoService`: options, `runStep` failure handling, problem flags, telemetry)
- /home/user/autonomo.us/core/server/src/web/store.ts (the pattern for `VideoStore`: memory mode, environment overlay, `increment` / `adjust`, policy compare-and-set)
- /home/user/autonomo.us/core/server/src/server.ts (wiring: stores, tool sets, scoped routes, `initialize`, `closeAll`)
- /home/user/autonomo.us/core/server/src/auth/access.ts (`ROUTE_RULES`, `MEMBER_ACTIONS`, `ADMIN_ACTIONS`)
- /home/user/autonomo.us/core/server/src/mcp/server.ts (`McpToolSet`, `McpCallContext`, `requireGrant`, `schema`)

Other files read for this plan: /home/user/autonomo.us/docs/WEB_PROXIES_PLAN.md, /home/user/autonomo.us/core/server/src/web/types.ts, /home/user/autonomo.us/core/server/src/web/mcp.ts, /home/user/autonomo.us/core/server/src/web/providers/brightdata.ts, /home/user/autonomo.us/core/server/src/web/providers/read.ts, /home/user/autonomo.us/core/server/src/web/url-guard.ts, /home/user/autonomo.us/core/server/src/routes/web.ts, /home/user/autonomo.us/core/server/src/config.ts, /home/user/autonomo.us/core/server/src/telemetry/telemetry.ts, /home/user/autonomo.us/core/server/src/gateway-data.ts, /home/user/autonomo.us/core/server/src/bots/web-requests.ts, /home/user/autonomo.us/core/common/src/web.ts, /home/user/autonomo.us/core/common/src/api-tokens.ts, /home/user/autonomo.us/core/common/src/agent-tokens.ts, /home/user/autonomo.us/core/common/src/index.ts, /home/user/autonomo.us/core/ux/src/ApiTokensView.tsx, /home/user/autonomo.us/core/ux/src/AgentMcp.tsx, /home/user/autonomo.us/core/server/test/web-routes.test.ts, /home/user/autonomo.us/core/server/test/web-providers.test.ts, /home/user/autonomo.us/core/server/test/gateway-data.test.ts, /home/user/autonomo.us/core/server/test/channel-helpers.ts.

Sources:

- [OpenAI video generation guide (shutdown notice)](https://developers.openai.com/api/docs/guides/video-generation)
- [OpenAI deprecations](https://developers.openai.com/api/docs/deprecations)
- [Gemini API video docs](https://aistudio.google.com/docs/video)
- [Gemini Omni guide](https://aistudio.google.com/docs/omni)
- [Gemini API deprecations](https://aistudio.google.com/docs/deprecations)
- [Gemini Interactions guide](https://aistudio.google.com/docs/interactions)
- [Gemini background execution](https://aistudio.google.com/docs/background-execution)
- [Gemini Interactions API reference](https://aistudio.google.com/api-reference/interactions-api)
- [Gemini API pricing](https://aistudio.google.com/docs/pricing)
- [Runway: using the API](https://docs.dev.runwayml.com/guides/using-the-api/)
- [Runway models](https://docs.dev.runwayml.com/guides/models/)
- [Runway pricing](https://docs.dev.runwayml.com/guides/pricing.md)
- [Runway outputs](https://docs.dev.runwayml.com/assets/outputs/)
- [Runway HTTP errors](https://docs.dev.runwayml.com/errors/errors/)
- [Runway task failures](https://docs.dev.runwayml.com/errors/task-failures/)
- [Runway core API text](https://docs.dev.runwayml.com/_llms-txt/core-api.txt)
- [Runway OpenAPI spec](https://docs.dev.runwayml.com/openapi.json)
- [Luma Agents API: create a generation](https://docs.agents.lumalabs.ai/api/resources/generations/methods/create)
- [Luma Agents API FAQ](https://docs.agents.lumalabs.ai/guides/faq)
- [Luma Agents API pricing](https://docs.agents.lumalabs.ai/guides/pricing)
- [DEV Community: AI video generation APIs compared](https://dev.to/owen_fox/ai-video-generation-apis-compared-sora-2-pro-vs-veo-31-vs-kling-26-pro-2026-2okh)
- [WaveSpeed: best AI video generator 2026](https://wavespeed.ai/blog/posts/best-ai-video-generator-2026/)
- [Apiframe: best AI video generation APIs](https://apiframe.ai/blog/best-ai-video-generation-apis)
- [Apiframe: Luma API guide](https://apiframe.ai/guides/luma-api-guide)
- [Cloudflare Workers AI: kling-v3](https://developers.cloudflare.com/ai/models/klingai/kling-v3/)