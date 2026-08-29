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
// in every supervisor job on every platform — so `buildWindowsTaskXml`
// needs no SEA-specific verb/noun handling beyond dropping the scriptPath
// token (see that file's own comment).
import { runHelper, buildHelperIo } from "./ssh-agent-helper.mjs";

// No top-level await: esbuild bundles this to CJS (scripts/build-helper-
// sea.mjs's own comment explains why CJS, not ESM, for the SEA), and CJS
// has no top-level await at all — an async IIFE is the plain-JS
// equivalent that survives that bundle.
(async () => {
  const [noun, verb, ...args] = process.argv.slice(2);
  if (noun !== "helper") {
    process.stderr.write(
      `unknown command: ${noun ?? "(none)"} — this binary only understands 'helper <pair|run|install|uninstall>'.\n`,
    );
    process.exit(2);
  }

  const code = await runHelper(verb, args, buildHelperIo());
  process.exit(code);
})();
