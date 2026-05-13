# Contributing to paperclip-plugin-line

Thanks for your interest in contributing. This plugin is maintained as a community project by [Bandruption](https://bandruption.com), and contributions of all sizes are welcome — bug fixes, docs improvements, new features, additional locales, and tests.

## Ground rules

- Be kind. See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
- This plugin is an integration layer between Paperclip and LINE. Changes should keep that scope. Generic agent-platform features belong upstream in [paperclipai/paperclip](https://github.com/paperclipai/paperclip); LINE-specific changes belong here.
- Backwards-compatible by default. The plugin instance config schema, tool names, and webhook keys are public surface. Breaking changes require a major version bump and a migration note.

## Reporting bugs

Before filing, please:

1. Check existing [issues](../../issues) and [discussions](../../discussions).
2. Verify against the latest published version on npm.
3. Include the plugin version, Paperclip version, Node version, and a minimal reproduction (a signed webhook payload or a tool-call trace is ideal).

Use the bug report template — it asks for the right things.

## Proposing features

Open a [discussion](../../discussions) before opening a PR for anything non-trivial. We want to talk through scope before you spend time implementing — especially for features that touch:

- The webhook signature path
- Push limit accounting
- Attachment storage layout
- The extension hook contract

Small features (new tool definitions, additional config fields, doc fixes) can go straight to a PR.

## Pull request flow

1. Fork and create a branch from `main`.
2. Make your change. Keep commits focused and well-described.
3. Add or update tests. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
4. If you change instance config, update the README config table and add a migration note in the PR description.
5. Open a PR against `main`. The PR template will prompt for the right details.
6. CI must pass. A maintainer will review within a few business days.

## Local development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

The plugin builds against `@paperclipai/plugin-sdk` from npm. To develop against an in-tree Paperclip checkout, link it via your package manager's overrides feature (e.g. `pnpm.overrides` in package.json) — don't commit those overrides.

## Testing against a live LINE channel

Use a LINE Messaging API channel in [free tier](https://developers.line.biz/en/docs/messaging-api/overview/#price) for integration testing. For local webhook testing, point the LINE Developers Console webhook URL at an [ngrok](https://ngrok.com/) or [cloudflared tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/) front for your local Paperclip instance:

```text
https://<your-tunnel>.example.com/api/plugins/paperclip-plugin-line/webhooks/line-webhook
```

Set the LINE channel to a sandbox bot account, not a customer-facing one.

## Style

- TypeScript strict mode.
- No runtime dependencies beyond `@paperclipai/plugin-sdk` unless discussed in advance.
- Format on save with the editor settings of your choice; we don't ship a formatter config to keep contributor friction low.
- Tests use [Vitest](https://vitest.dev/).

## Releasing

Maintainers cut releases. The flow:

1. Bump `version` in `package.json`.
2. Update `CHANGELOG.md`.
3. Tag the release commit `vX.Y.Z`.
4. `npm publish` (with a maintainer's npm token).

Releases are tagged on GitHub and auto-released to npm via the publish workflow.

## License

By contributing, you agree your contributions are licensed under the [MIT License](LICENSE).
