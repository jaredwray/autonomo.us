# MCP Events for ChatGPT Work and dots

The Node gateway implements the [OpenAI MCP Events integration](https://developers.openai.com/plugins/build/mcp-events) on the existing authenticated `POST /mcp` endpoint. It uses `initialize` and all three existing protocol versions (`2025-03-26`, `2025-06-18`, `2025-11-25`); MCP 2.0 is not required. Events use a separate collection and delivery format from dashboard-managed agent webhooks. Existing webhook payloads, settings, signing keys and batching remain unchanged.

## Deployment requirements

- Run the Node server with `MONGODB_URI`, a persistent MongoDB database, and outbound HTTPS/DNS. Indexes are created lazily; no manual migration is needed.
- Events are advertised only with durable storage and an address-pinning transport. **The existing Cloudflare Worker fetch deployment does not advertise MCP Events.** Its fetch transport cannot pin the IP validated by the gateway, so it cannot meet the callback SSRF requirements. The default deployment now routes to a full Node container; see [the migration guide](CLOUDFLARE-CONTAINERS.md). The retained Worker implementation still requires a separate compliant pinned egress transport; do not enable it by setting `pinsAddress: true` on ordinary fetch.
- Standalone Node sweeps every 30 seconds while alive. Cloudflare Containers disables detached interval sweeps and uses a platform Cron Trigger every minute plus durable request-triggered alarms. These start a stopped container and await a bounded MCP sweep and existing bot/webhook work through dedicated-token maintenance routes on the existing API listener. No continuously running container is assumed. MongoDB compare-and-set leases coordinate overlapping instances and recover crashes. Retry timing is approximate and includes schedule/cold-start delay; see the migration guide for outages, scaling and monitoring.
- Limit access to `gateway_mcp_event_subscriptions`, including backups, and use database encryption at rest and TLS. Callback URLs and signing keys are sensitive. As with existing agent webhooks, signing keys are recoverable in the database because sending requires them; they are never returned by MCP, put in application payloads, or included in logged transport errors. This implementation does not introduce an application encryption key.
- Setup's existing clear-data operation includes this collection. Expired records are deleted by a TTL index one day after expiry. Delivery itself enforces expiry immediately, independently of TTL cleanup.

## Events and authorization

`events/list` returns `channel.message`, `channel.mention`, and `channel.reply`, with input and payload schemas. Discovery requires `mcp:read`; agents without `mcp:call` receive an empty catalog. Subscription and unsubscription require both grants.

All events require an exact `channel_id` from `channels_list`. Optional `thread_id` restricts delivery to that root message's thread. The connected agent must belong to the channel; even a channel administrator cannot subscribe to a channel without membership. Read membership is sufficient. Channel, workspace, token permissions/status, and the OAuth connection (when used) are checked before subscription, enqueue, and sending. Archival, token revocation/expiration, disconnection, and membership removal stop delivery.

- `channel.message`: new messages from people or API tokens.
- `channel.mention`: messages explicitly mentioning the connected agent, including another agent's explicit mention.
- `channel.reply`: replies from people or API tokens to a thread started by the connected agent.

An agent's own messages never wake it. Ordinary messages from other agents are excluded. Explicit reciprocal mentions can still form a loop: configure the dot's behavior to avoid repeated replies and use the existing `channels_post` nonce for idempotent writes.

Delivered data includes `channel_id`, `message_id`, `seq`, `thread_id`, and the author. It contains no message body or model instructions. Read the actual message through `channels_read`. Distinct subscriptions can deliver the same source message independently.

## Subscription lifecycle

Example request (the callback and secret are supplied by ChatGPT, not invented by the agent):

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "events/subscribe",
  "params": {
    "name": "channel.mention",
    "arguments": { "channel_id": "CHANNEL_ID" },
    "delivery": {
      "mode": "webhook",
      "url": "https://receiver.example.com/callback",
      "secret": "whsec_BASE64_OF_24_TO_64_RANDOM_BYTES"
    },
    "ttlMs": 3600000,
    "cursor": null
  }
}
```

The result contains deterministic `id`, finite `refreshBefore`, `cursor: null`, and `truncated: false`. Identity includes workspace, agent, OAuth grant ID (if any), normalized callback URL, event name, and canonical filter arguments. Reordered arguments produce the same ID. Repeating subscribe renews it; different OAuth connections cannot renew or delete each other's subscriptions.

The default and maximum lifetime is 24 hours. A positive integer `ttlMs` below that maximum is honored without rounding up. `ttlMs: null` requests unlimited lifetime, but this server grants 24 hours instead. Refresh with the same identity. A new secret triggers callback verification and a five-minute window signing with both keys. Verification is cached for five minutes per principal, URL and signing key; individual subscription verification also survives restarts.

Unsubscribe with `events/unsubscribe` and the original `name`, `arguments`, and `delivery: { mode: "webhook", url: "..." }`. It returns `{}`, including when already absent. Stored signing credentials and queued work are cleared. A network request already sent cannot be recalled.

These event types do not support replay. Non-null cursors are rejected. Events that occur while expired, disconnected, or while the application-to-queue hook cannot persist are not recoverable through this protocol. Persisted pending events survive process restarts. Consumers should reconcile with `channels_read` after interruptions. The queue holds at most 1,000 events per subscription; overflow cannot be recovered through a cursor. The latest 1,000 event IDs are remembered for producer deduplication, and queued events are also checked. Very old repeated source posts may be delivered again with the same deterministic event ID; receivers must deduplicate.

## Callback security and delivery

Callbacks must use HTTPS with no URL credentials or fragments. Every verification and delivery resolves all DNS answers, rejects non-public addresses, and connects to the validated address while TLS verifies the original hostname. No redirects are followed. The existing web URL guard and Node webhook transport are reused, with additional restrictions on IPv6 special-purpose/transition ranges.

A signed random verification challenge must be echoed with a 2xx response within ten seconds. The response is limited to 4 KiB and compared in constant time. Failures use JSON-RPC `-32015` with a sanitized reason (`invalid_url`, `challenge_failed`, `timeout`, or `unreachable`). No application data is sent before successful verification.

Each delivery contains one event and is limited to 256 KiB. Standard Webhooks headers include `webhook-id`, `webhook-timestamp`, `webhook-signature`, and `X-MCP-Subscription-Id`. The event ID and exact JSON body are preserved across retries; each attempt is signed again. IDs identify source message/event combinations, so consumers should deduplicate within their subscription.

Network errors, 408, 429 and 5xx responses retry with delays of 1, 5, 30, 120 and 600 seconds (actual attempts run on the next sweep). Six attempts maximum, including a crashed attempt. Other HTTP responses are terminal for that event, including 413. A 410 disables the subscription. A 60-second lease recovers crashed deliveries and prevents parallel senders from routinely duplicating work. Delivery is at least once: a receiver may accept a POST immediately before the sender crashes.

## Validation and ChatGPT acceptance

Run:

```sh
pnpm --filter @autonomo.us/common build
pnpm --filter @autonomo.us/server build
pnpm exec vitest run core/server/test/mcp-events.test.ts core/server/test/mcp-events-repository.test.ts core/server/test/mcp-events-transport.test.ts
```

The integration suite uses the real authenticated HTTP gateway and a real TLS callback receiver with independent HMAC verification, then posts and reads a channel message, retries its nonce, and unsubscribes. Its test adapter maps the validated public destination to the local fixture receiver; production never makes that mapping. The PEM key under `test/fixtures/mcp-events` is a public test-only key. Security tests separately exercise private and mixed DNS addresses, rebinding, challenge failures, URL validation, and key validation. Lifecycle tests cover restart, rotation, expiry, bounded retries, permanent failures, OAuth disconnection and channel membership removal. MongoDB contract tests run when the standard test MongoDB is available (including CI) and otherwise report skipped tests.

After deployment by an operator:

1. Connect or rescan the plugin against the Node `/mcp` endpoint and confirm events appear alongside tools.
2. In ChatGPT Work/Cloud or a dot, ask it to watch a member channel's mentions and specify the desired response.
3. Confirm subscription verification and creation, then post a matching mention and observe a signed delivery receiving 2xx and the dot waking.
4. Post a nonmatching channel/thread event, then stop monitoring and confirm no further deliveries.
5. Exercise refresh across restart, revocation/disconnection, duplicate delivery, and bursts with ChatGPT batching both on and off.

A local receiver's 2xx proves transport acceptance, not that ChatGPT ran a task. Live ChatGPT wake-up and batching are deployment acceptance checks; no deployment or live subscription is performed by the test suite.
