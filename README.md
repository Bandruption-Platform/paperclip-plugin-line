# paperclip-plugin-line

[![npm](https://img.shields.io/npm/v/paperclip-plugin-line)](https://www.npmjs.com/package/paperclip-plugin-line)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

Bidirectional [LINE Messaging API](https://developers.line.biz/en/docs/messaging-api/) integration for [Paperclip](https://github.com/paperclipai/paperclip). Receive verified LINE webhooks, route inbound text and media into durable Paperclip issue threads, run agent sessions per LINE user, and reply with LINE push tools — text, image, flex, template, sticker, and reply-token acknowledgments.

Built on the Paperclip plugin SDK ([apiVersion 1](https://github.com/paperclipai/paperclip/tree/main/packages/plugin-sdk)) and maintained by [Bandruption](https://bandruption.com), who run it in production for artist support workflows on LINE Japan.

## Why this exists

LINE is the dominant messaging platform across Japan, Taiwan, and Thailand — and the most-requested missing connector for teams operating Paperclip in APAC. There was no Paperclip-native way to do bidirectional LINE without standing up a separate webhook service, mapping LINE userIds to Paperclip companies by hand, and hand-rolling reply-token bookkeeping. This plugin is the first-party path: install it, point LINE Developers Console at the plugin webhook, configure your channel secrets, and your agents can hold persistent conversations with LINE users from within Paperclip.

If you're shipping the [discord plugin](https://github.com/mvanhorn/paperclip-plugin-discord) for your western community and need the same surface for your Japanese, Taiwanese, or Thai community, this is the equivalent.

## What it does

### Webhook intake

* HMAC-SHA256 signature verification on every inbound LINE webhook (`x-line-signature`)
* Fast-ACK pattern — webhook returns 2xx within milliseconds; events queue for async processing
* Replays are idempotent (deduped by `events[].webhookEventId`)
* Op telemetry on `line.webhook.*`, `line.queue.*` counters

### Inbound routing

* Each LINE user maps to a Paperclip principal record. Active principals route into a persistent Paperclip issue thread.
* Inbound text messages append to the issue as durable comments and are forwarded to the principal's stored agent session via `ctx.agents.sessions.sendMessage`.
* Inbound `image`, `video`, `audio`, and `file` messages are fetched from the LINE content API, uploaded to Paperclip's issue attachment storage, and surfaced as a comment with a signed read URL.
* Reply tokens are cached against the resulting Paperclip comment so agents can ack quickly via `line.ack_with_reply_token`.

### Outbound LINE tools

Agents can call any of these tools when they have an active session bound to a LINE principal:

| Tool | Description |
| --- | --- |
| `line.push_text` | Send a plain-text push to a mapped LINE userId. |
| `line.push_image` | Send an image (publicly readable or signed URL) with optional preview. |
| `line.push_flex` | Send a [Flex Message](https://developers.line.biz/en/docs/messaging-api/using-flex-messages/) payload. |
| `line.push_template` | Send a [Template Message](https://developers.line.biz/en/docs/messaging-api/message-types/#template-messages) payload. |
| `line.push_sticker` | Send a [LINE sticker](https://developers.line.biz/en/docs/messaging-api/sticker-list/). |
| `line.ack_with_reply_token` | Reply via a cached reply token tied to a Paperclip comment (free of push quota). |
| `line.close_thread` | Close the Paperclip thread for a mapped LINE user. |
| `line.get_profile` | Fetch the LINE display name and picture for a mapped LINE userId. |

### Daily push limits

* Per-company, per-agent, per-UTC-day cap on `line.push_*` calls (default 500)
* Set `linePushDailyLimit` to `0` to disable push tools entirely
* When exhausted, tools return `line_push_daily_limit_exhausted` without calling LINE and write a plugin activity entry
* `line.ack_with_reply_token` is *not* counted against the cap (reply tokens are free under LINE's pricing model)

### Idle thread close

* Open LINE threads with no activity for `idleCloseMinutes` (default 30) are closed automatically
* Closes the Paperclip thread, tears down the persisted agent session, and clears the principal mapping
* Counted in `line.idle_close.*` telemetry

### Reply-token GC

* Cached reply-token metadata older than `replyTokenMaxAgeSeconds` (default 60s — LINE invalidates them shortly after) is swept on a 1-minute cron

### Operational telemetry

The worker registers a `line-ops` data source and includes the same snapshot in plugin health details. Counters cover:

* `line.webhook.{received,verified,rejected}`
* `line.queue.{drained,failed}`
* `line.attachment.{uploaded,failed}`
* `line.reply_token.{cached,used,missed,expired}`
* `line.push.{attempted,succeeded,failed,rejected}` (per-tool)
* `line.idle_close.{closed,error}`
* Current-day push counters per company/agent

Watch these alongside your LINE Messaging API quota in the LINE Developers Console.

## Install

```bash
npm install paperclip-plugin-line
```

Or register against a running Paperclip instance:

```bash
curl -X POST http://127.0.0.1:3100/api/plugins/install \
  -H "Authorization: Bearer <BOARD_AUTH_TOKEN>" \
  -H "Content-Type: application/json" \
  -d '{"packageName":"paperclip-plugin-line"}'
```

## Setup

1. Create a LINE Messaging API channel at [LINE Developers Console](https://developers.line.biz/console/).
2. From the **Basic settings** tab, copy your **Channel secret**.
3. From the **Messaging API** tab, issue a **Channel access token** (long-lived) and copy it.
4. In Paperclip, go to **Settings → Secrets → Create new secret**. Save the channel secret as one secret and the channel access token as another. Copy the resulting UUIDs.
5. Install this plugin and configure with `lineChannelSecretRef` and `lineChannelAccessTokenRef` set to the secret UUIDs.
6. Set the LINE webhook URL in the Developers Console to:

   ```text
   https://<your-paperclip-host>/api/plugins/line-bridge/webhooks/line-webhook
   ```

7. Enable **Use webhook** and disable auto-reply / greeting messages in the LINE channel response settings (otherwise LINE will reply on its own).
8. Run the plugin health check:

   ```bash
   curl http://127.0.0.1:3100/api/plugins/<plugin-installation-id>/health
   ```

## Public ingress

Only the plugin webhook prefix needs to be exposed to the public internet:

```text
/api/plugins/line-bridge/webhooks/*
```

In a public deployment, place Cloudflare, GCLB, or your equivalent edge in front of the Paperclip server and route only that prefix from the public internet. Board UI/API routes should remain behind your normal private or authenticated access policy.

Signed webhook smoke test:

```bash
raw='{"destination":"line-channel-id","events":[]}'
sig="$(printf '%s' "$raw" | openssl dgst -binary -sha256 -hmac "$LINE_CHANNEL_SECRET" | openssl base64 -A)"

curl -i https://<your-paperclip-host>/api/plugins/line-bridge/webhooks/line-webhook \
  -H "Content-Type: application/json" \
  -H "x-line-signature: $sig" \
  --data "$raw"
```

Expected result on a ready install: a 2xx webhook response and a `last-webhook:line-webhook` plugin state update. An invalid signature should be rejected before queueing work.

## Configuration

| Setting | Required | Description |
| --- | --- | --- |
| `lineChannelSecretRef` | Yes | Secret reference for LINE webhook signature verification (channel secret from Basic settings). |
| `lineChannelAccessTokenRef` | Yes | Secret reference for outbound LINE API calls (channel access token from Messaging API tab). |
| `attachmentBucketName` | Yes | Logical namespace prefix for inbound LINE media object keys (e.g. `line-media`). |
| `paperclipBoardApiKeyRef` | Recommended | Secret reference to a Paperclip board API key used for authenticated attachment uploads. |
| `paperclipApiBaseUrl` | No | Override for the Paperclip API base URL. Defaults to `PAPERCLIP_API_URL`. |
| `attachmentSignedUrlTtlDays` | No | TTL in days for signed read URLs on uploaded LINE media (default: 30, max: 90). |
| `idleCloseMinutes` | No | Idle threshold before closing a LINE thread (default: 30, range: 1–1440). |
| `linePushDailyLimit` | No | Per-company, per-agent push cap per UTC day (default: 500, set 0 to disable push tools). |
| `replyTokenMaxAgeSeconds` | No | Cached reply-token TTL (default: 60, range: 1–300). |

## Single-tenant vs multi-tenant

Out of the box, this plugin runs in **single-tenant mode**: all incoming LINE traffic is routed to one configured Paperclip company and one configured agent. This is the right shape for most installs — a brand support inbox, a hobby project, or a single-team agent.

If you need **multi-tenant mode** (one LINE channel mapped to many Paperclip companies, with each LINE userId provisioned to a different agent), implement the optional `onProvisionPrincipal` extension hook described below. This lets you plug in your own identity-mapping logic — OAuth, signed link tokens, or whatever your product needs — without forking the plugin.

## Extension hooks

The plugin exposes a small set of optional hooks for forks or downstream installs:

```ts
import type { LineBridgeExtensions } from "paperclip-plugin-line";

const extensions: LineBridgeExtensions = {
  /**
   * Called when an inbound LINE event arrives from a userId not yet mapped
   * to a Paperclip principal. Return a principal binding to provision the
   * user, or null/undefined to leave them unmapped (and the event silently
   * acknowledged).
   */
  async onProvisionPrincipal(ctx, lineUserId, profile) {
    return {
      paperclipCompany: "default-company",
      agentId: "your-agent-id",
    };
  },

  /**
   * Optional. Called when the plugin closes a LINE thread (idle or via
   * `line.close_thread`). Use to clean up downstream state.
   */
  async onCloseThread(ctx, principal) {
    // ...
  },
};
```

Hooks run inside the plugin's normal capability set; they cannot escalate.

## Session streaming contract

Inbound text messages are written to the Paperclip issue thread first, then sent to the stored agent session with an `onEvent` callback. The callback translates coarse `chunk` and `status` frames into at most one progress text push per session run. `error` frames produce one concise failure push. `done` frames do *not* automatically push a final summary because agent-authored `line.push_*` tool calls own final user-facing summaries and duplicate final messages are worse than a silent completion event.

Session stream callbacks are counted in LINE push telemetry but are not charged against the agent tool daily cap. The cap exists to keep autonomous tool calls from overrunning LINE message quotas while still allowing one failure/progress notice for an already-running turn.

Repeated user messages for an open LINE thread reuse the same stored session record. The plugin passes each turn to `ctx.agents.sessions.sendMessage`; the underlying adapter decides whether that turn is injected mid-run or queued until the next reasoning turn.

## Attachment storage contract

Inbound LINE `image`, `video`, `audio`, and `file` messages are fetched from the LINE content API during async event processing. The plugin uploads supported media through Paperclip's issue attachment API using an explicit object key:

```text
<companyId>/line-bridge/<attachmentBucketName>/issues/<issueId>/messages/<lineMessageId>/<filename>
```

`attachmentBucketName` is operational: production installs must set it to the logical bucket namespace used for LINE relay objects. The underlying Paperclip storage provider remains the instance storage backend (`local_disk` in dev, S3-compatible storage in cloud deployments), so operators should configure the provider bucket and lifecycle policy at the Paperclip instance level.

The upload request asks Paperclip for a signed content URL using `attachmentSignedUrlTtlDays` (30 days by default). The issue comment includes the signed attachment URL, expiry timestamp, logical bucket name, deterministic object key, and a 90-day lifecycle expectation.

Paperclip does not run a separate LINE-object sweeper. Production S3-compatible buckets should enforce a 90-day lifecycle rule for keys under the `<companyId>/line-bridge/<attachmentBucketName>/` prefix. Local dev storage can be cleaned manually with the same prefix.

If LINE content fetch, size validation, storage upload, or signed URL generation fails, the plugin still writes a durable fallback comment into the issue thread so the inbound user turn is visible to the agent.

## Localization

LINE is overwhelmingly used in Japan, Taiwan, Thailand, and Indonesia. The plugin itself is content-agnostic — outbound text is whatever your agent generates — but two fields are intentionally locale-aware in the principal record so downstream agents can branch on them:

* `preferredLocale` — set from inbound LINE profile data when available
* Inbound `text.language` (when LINE provides it) is preserved on the comment metadata

## ACP integration

This plugin participates in the [paperclip-plugin-acp](https://github.com/mvanhorn/paperclip-plugin-acp) ecosystem alongside the Telegram, Slack, and Discord bridges. Inbound LINE turns route through `ctx.agents.sessions.*` by default; if the resolved `agentId` is not present in the host's agent registry, the turn falls back to ACP via plugin-namespaced bus events:

* `plugin.paperclip-plugin-line.acp-spawn` — first turn, payload `{ sessionId, agentName, chatId, threadId, companyId, mode: "persistent" }`. `chatId` is the LINE userId, `threadId` is the Paperclip issue id, and the bridge generates `sessionId` client-side (matching the Telegram reference implementation).
* `plugin.paperclip-plugin-line.acp-message` — subsequent turns, payload `{ sessionId, text }`.
* `plugin.paperclip-plugin-line.acp-close` — on idle close, `line.close_thread`, or operator close, payload `{ sessionId }`.

The bridge subscribes to `plugin.paperclip-plugin-acp.output` and relays `type: "text"` and `type: "error"` frames back to LINE through the same push pipeline as `line.push_text`. ACP output relays carry `source: "acp_relay"` in telemetry and bypass the daily push budget (the agent's reply is the user's reply, not a tool-initiated outbound message). Per-tenant routing is governed entirely by which `agentId` your `onProvisionPrincipal` hook returns: an agentId that the host has registered runs natively; anything else (e.g. `"claude"`, `"gemini"`) routes via ACP.

ACP operational counters (`acpSpawned`, `acpMessages`, `acpClosed`, `acpOutputRelayed`, `acpOutputDropped`) appear in both the `line-ops` data source and the `onHealth` snapshot.

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

Tests are written with Vitest and cover signature verification, webhook queueing, push tool error paths, attachment upload, idle-close, reply-token GC, and push-limit accounting.

## Contributing

Bug reports, feature requests, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and the [Code of Conduct](CODE_OF_CONDUCT.md). All discussion happens in [GitHub Issues](../../issues) and [Discussions](../../discussions).

## Related

* [Paperclip](https://github.com/paperclipai/paperclip) — the agent platform this plugin extends
* [paperclip-plugin-discord](https://github.com/mvanhorn/paperclip-plugin-discord) — sister plugin for Discord
* [LINE Messaging API docs](https://developers.line.biz/en/docs/messaging-api/)

## License

[MIT](LICENSE)

## Maintainers

Maintained by [Bandruption](https://bandruption.com) — primarily [@harleyjj](https://github.com/harleyjj) and [@mistermatt2u](https://github.com/mistermatt2u). Initial implementation by the Bandruption platform team; ongoing maintenance and review happens in this repo. Community contributions land via PR.
