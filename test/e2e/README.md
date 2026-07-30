# Phase 4 socket API — end-to-end verification suite (issue #407)

Phase 4 (the Unix control socket, the `mullion` CLI, and browser automation
over the socket — see `docs/socket-api.md` and `docs/cli.md`) shipped fully
unit/integration-tested via `app.inject()` and a mocked Playwright `Page`
(`test/plugins/control-socket.test.ts`, `test/cli/mullion.test.ts`,
`test/routes/browser-automation.test.ts`, ...), but its own plan document's
manual **Verification** checklist — a raw socket smoke test, the full CLI
sequence, all 19 browser actions against a real page, persistence across a
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

## Why this is NOT part of `make test` / CI

- `vitest.config.ts` (the default suite `make test`/`npm test` run) excludes
  `test/e2e/**` outright — these tests boot real Unix sockets, spawn a real
  `mullion.mjs` child process, and launch a real headless Chromium, which is
  both meaningfully slower and has a real dependency (a Playwright browser
  install) the fast, mocked default suite must never need.
- `.github/workflows/ci-cd.yml` is a thin caller of the reusable
  `s3ntin3l8/.github` workflows — this repo has no control over whether
  Playwright's browsers are pre-installed (or installable) in that shared
  runner, so wiring `make test-e2e` into CI would make CI's pass/fail depend
  on infrastructure this repo doesn't own. Run it locally instead, and re-run
  it by hand after any change that touches `src/plugins/control-socket.ts`,
  `src/cli/*.mjs`, or `src/routes/browser-automation.ts`.

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
- **`browser-actions.e2e.test.ts`** — all 19 browser actions (`navigate`,
  `snapshot`, `click`, `fill`, `type`, `press`, `select`, `check`, `uncheck`,
  `hover`, `scroll`, `wait`, `dialog`, `get`, `eval`, `screenshot`, `find`,
  `console`, `errors`) against a real (unmocked) Playwright Chromium page,
  served from a real `http.createServer` fixture (`support/fixture-page-server.ts`)
  with a form, a `confirm()`/`prompt()` dialog, and its own `console.log`/
  thrown error to verify capture. `dialog`'s two cases are written to be
  discriminating (the un-armed default already auto-accepts `confirm()`, so a
  test that only proves "accept doesn't error" would pass even if the action
  did nothing) and `screenshot`'s result is checked by real PNG magic bytes,
  not just "non-empty base64".
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
