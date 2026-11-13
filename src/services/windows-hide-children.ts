// Windows: the agent runs from a scheduled task with no console of its own, so
// every console-subsystem child it starts (git, docker, ...) without
// `windowsHide: true` gets its own visible console window that flashes up and
// closes again. There are ~190 spawn sites; rather than trusting each to remember
// the flag, default it once, process-wide. A caller that sets `windowsHide`
// itself (true or false) is left alone. A no-op on every other platform.
//
// This must run BEFORE any module captures `promisify(execFile)` at module
// scope (that captures `execFile[promisify.custom]` at that moment), so
// server.ts imports `./windows-hide-install.js` as its first import.
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

const METHODS = ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync"] as const;

const patched = new WeakSet<object>();

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Returns `args` with `windowsHide: true` defaulted into the options object
 * (the first plain object after the command), or an options object put in
 * place of an explicit `undefined`/`null` just before the trailing callback,
 * or inserted there / at the end when there is no such slot. */
export function withWindowsHide(args: unknown[]): unknown[] {
  const out = [...args];
  const cbIndex = out.findIndex((a, i) => i > 0 && typeof a === "function");
  const end = cbIndex === -1 ? out.length : cbIndex;
  for (let i = 1; i < end; i++) {
    const arg = out[i];
    if (isPlainObject(arg)) {
      if (!("windowsHide" in arg)) out[i] = { ...arg, windowsHide: true };
      return out;
    }
  }
  const last = end - 1;
  if (last >= 1 && (out[last] === undefined || out[last] === null)) {
    out[last] = { windowsHide: true };
  } else {
    out.splice(end, 0, { windowsHide: true });
  }
  return out;
}

/** Patches `target` (default: `node:child_process`) once. `platform` and
 * `target` are injectable for tests; only the real module is re-synced to the
 * ESM named exports. Returns whether it patched. */
export function installWindowsHideDefault(
  platform: string = process.platform,
  target: object = childProcess,
): boolean {
  if (platform !== "win32" || patched.has(target)) return false;
  patched.add(target);
  const cp = target as Record<string, (...a: unknown[]) => unknown>;
  for (const name of METHODS) {
    const original = cp[name];
    if (typeof original !== "function") continue;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      return original.apply(this, withWindowsHide(args));
    };
    // exec/execFile carry a util.promisify.custom implementation (resolves to
    // {stdout, stderr}, rejects with them attached, and exposes `.child`).
    // Node's own closes over its internal function, so delegating to it would
    // skip this wrapper; reimplement it on top of `wrapped` instead.
    if (typeof (original as unknown as Record<symbol, unknown>)[promisify.custom] === "function") {
      Object.defineProperty(wrapped, promisify.custom, {
        value: (...args: unknown[]) => {
          let child: unknown;
          const promise = new Promise((resolve, reject) => {
            child = wrapped(...args, (err: unknown, stdout: unknown, stderr: unknown) => {
              if (err) {
                Object.assign(err as object, { stdout, stderr });
                reject(err);
              } else {
                resolve({ stdout, stderr });
              }
            });
          });
          (promise as Promise<unknown> & { child?: unknown }).child = child;
          return promise;
        },
      });
    }
    cp[name] = wrapped;
  }
  // Named ESM imports of a builtin are snapshots until re-synced.
  if (target === childProcess) syncBuiltinESMExports();
  return true;
}
