// Windows: the agent runs from a scheduled task with no console of its own, so
// every console-subsystem child it starts (git, docker, ...) without
// `windowsHide: true` gets its own visible console window that flashes up and
// closes again. There are ~190 spawn sites; rather than trusting each to remember
// the flag, default it once, process-wide. A caller that sets `windowsHide`
// itself (true or false) is left alone. A no-op on every other platform.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const METHODS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"] as const;

let installed = false;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns `args` with `windowsHide: true` defaulted into the options object
 * (the first non-array object after the command), or a new options object
 * inserted before a trailing callback / at the end when there is none. */
export function withWindowsHide(args: unknown[]): unknown[] {
  const out = [...args];
  for (let i = 1; i < out.length; i++) {
    const arg = out[i];
    if (isPlainObject(arg)) {
      if (!("windowsHide" in arg)) out[i] = { ...arg, windowsHide: true };
      return out;
    }
  }
  const cbIndex = out.findIndex((a, i) => i > 0 && typeof a === "function");
  out.splice(cbIndex === -1 ? out.length : cbIndex, 0, { windowsHide: true });
  return out;
}

/** Patches `node:child_process` once. `platform` is injectable for tests. */
export function installWindowsHideDefault(platform: string = process.platform): boolean {
  if (platform !== "win32" || installed) return false;
  installed = true;
  const cp = childProcess as unknown as Record<string, (...a: unknown[]) => unknown>;
  for (const name of METHODS) {
    const original = cp[name];
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, withWindowsHide(args));
    };
    // exec/execFile carry a util.promisify.custom implementation (resolves to
    // {stdout, stderr}); the wrapper must keep it or promisify() breaks.
    const custom = (original as unknown as Record<symbol, unknown>)[promisify.custom];
    if (typeof custom === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args: unknown[]) =>
          (custom as (...a: unknown[]) => unknown).apply(original, withWindowsHide(args)),
      });
    }
    cp[name] = wrapped;
  }
  // Named ESM imports of a builtin are snapshots until re-synced.
  syncBuiltinESMExports();
  return true;
}
