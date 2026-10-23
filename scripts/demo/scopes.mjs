import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { extractDtachSocketPath, ownsScope } from "./env.mjs";

/** Teardown of the demo's session scopes; used by ./instance.mjs. */

const execFileAsync = promisify(execFile);

// Bounded like the backend's own calls (SYSTEMCTL_TIMEOUT_MS in
// src/services/systemctl-runner.ts, #1232): a wedged user bus must not hang
// teardown, and with it Ctrl-C on `make demo`.
const systemctl = (args) => execFileAsync("systemctl", ["--user", ...args], { timeout: 5_000 });

/** No systemctl, or systemctl without a user bus (CI, a plain container). */
const noUserBus = (err) =>
  err.code === "ENOENT" || /Failed to connect to bus/i.test(`${err.stderr ?? ""} ${err.message}`);

/**
 * Stops the demo's own session scopes. Every `crs-session-*` scope is checked
 * with the backend's own ownership rule (ownsScope in ./env.mjs, mirroring
 * src/services/session-process.ts): its Description names the dtach socket,
 * which must sit in one of this demo's OWNED sessions dirs. Only those are
 * stopped, so a real instance's scopes on the same host are never touched,
 * even on an instanceId collision.
 *
 * Returns the units it could not account for (listing or stop failed, or a
 * unit in the demo's namespace whose socket can't be read), so the caller can
 * keep the scratch dir instead of deleting it under live scopes.
 */
export async function stopDemoScopes(instanceId, sessionsDir, run = systemctl) {
  // Same probe as isSystemctlUserAvailable() in session-process.ts. Without a
  // user bus at all the backend can't have created scopes, so there is nothing
  // to stop; any other failure (a timeout, a reset bus) may hide live ones.
  try {
    await run(["show-environment"]);
  } catch (err) {
    if (noUserBus(err)) return [];
    console.warn(`[demo] could not reach the systemd user bus: ${err.message}`);
    return ["crs-session-*"];
  }
  let units;
  try {
    const { stdout } = await run([
      "list-units",
      "crs-session-*",
      "--type=scope",
      "--all",
      "--no-legend",
      "--plain",
    ]);
    units = stdout
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean);
  } catch (err) {
    // The bus answered and a non-matching pattern exits 0: a real failure.
    console.warn(`[demo] could not list crs-session-* scopes: ${err.message}`);
    return ["crs-session-*"];
  }
  const ownNamespace = `crs-session-${instanceId}-`;
  const failed = [];
  for (const unit of units) {
    try {
      const { stdout } = await run(["show", unit, "--property=Description", "--value"]);
      // For a unit that is gone, systemd echoes its name as the Description.
      if (stdout.trim() === unit) continue; // Exited since the listing.
      // The ownership SET, like the backend's (issue #1770): the demo's own
      // sessions dir plus every fallback root an earlier release shipped for
      // the same configured path. The demo's SESSIONS_DIR is short enough to
      // never need the fallback, so this is that one dir today.
      if (ownsScope(stdout, new Set([sessionsDir]))) {
        await run(["stop", unit]);
      } else if (unit.startsWith(ownNamespace)) {
        if (extractDtachSocketPath(stdout) === null) {
          // The backend calls this "unverifiable", not dead: report, don't guess.
          console.warn(`[demo] cannot verify ${unit}: no dtach socket in its description`);
          failed.push(unit);
        } else {
          console.warn(`[demo] not stopping ${unit}: its socket is outside ${sessionsDir}`);
        }
      }
    } catch (err) {
      if (/not loaded|not found/i.test(err.stderr ?? "")) continue; // Exited meanwhile.
      console.warn(`[demo] could not stop ${unit}: ${err.message}`);
      failed.push(unit);
    }
  }
  return failed;
}
