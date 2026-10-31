import path from "node:path";
import { resolveHooksDir } from "./hook-adapters/shared.js";

// Where a session finds Mullion's GitHub credential helper and `gh` wrapper
// (issue #2246). Both live in src/hooks/ (copied to dist/hooks/ by the build),
// resolved on the host that owns the session, so a remote host launches its
// own copy.

/** POSIX single-quote: safe inside the shell git runs a `!` helper through. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** The `credential.helper` value: git's `!` form, the host's own node binary
 * (a session's PATH may have none, same reason as MULLION_FORWARDER_NODE) and
 * the helper script. git appends the action (`get`/`store`/`erase`). */
export function githubCredentialHelperCommand(): string {
  const script = path.join(resolveHooksDir(), "git-credential-mullion.mjs");
  return `!${shellQuote(process.execPath)} ${shellQuote(script)}`;
}

/** The directory holding the `gh` wrapper, prepended to a session's PATH. */
export function githubWrapperBinDir(): string {
  return path.join(resolveHooksDir(), "bin");
}
