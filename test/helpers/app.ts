import { onTestFinished } from "vitest";
import type { FastifyInstance } from "fastify";

// The backend suite's ~76 `await buildApp()` call sites all follow the same
// shape: build the app inline in a test/beforeAll, then remember to
// `await app.close()` before the test/describe block ends. `buildApp()`
// itself takes no options — every call site configures it beforehand via
// `process.env`/`app.config` (see src/app.ts), not through arguments — so
// this helper doesn't accept any either; it exists purely to make the
// close step unforgettable, not to add a config surface `buildApp()`
// doesn't have.
//
// The real bug this fixes (see test/routes/projects.test.ts's own header
// comment): if a test throws *before* reaching its own `await app.close()`,
// that app's `hooks.sock` listener (plugins/hooks.ts) is never released.
// The NEXT `buildApp()` in the same suite run — same file or a later one —
// then fails with `SocketAlreadyListeningError`, a confusing failure with
// no obvious connection to the test that actually leaked. `onTestFinished`
// (unlike `afterEach`, which can only be registered at describe-collection
// time) can be called from *inside* a running test/hook and is guaranteed
// to run once that specific test finishes, pass or fail — exactly the
// per-call-site guarantee needed here, since every one of this suite's
// `buildApp()` calls happens inside an `it()`/`beforeAll()` body, not at
// collection time.
//
// `app.close()` already cascades into `closeDb()` for primary-role apps
// (dbPlugin's own `onClose` hook, src/plugins/db.ts) — this helper doesn't
// need to call `closeDb()` itself. Agent-role apps never decorate `db` in
// the first place, so there's nothing to close either way.
//
// One real limit on the "unforgettable close" guarantee: `onTestFinished`
// is only registered AFTER `buildApp()` resolves. If `buildApp()` itself
// hangs or is still in flight when the test's own timeout fires, this
// helper never gets a chance to register the close callback, and that
// build keeps running in the background — able to race a later test's own
// buildApp() over the same per-file `hooks.sock` (SESSIONS_DIR). This is
// not a regression versus the old hand-rolled `try/finally` pattern (that
// had the identical gap: no `app` reference exists to close if the build
// itself never returns) — just a pre-existing limit worth knowing about
// when a whole file's tests cascade-fail with SocketAlreadyListeningError
// under heavy parallel/CI load.
//
// Scope this to `it()`/`beforeEach()` bodies, not `afterEach()`: a handful
// of files (e.g. test/services/github-device-flow.test.ts) build a
// throwaway app inside their own `afterEach` purely to call a cleanup
// helper (e.g. `disconnect(app)`) against the shared per-file DB. Wiring
// THAT app through this helper too was tried and reverted — with several
// `it()`-body apps in the same file *also* using this helper, the
// `afterEach`-registered one produced intermittent hangs/`EADDRINUSE` on
// the shared per-file `hooks.sock` (SESSIONS_DIR is one directory per test
// file, not per app — see test/setup.ts), non-deterministically depending
// on onTestFinished callback interleaving across hooks. Root cause not
// fully isolated; empirically, plain `buildApp()` + an explicit, synchronous
// `await app.close()` inside `afterEach` (i.e. NOT this helper) is reliable
// for that specific "cleanup app built in a hook, not a test body" shape.
export async function buildTestApp(): Promise<FastifyInstance> {
  const { buildApp } = await import("../../src/app.js");
  const app = await buildApp();

  let closed = false;
  onTestFinished(async () => {
    if (closed) return;
    closed = true;
    await app.close();
  });

  return app;
}
