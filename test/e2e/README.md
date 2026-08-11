# Phase 4 socket API — end-to-end verification suite (issue #407)

Phase 4 (the Unix control socket, the `mullion` CLI, and browser automation
over the socket — see `docs/socket-api.md` and `docs/cli.md`) shipped fully
unit/integration-tested via `app.inject()` and a mocked Playwright `Page`
(`test/plugins/control-socket.test.ts`, `test/cli/mullion.test.ts`,
`test/routes/browser-automation.test.ts`, ...), but its own plan document's
manual **Verification** checklist — a raw socket smoke test, the full CLI
sequence, all 20 browser actions against a real page, persistence across a
backend restart, multi-host proxying, and a handful of security checks — was
never executed against a live instance. This directory automates everything
on that checklist that doesn't require a human at a keyboard or a real
`systemd --user` + `dtach` process tree.

## Running it

```
make test-e2e
```

(equivalently `npm run test:e2e`, or `vitest run -c vitest.e2e.config.ts`
directly). This needs a real Chromium available locally — if
`~/.cache/ms-playwright/` is empty, run `npx playwright install chromium`
first.

## Why this is NOT part of `make test` (but IS part of CI)

- `vitest.config.ts` (the default backend suite, run by `npm test` at the
  repo root and — as one half of both workspaces — by `make test`) excludes
  `test/e2e/**` outright — these tests boot real Unix sockets, spawn a real
  `mullion.mjs` child process, and launch a real headless Chromium, which is
  both meaningfully slower and has a real dependency (a Playwright browser
  install) the fast, mocked default suite must never need. Every developer's
  own `make test`/`npm test` run stays fast and dependency-free.
- **It does now run in CI** (issue #407 / B3), via `.github/workflows/ci-cd.yml`'s
  `test-e2e` job — but as a real, custom multi-step job (checkout, `npm ci`,
  `npx playwright install --with-deps chromium`, `npm run test:e2e`), not a
  `with:` parameter to the shared `ci-node.yml` reusable workflow that
  `test-node`/`test-frontend` use: that reusable job has no hook to run an
  arbitrary setup command (like installing a browser) before its own Test
  step, and this repo can't add one without editing the upstream
  `s3ntin3l8/.github` repo. `test-e2e` is deliberately **not yet** a required
  branch-protection status check — give it a run of real, unattended CI
  before gating every merge on it.
- **Running it locally from inside a Mullion-hosted session**: scrub the
  inherited `MULLION_*` env vars first (`MULLION_SOCKET_PATH`,
  `MULLION_HOOK_SOCKET`, `MULLION_SESSION_ID`, ...) — otherwise a
  `buildApp()` call in this suite can misidentify (or, depending on timing,
  collide with) the _hosting_ Mullion instance's own control/hook sockets,
  the same class of hazard documented for `npm run dev` elsewhere in this
  repo. CI runners don't have this problem (no ambient Mullion instance),
  but a local run from a live session will. This is separate from (and was
  found while chasing) a real bug this PR also fixed:
  `multi-host.e2e.test.ts` builds two `buildApp()` instances (primary +
  agent) in the _same_ process, and `test/setup.ts` sets `SESSIONS_DIR`
  once per test file — so both instances used to fight over the same
  `hooks.sock`/control-socket path regardless of any ambient env leak. Each
  instance now gets its own `SESSIONS_DIR`, same pattern as their already-
  distinct `DATABASE_URL`/`BROWSER_DATA_DIR`; this never occurs in a real
  deployment, where primary and agent are always separate hosts.
- Re-run it by hand after any change that touches
  `src/plugins/control-socket.ts`, `src/cli/*.mjs`, or
  `src/routes/browser-automation.ts` even though CI now also covers it —
  CI's feedback loop is slower than a local run.

## What's covered, file by file

- **`control-socket.e2e.test.ts`** — raw handshake + `ping` over a real Unix
  socket connection; the socket file's real on-disk mode is `0600`
  (`statSync`, not `stat` shelled out); a real >100-call-in-a-minute burst of
  `sessions.list` does not `429` (the rate-limit `allowList` exemption); and
  `buildSessionEnv()` actually scrubs `MULLION_AUTH_TOKEN` (and the rest of
  `SERVER_ENV_KEYS`) from what a spawned session's env would contain.
- **`cli.e2e.test.ts`** — the full advertised sequence — `mullion config`,
  `mullion ps --json`, `mullion session create`, `mullion logs`,
  `mullion events tail` (a real `title_change` event, interrupted cleanly
  with `SIGINT`), `mullion session kill` — each run as the real spawned CLI
  process against one real server.
- **`browser-actions.e2e.test.ts`** — all 20 browser actions (`navigate`,
  `snapshot`, `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`,
  `hover`, `scroll`, `wait`, `dialog`, `get`, `eval`, `screenshot`, `find`,
  `console`, `errors`, `download`) against a real (unmocked) Playwright
  Chromium page, served from a real `http.createServer` fixture
  (`support/fixture-page-server.ts`) with a form, a `confirm()`/`prompt()`
  dialog, its own `console.log`/thrown error to verify capture, and a real
  `Content-Disposition: attachment` download route. `dialog`'s two cases are
  written to be discriminating (the un-armed default already auto-accepts
  `confirm()`, so a test that only proves "accept doesn't error" would pass
  even if the action did nothing) and `screenshot`'s result is checked by
  real PNG magic bytes, not just "non-empty base64". `download`'s test
  clicks the link that triggers the real download (proving the launch-time
  listener design — the event fires during that PRECEDING click, not during
  the `download` call itself) and round-trips its real file contents through
  base64 `contents`.
- **`multi-host.e2e.test.ts`** — a `browser.action`/`browser.find` call
  proxied from a primary `buildApp()` instance through `RemoteHostClient` to
  a second, `MULLION_ROLE=agent` `buildApp()` instance's real Chromium — the
  one path neither `test/integration/multi-host.test.ts` (pty proxying only)
  nor `test/routes/browser-automation.test.ts` (local browser only)
  exercises.

## What stays manual (see issue #407's own checklist)

Two checklist items are **not** automated here, and issue #407 should stay
open after this suite merges until a human runs them by hand:

1. **Persistence across a backend restart** — restarting the Mullion process
   mid-`mullion session exec` and confirming the session survives via the
   real `dtach` + `systemd --user` scope, then re-attaches cleanly. This
   needs an actual `systemd --user` session and a real `dtach` binary on the
   host; nothing in this repo's test environment can safely fake that
   without either mocking away the exact mechanism under test or running
   destructive operations against a real systemd instance.
2. **Stale-socket-rebind after a hard kill** — `pkill -9` the backend
   process, restart it, and confirm the previously-stale `mullion.sock` is
   unlinked and re-bound rather than the new process failing to start. This
   requires killing and restarting an actual OS process, not something a
   Vitest test running inside one process can reproduce.
