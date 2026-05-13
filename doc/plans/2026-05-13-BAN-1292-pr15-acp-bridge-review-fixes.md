# BAN-1292 PR 15 ACP Bridge Review Fixes

## Final Rename Addendum

Board approval `2e391842-c9b7-44bc-b7b5-d46f2d650765` supersedes the original
`line-bridge` / `0.2.0` namespace decision below. PR head
`45678a22b180ddb9ff3506d77be4e6a9a558f23f` intentionally renames the runtime
`manifest.id` to `paperclip-plugin-line` and bumps the plugin package/manifest
version to `1.0.0` so LINE follows the existing
`paperclip-plugin-{telegram,slack,discord}` convention.

Final ACP bus topics are:

- `plugin.paperclip-plugin-line.acp-spawn`
- `plugin.paperclip-plugin-line.acp-message`
- `plugin.paperclip-plugin-line.acp-close`

This is a breaking operational migration for existing installs: operators must
reinstall/reconfigure the plugin and update the LINE Developers Console webhook
URL from `/api/plugins/line-bridge/webhooks/line-webhook` to
`/api/plugins/paperclip-plugin-line/webhooks/line-webhook`.

The upstream ACP companion must therefore listen to `paperclip-plugin-line`
and continue honoring caller-supplied ACP `sessionId` values.

## Problem Restatement

PR 15 adds a non-trivial native-first / ACP-fallback LINE bridge, but review found that the first version could not be approved because it assumed the wrong ACP event namespace, wrote ACP agent names into native Paperclip issue assignment, routed ACP output by an instance-wide binding index instead of the event company boundary, and shipped incomplete release metadata. The fix is successful when LINE ACP fallback remains native-safe, tenant-scoped, version-consistent, and explicitly coordinated with upstream `paperclip-plugin-acp`.

## Chosen Approach

- Use `paperclip-plugin-line` as this plugin's manifest id and document ACP bus topics as `plugin.paperclip-plugin-line.acp-*`.
- Preserve caller-supplied ACP session ids in LINE and coordinate the matching upstream ACP change that listens to `paperclip-plugin-line` and honors the supplied `sessionId`.
- Remove the instance-wide ACP binding index; route ACP output by `event.companyId + payload.sessionId`, and reject mismatched `payload.threadId`.
- Branch issue-assignment handling by delivery mode so only runnable native Paperclip agents are written to `assigneeAgentId`.
- Treat existing but non-runnable native agents as unavailable instead of falling through to ACP.
- Add the missing `1.0.0` changelog, npm lockfile version sync, and least-privilege CI permissions.

## Alternatives Considered

- Change LINE to wait for an ACP-generated session id. Rejected for this PR because current upstream ACP does not emit a session-created handshake, so the first LINE user turn would still have no deterministic session target.
- Keep the instance-wide binding index and serialize writes with a global lock. Rejected because event-envelope routing by company id is simpler and removes the cross-tenant lookup surface.

## Verification Plan

- Unit/regression coverage for cross-company ACP output drops, thread-id mismatch drops, no global binding index, ACP fallback issue ownership, and paused native-agent routing.
- Local verification: `npm run typecheck`, `npm test`, `npm run build`, and `git diff --check`.
- Upstream ACP compatibility verification: `npm run typecheck`, `npm test`, and `npm run build` on the companion ACP patch.
- Required manual smoke before final release approval: Paperclip dev instance with LINE branch plus the exact ACP branch/SHA installed, covering ACP fallback round-trip and native path no-ACP-events invariant.

## Risks And Rollback

- Risk: upstream ACP coordination is not merged before LINE `1.0.0`; rollback by holding the LINE release or installing the documented ACP branch/SHA with the LINE bridge.
- Risk: a paused native agent causes skipped LINE delivery instead of ACP fallback; this is intentional to preserve native ownership semantics and should be resolved by resuming/reassigning the native agent.
- Rollback: revert PR 15 or disable ACP fallback by configuring LINE principals only to native runnable Paperclip agents.
