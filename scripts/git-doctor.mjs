#!/usr/bin/env node
// Reports — and, with --apply, repairs — git object damage in this clone.
//
// Issue #1836 — a background `git gc` in a clone that several agents push to
// concurrently can delete a loose object that a concurrent write is creating.
// The repack sequence is pack-then-unlink: an object written *after* the pack
// was built but *before* the unlink is removed without being in the pack.
//
// The symptom is a zero-byte file where a loose object should be. Git then
// reports the object as *missing* rather than corrupt, so the error points at
// the wrong thing: "fatal: invalid sha1 pointer" or a commit that cannot
// complete, naming an object that a concurrent write had just created.
//
// The repair moves every zero-byte loose object out of the way (never deletes
// it), restores the refs from the remote, and rebuilds the affected worktree
// indexes. The procedure was validated by hand on a damaged clone.
//
// The logic lives in src/services/git-doctor.ts, so the app can offer the
// read-only half as a project action; this file is the CLI over it.
//
// Usage:
//   node --import tsx scripts/git-doctor.mjs [path]              # report only — never mutates
//   node --import tsx scripts/git-doctor.mjs --apply [path]      # repair
//   node --import tsx scripts/git-doctor.mjs --apply --force [path]   # repair, even with staged work
//
// `path` is the clone to work on. It defaults to the current directory, so
// running this from inside a clone inspects that clone — but it can be given
// explicitly, which is what you want when the clone you are repairing is NOT
// the one you are standing in (a project you have open in Mullion, say).
//
// Exit codes — two questions, two answers:
//
//   0 — the clone is healthy, or the repair made it whole.
//   1 — damage was found (report mode), or the clone is still not whole.
//   2 — the clone is whole again, but some objects could not be recovered:
//       they were never committed and are not on the remote, so nothing
//       references them any more and fsck has nothing to complain about.

import path from "node:path";

// The doctor's logic lives in src/services/git-doctor.ts. A checkout has that
// source and runs this script through tsx (`node --import tsx`); a RELEASE
// install does not — the payload ships dist/ but not src/, and tsx is a
// devDependency that `npm ci --omit=dev` never installs. There, the compiled
// module in dist/ is the one that exists, so it is the fallback.
//
// The source is tried FIRST: in a checkout it is the truth, and a stale
// dist/ would silently be an older doctor.
//
// The fallback is taken ONLY for "this module does not exist here" — a
// missing file (a release install) or an extension plain node cannot load (a
// checkout run without tsx). Any other failure — a syntax error, a broken
// import inside the source — is rethrown: silently falling back to dist/
// there would run an OLD doctor over someone's clone and say nothing.
let runGitDoctor;
try {
  ({ runGitDoctor } = await import("../src/services/git-doctor.ts"));
} catch (err) {
  const code = err?.code;
  const sourceAbsent = code === "ERR_MODULE_NOT_FOUND" || code === "ERR_UNKNOWN_FILE_EXTENSION";
  if (!sourceAbsent) {
    console.error(
      "git-doctor: the doctor's source module could not be loaded:\n" +
        `  ${err?.message ?? err}\n` +
        "  This is not a missing module, so the compiled copy in dist/ is NOT used here —" +
        " it could be an older doctor.",
    );
    process.exit(1);
  }
  try {
    ({ runGitDoctor } = await import("../dist/services/git-doctor.js"));
  } catch {
    console.error(
      "git-doctor: the doctor's module could not be loaded.\n" +
        "  In a checkout:  node --import tsx scripts/git-doctor.mjs   (or: make git-doctor)\n" +
        "  In a release install: the compiled module is dist/services/git-doctor.js —\n" +
        "  this install has neither.",
    );
    process.exit(1);
  }
}

const args = process.argv.slice(2);
const apply = args.includes("--apply");
const force = args.includes("--force");

if (args.includes("--help") || args.includes("-h")) {
  console.log(
    "Usage: node scripts/git-doctor.mjs [--apply] [--force] [path]\n\n" +
      "  (no flags)  report damage; never mutates anything\n" +
      "  --apply     repair: quarantine the zero-byte objects, restore the refs,\n" +
      "              rebuild the affected worktree indexes\n" +
      "  --force     rebuild the indexes even when there is staged work\n" +
      "  path        the clone to work on (default: the current directory)\n\n" +
      "In a checkout, run it through tsx: `node --import tsx scripts/git-doctor.mjs`\n" +
      "(or `make git-doctor`). In a release install, plain `node` is enough.\n\n" +
      "Exit codes: 0 whole, 1 not whole, 2 whole again but objects were lost.",
  );
  process.exit(0);
}

// The first argument that is not a flag is the clone to work on. Anything
// else (a second path, say) is ignored rather than guessed at.
const target = path.resolve(args.find((arg) => !arg.startsWith("-")) ?? process.cwd());

process.exit(await runGitDoctor(target, { apply, force, log: (line) => console.log(line) }));
