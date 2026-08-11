import { vi } from "vitest";

// `vi.mock()` factories are hoisted by Vitest above every other import in
// the file, including static imports of the module under test — that's
// *why* ~23 files across this suite currently hand-roll the exact same
// `vi.mock("node-pty", () => ({ ... }))` literal instead of importing a
// shared mock: the factory body itself is what gets hoisted, and it can't
// close over anything from a not-yet-evaluated outer scope. Both helpers
// below are designed to work *inside* that constraint rather than around
// it — callers wrap them in their own `vi.mock("node-pty", () => ...)` call
// at the file's own call site (so the hoist still applies to that call
// site, not to code inside this module), for example:
//
//   vi.mock("node-pty", () => plainNodePtyMock());
//
// or, for the listener-capturing variant:
//
//   const ptyMock = createNodePtyMock();
//   vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
//   // ...later, inside a test:
//   const [pty] = ptyMock.spawnedPtys;
//   pty.emitData("some output");
//
// `ptyMock` above is a plain top-level `const` initialized before the
// `vi.mock()` call in file order. That's safe (not a hoisting violation)
// because the mock *factory* only actually runs later, when "node-pty" is
// first imported — by which point this file's own top-level code has
// already finished running. This is the same pattern
// test/routes/sessions.test.ts's `fakePtyListeners` array already uses.
//
// One real gotcha, confirmed empirically: if THIS file also has its own
// static import of "node-pty" (directly, or transitively through another
// of its own imports), Vitest triggers the mock at THAT import's position
// in the file's own sequential evaluation order — not at whatever later
// point the module under test would have imported it. If this file's
// `import { plainNodePtyMock } from "../helpers/mock-pty.js"` sorts
// *after* that other import, the factory runs before the helper import's
// binding is initialized (`ReferenceError: Cannot access '...' before
// initialization`). The fix is ordering, not `vi.hoisted()`: put this
// import (and mock-spawn.js's, and app.js's) before every other import in
// the file that could touch "node-pty"/"node:child_process", even
// indirectly.

/** A `node-pty` `IPty`-shaped object whose `write`/`resize`/`kill` are spies
 * and whose registered `onData`/`onExit` listeners are exposed directly, so
 * a test can synthesize PTY output or an exit after the fact. */
export interface FakePtyHandle {
  write: ReturnType<typeof vi.fn>;
  resize: ReturnType<typeof vi.fn>;
  kill: ReturnType<typeof vi.fn>;
  /** Invoke every registered onData listener with `chunk`. */
  emitData(chunk: string): void;
  /** Invoke every registered onExit listener with `exitCode`. */
  emitExit(exitCode: number): void;
}

/** The plain, non-capturing `node-pty` mock — the exact literal block
 * duplicated across most of this suite's `vi.mock("node-pty", ...)` sites.
 * Every spawned PTY is a dead end: onData/onExit register but are never
 * invoked, matching tests that only care that *something* calls
 * `node-pty.spawn` and returns a well-shaped handle, not what it does. */
export function plainNodePtyMock() {
  return {
    spawn: vi.fn(() => ({
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
    })),
  };
}

/** The listener-capturing `node-pty` mock (see test/routes/sessions.test.ts
 * and test/services/pty-manager.test.ts for the hand-rolled originals):
 * every `spawn()` call is recorded in `spawnedPtys`, in call order, with its
 * registered onData/onExit listeners reachable so a test can push
 * synthetic output through a specific session's PTY, or simulate it
 * exiting, after the session already exists. */
export function createNodePtyMock() {
  const spawnedPtys: FakePtyHandle[] = [];

  const spawn = vi.fn(() => {
    const dataListeners: Array<(data: string) => void> = [];
    const exitListeners: Array<(e: { exitCode: number }) => void> = [];

    const handle: FakePtyHandle = {
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(() => handle.emitExit(0)),
      emitData: (chunk: string) => {
        for (const cb of dataListeners) cb(chunk);
      },
      emitExit: (exitCode: number) => {
        for (const cb of exitListeners) cb({ exitCode });
      },
    };
    spawnedPtys.push(handle);

    return {
      onData: (cb: (data: string) => void) => {
        dataListeners.push(cb);
        return { dispose: () => {} };
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        exitListeners.push(cb);
        return { dispose: () => {} };
      },
      write: handle.write,
      resize: handle.resize,
      kill: handle.kill,
    };
  });

  return { spawn, spawnedPtys };
}
