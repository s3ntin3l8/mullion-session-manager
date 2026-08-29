// Round 3 (PR2) — split out of ssh-agent-helper-install.mjs specifically so
// the Node SEA build (scripts/build-helper-sea.mjs) can mark THIS file
// `external` to esbuild, keeping its `import.meta.url` usage out of the
// bundled output entirely. `import.meta.url` cannot be bundled to CJS at
// all (esbuild empties it, and --log-override:empty-import-meta=error turns
// that into a hard build failure) — and unlike defaultScriptPath()'s call
// site (gated on `!isSea`, never reached inside the SEA), esbuild's static
// analysis flags the bare SYNTACTIC OCCURRENCE of `import.meta` wherever it
// appears in the bundle graph, regardless of whether the surrounding
// function is ever actually called at runtime. Physically separating it —
// the same "hand-split module at a boundary the bundler can't cross"
// pattern ssh-agent-bridge-mux.mjs already uses for the WHATWG-vs-`ws`-
// package boundary — means the SEA's build never even parses this file, and
// the non-bundled (tarball/checkout) runtime imports it exactly as before,
// unaffected.
import path from "node:path";
import { fileURLToPath } from "node:url";

export function defaultScriptPath() {
  // Sibling of mullion.mjs — mullion.mjs itself, byte-identical in
  // dist/cli/ per package.json's build step.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "mullion.mjs");
}
