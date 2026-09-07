// Round 3 (PR2) — the entry point scripts/build-helper-sea.mjs bundles into
// `mullion-helper.exe` (Windows x64, Node SEA — see that script's own
// comment for the build pipeline and https://nodejs.org/api/single-
// executable-applications.html). Deliberately NOT `mullion.mjs`: that file
// imports MullionSocketClient (client.mjs) and wires up `mullion mcp`
// (runMcp, which resolves a sibling path via `fileURLToPath(import.meta.url)`
// — meaningless once bundled, since there is no `dist/mcp/server.mjs`
// sibling inside a single executable). This file touches none of that: a
// Node SEA answers only `helper <verb> [...args]`, nothing else `mullion`
// can do.
//
// Same argv shape as the tarball route (`node mullion.mjs helper <verb>
// ...`) and the same shape ssh-agent-helper-install.mjs's generators embed
// in every supervisor job on every platform — so `buildWindowsRunCommand`
// needs no SEA-specific verb/noun handling beyond dropping the scriptPath
// token (see that file's own comment).
import { runHelper, buildHelperIo } from "./ssh-agent-helper.mjs";

// No top-level await: esbuild bundles this to CJS (scripts/build-helper-
// sea.mjs's own comment explains why CJS, not ESM, for the SEA), and CJS
// has no top-level await at all — an async IIFE is the plain-JS
// equivalent that survives that bundle.
//
// Round 4 (issue #871, real-Windows-runner failure) — the two NORMAL exit
// paths below set `process.exitCode` and return rather than calling
// `process.exit()` directly. `process.exit()` does NOT wait for pending
// stdout/stderr writes to flush (Node's own docs: "the Node.js process
// will exit on its own if there is no additional work pending in the
// event loop" is the documented alternative, specifically for this
// reason) — on a real windows-latest CI runner, with stdout/stderr piped
// (not a TTY, where writes are more often synchronous), this silently
// truncated the exact diagnostic messages `installWindows`/
// `uninstallWindows` write on their way to a non-zero exit: `ci-cd.yml`'s
// `reg round trip` step saw `helper install` exit 1 with ZERO output,
// `warnIfNotPaired`'s own earlier write the only thing that ever reached
// the log. This never showed up in this file's own unit tests (a Linux
// dev/CI sandbox, stdio piped through an in-repo, plain-object
// `io.stdout`/`io.stderr` stub with no real OS pipe to race against) nor,
// apparently, reliably on prior releases' synchronous (no `await`)
// `installWindows` — the explicit `await spawnDetachedHelper(...)` this
// round introduced gives the race more real surface: more total write
// volume, and a write scheduled after an event-loop yield rather than in
// the same synchronous tick as the return. Letting the process exit
// naturally means every queued write actually drains first; nothing else
// in `pair`/`install`/`uninstall` keeps the event loop alive past their
// own return (spawnDetachedHelper's own child is `unref()`'d specifically
// so it doesn't), so this doesn't risk hanging the process either —
// `run`'s own long-running loop is unaffected, since it doesn't reach
// this line at all until ITS OWN internal stop condition already returns.
(async () => {
  // Issue #1061: defense-in-depth. runHelper() already catches every
  // rejection and translates it to an exit code (see ssh-agent-helper.mjs's
  // own runHelper), so a real escape from this IIFE is unlikely today —
  // but Node 22+'s default is to terminate the process on an unhandled
  // rejection, and the supervisor would just restart the helper without
  // surfacing the root cause. Catching it here logs the rejection to
  // stderr and exits 1, which the supervisor already treats as "retryable
  // crash", and gives an operator reading the helper log something
  // diagnosable.
  //
  // Deliberately still `process.exit()`, NOT `process.exitCode` like the
  // two paths below: this handler fires from OUTSIDE the main `await
  // runHelper(...)` flow at an unpredictable point — if it only set
  // `exitCode`, a still-pending `process.exitCode = await runHelper(...)`
  // below would silently overwrite it once that promise eventually
  // settles, erasing the fact that a genuine unhandled rejection happened.
  // An unhandled rejection means something escaped every intended error
  // boundary; terminating immediately (accepting this rare path's own
  // small truncation risk) is correct here, unlike the two ordinary exits
  // below which this comment's own reasoning applies to.
  process.on("unhandledRejection", (reason) => {
    process.stderr.write(
      `unhandledRejection in helper main: ${reason instanceof Error ? reason.stack : String(reason)}\n`,
    );
    process.exit(1);
  });

  const [noun, verb, ...args] = process.argv.slice(2);
  if (noun !== "helper") {
    process.stderr.write(
      `unknown command: ${noun ?? "(none)"} — this binary only understands 'helper <pair|run|install|uninstall>'.\n`,
    );
    process.exitCode = 2;
    return;
  }

  process.exitCode = await runHelper(verb, args, buildHelperIo());
})();
