# Changelog

All notable changes to this project will be documented in this file. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
