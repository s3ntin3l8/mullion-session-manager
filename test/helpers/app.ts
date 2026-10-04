import { onTestFinished } from "vitest";
import type { FastifyInstance } from "fastify";

// The backend suite's ~76 `await buildApp()` call sites all follow the same
// shape: build the app inline in a test body, then remember to
// `await app.close()` before the test ends. `buildApp()`
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
// time) can be called from *inside* a running test and is guaranteed
// to run once that specific test finishes, pass or fail.
//
// This is why `buildTestApp()` only works from `it()`/`beforeEach()`
// bodies, not `beforeAll()`: Vitest only has a "current test" set while
// `runTest` is executing (`beforeAll`/`describe` bodies run inside
// `runSuite`, where none is set), so `onTestFinished` called from a
// `beforeAll` throws `Hook onTestFinished() can only be called inside a
// test` (verified against this repo's pinned Vitest). None of this
// PR's converted files call `buildTestApp()` from a `beforeAll` — every
// call sits inside an `it()` body, and the `beforeAll`s that exist do
// other setup (env vars, fixture dirs). A future conversion that needs
// one shared app across a whole `describe` block should keep using plain
// `buildApp()` + an explicit `afterAll(() => app.close())` instead.
//
// `app.close()` already cascades into `closeDb()` for primary-role apps
// (dbPlugin's own `onClose` hook, src/plugins/db.ts) — this helper doesn't
// need to call `closeDb()` itself. Agent-role apps never decorate `db` in
// the first place, so there's nothing to close either way.
//
// The "unforgettable close" guarantee also covers a build that is still in
// flight when the test's own timeout fires (issue #1481): the
// `onTestFinished` callback is registered synchronously, BEFORE the build
// is awaited, and it awaits the build promise itself (swallowing a build
// rejection — the caller already sees that one) before closing the app it
// produced. Registering only after `buildApp()` resolved used to be the gap:
// Vitest runs and clears a test's `onFinished` list when the test settles, so
// a build that resolved after a timeout registered into a list nobody ever
// ran, leaking that app's `hooks.sock` for every later `buildApp()` in the
// same file (SESSIONS_DIR is one directory per test file, see
// test/setup.ts) — a cascade of `SocketAlreadyListeningError`/`EADDRINUSE`
// far from the test that actually timed out.
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
  // Must be called before the first `await` (including the dynamic import):
  // `onTestFinished` is only valid while the test is still current.
  const build = import("../../src/app.js").then(({ buildApp }) => buildApp());

  let closed = false;
  onTestFinished(async () => {
    if (closed) return;
    closed = true;
    const app = await build.catch(() => null);
    await app?.close();
  });

  return build;
}
