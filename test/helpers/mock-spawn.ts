import { vi } from "vitest";
import { EventEmitter } from "node:events";
import type * as ChildProcess from "node:child_process";

// Same hoisting story as mock-pty.ts: this helper is meant to be called
// *from inside* a file's own `vi.mock("node:child_process", async
// (importOriginal) => { ... })` factory, not to replace that call — e.g.:
//
//   vi.mock("node:child_process", async (importOriginal) => {
//     const actual = await importOriginal<typeof ChildProcess>();
//     return mockChildProcessSpawn(actual, { passthrough: ["git"] });
//   });
//
// Import ordering matters (see mock-pty.ts's header for the empirically
// confirmed failure mode): put `import { mockChildProcessSpawn } from
// "../helpers/mock-spawn.js"` before any other import in the file that
// could itself trigger loading "node:child_process" — including a plain
// `import { execFileSync } from "node:child_process"` elsewhere in the
// same file.
//
// Surveying this suite's ~30 `vi.mock("node:child_process", ...)` call
// sites, the real variance is which commands get fake-vs-real treatment,
// not the shape of the fake itself (an EventEmitter that fires a success
// event on the next tick) — a handful of files (agent-detect.test.ts,
// actions.test.ts, agents.test.ts, internal.test.ts,
// projects-dev-server-detect.test.ts) also fake command-specific stdout
// content (e.g. `command -v claude` output, `systemctl is-active` replies),
// which is specific enough per-file that it isn't worth generalizing here —
// those files are expected to keep hand-rolling their `spawn` factory, optionally
// still using this helper's `actual.spawn` passthrough for the commands
// they don't care about faking.
export interface MockSpawnOptions {
  /** Commands that pass through to the real `spawn`; every other command is
   * faked with an immediate success event. Mutually exclusive with `fake`. */
  passthrough?: string[];
  /** Commands that are faked with an immediate success event; every other
   * command passes through to the real `spawn`. Mutually exclusive with
   * `passthrough`. If neither `passthrough` nor `fake` is given, every
   * command is faked (the common case — see plainNodePtyMock's sibling
   * default in mock-pty.ts). */
  fake?: string[];
  /** Event the fake child emits to signal completion. Most call sites use
   * the default "exit"; a few (cli.e2e.test.ts, mullion.test.ts,
   * multi-host-preview.test.ts) also need/prefer "close". */
  event?: "exit" | "close";
  /** Exit code the fake child reports. Defaults to 0 (success). */
  exitCode?: number;
}

/** Builds the `node:child_process` module replacement object — spread the
 * real module's exports (`actual`) with a faked/passthrough `spawn`,
 * per `opts`. See the file header for the expected call shape. */
export function mockChildProcessSpawn(
  actual: typeof ChildProcess,
  opts: MockSpawnOptions = {},
): typeof ChildProcess {
  const { passthrough, fake, event = "exit", exitCode = 0 } = opts;
  if (passthrough && fake) {
    throw new Error("mockChildProcessSpawn: pass only one of passthrough/fake, not both");
  }

  const spawn = vi.fn((command: string, args?: readonly string[], options?: object) => {
    const shouldFake = passthrough
      ? !passthrough.includes(command)
      : fake
        ? fake.includes(command)
        : true;

    if (!shouldFake) {
      return actual.spawn(command, args as string[], options as ChildProcess.SpawnOptions);
    }

    const ee = new EventEmitter();
    setImmediate(() => ee.emit(event, exitCode));
    return ee;
  });

  return { ...actual, spawn: spawn as unknown as typeof ChildProcess.spawn };
}
