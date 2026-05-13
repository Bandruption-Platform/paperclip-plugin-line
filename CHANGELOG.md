# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.0.0] - 2026-05-13

### Changed

- **BREAKING**: Renamed `manifest.id` from `line-bridge` to `paperclip-plugin-line` for ecosystem consistency with `paperclip-plugin-{telegram,slack,discord}`. Existing installs must re-install and re-point the LINE Developers Console webhook URL to `/api/plugins/paperclip-plugin-line/webhooks/line-webhook`. The previous URL `/api/plugins/line-bridge/webhooks/line-webhook` no longer resolves.
- Updated the release verification expectation: upstream `paperclip-plugin-acp` must list `paperclip-plugin-line` in `CHAT_PLATFORM_PLUGINS` so it subscribes to `plugin.paperclip-plugin-line.acp-{spawn,message,close}` and honors caller-supplied ACP `sessionId` values.

### Added

- Added the ACP fallback bridge for LINE principals whose resolved `agentId` is not registered natively, including `acp-spawn`, `acp-message`, `acp-close`, and `plugin.paperclip-plugin-acp.output` relay handling.
- Declared manifest permissions for `events.emit` and `events.subscribe` so ACP bus traffic is explicit and least-privilege.
- Added the plugin-scoped ACP state namespace and bindings used to persist ACP session routing state.
- Added ACP operational counters in `line-ops` and health snapshots for spawned sessions, relayed messages, closes, and dropped ACP output.

## [0.1.0]

Initial public release. First-class LINE Messaging API integration for Paperclip.

### Added

- Verified LINE webhook intake (HMAC-SHA256, fast-ACK).
- Inbound text and media routing into Paperclip issue threads.
- Persistent agent session per LINE user with idle-close.
- Outbound LINE tools: `line.push_text`, `line.push_image`, `line.push_flex`, `line.push_template`, `line.push_sticker`, `line.ack_with_reply_token`, `line.close_thread`, `line.get_profile`.
- Per-company, per-agent, per-UTC-day push limits.
- Reply-token caching with GC sweep.
- Single-tenant config (`defaultPaperclipCompany` + `defaultAgentId`).
- Optional multi-tenant `onProvisionPrincipal` and `onCloseThread` extension hooks.
- Operational telemetry under `line.*` counters.
