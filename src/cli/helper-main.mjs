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
// Round 4 (issue #871, real-Windows-runner failure) — `helper install`
// exits 1 with zero diagnostic output on windows-latest CI, even though
// every path in installWindows()/runHelper() writes a message before
// returning a non-zero code. Root-caused via CI log timestamps: the ONLY
// output that ever appeared was `warnIfNotPaired`'s message, written well
// BEFORE `installWindows` runs — meaning something inside/under
// `installWindows` threw an exception that became an unhandled rejection,
// and the `unhandledRejection` handler below's own
// `process.stderr.write(...); process.exit(1)` pair truncated its OWN
// diagnostic message before the write reached the OS pipe (Node's
// documented `process.exit()` behavior: it does not wait for pending
// stdout/stderr writes on non-TTY destinations). A prior fix attempt
// changed the two NORMAL exit paths below from `process.exit()` to
// `process.exitCode = ...; return;`, which made no observable difference
// — expected in hindsight, since neither of those paths was the one
// actually truncating anything; the crash always went through this
// `unhandledRejection` handler, untouched by that attempt. The two normal
// paths use `process.exitCode` here (letting Node exit naturally once the
// event loop drains, which flushes every pending write from anywhere in
// the call graph, not just a write this file can see directly) now that
// spawnDetachedHelper (ssh-agent-helper-install.mjs) no longer leaves a
// stray `child` listener registered past its own Promise settling — that
// leftover listener was the plausible source of a *later* unhandled
// rejection firing after this IIFE had already returned.
(async () => {
  // Issue #1061: defense-in-depth. runHelper() already catches every
  // rejection and translates it to an exit code (see ssh-agent-helper.mjs's
  // own runHelper), so a real escape from this IIFE is unlikely today —
  // but Node 22+'s default is to terminate the process on an unhandled
  // rejection, and the supervisor would just restart the helper without
  // surfacing the root cause. Catching it here logs the rejection to
  // stderr and exits 1, which the supervisor already treats as "retryable
  // crash", and gives an operator reading the helper log something
  // diagnosable. The exit is gated on the write's own completion callback
  // — not a bare `process.exit(1)` right after — specifically so THIS
  // message survives on a piped (non-TTY) stderr, the exact failure mode
  // this whole comment block documents.
  process.on("unhandledRejection", (reason) => {
    const message = `unhandledRejection in helper main: ${reason instanceof Error ? reason.stack : String(reason)}\n`;
    process.stderr.write(message, () => process.exit(1));
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
