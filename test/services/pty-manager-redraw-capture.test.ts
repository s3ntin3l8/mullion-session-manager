import { describe, it, expect, afterEach, vi } from "vitest";
// Helper imports first — see pty-manager-file-change-ignore.test.ts's header
// for why they must precede anything that could load node-pty/child_process.
import { createNodePtyMock } from "../helpers/mock-pty.js";
import { mockChildProcessSpawn } from "../helpers/mock-spawn.js";
import fs from "node:fs";
import type * as ChildProcess from "node:child_process";
import { uniqueDir } from "../helpers/tmpdir.js";

const ptyMock = createNodePtyMock();
vi.mock("node-pty", () => ({ spawn: ptyMock.spawn }));
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof ChildProcess>();
  return mockChildProcessSpawn(actual);
});

const { PtyManager } = await import("../../src/services/pty-manager.js");

// #3154 — Session.wireAttachClient's onData used to drop EVERYTHING during the
// ~1.2 s redraw-nudge window, including real program output. Drives the real
// Session onData path (not RedrawNudge in isolation).
describe("Session scrollback during a redraw-nudge window (#3154)", () => {
  const dirs: string[] = [];
  const managers: InstanceType<typeof PtyManager>[] = [];
  afterEach(() => {
    vi.useRealTimers();
    for (const m of managers.splice(0)) m.killAll();
    for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
  });

  async function setup() {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const sessionsDir = uniqueDir("pty-manager-redraw-capture-");
    dirs.push(sessionsDir);
    const manager = new PtyManager({ sessionsDir });
    managers.push(manager);
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    for (let i = 0; i < 50 && !session.isAlive; i++) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(session.isAlive).toBe(true);
    const pty = ptyMock.spawnedPtys[ptyMock.spawnedPtys.length - 1];
    await vi.advanceTimersByTimeAsync(700 + 500); // flush the spawn-time nudge
    return { session, pty };
  }

  it("stores real output in the window but not a repaint identical to what is stored", async () => {
    const { session, pty } = await setup();
    pty.emitData("screen content\r\n");
    const stored = session.getScrollback().toString();

    session.requestRedraw();
    // Before the dip no repaint can exist yet: real output is stored.
    pty.emitData("early real output\r\n");
    await vi.advanceTimersByTimeAsync(300 + 400); // dip, then restore
    // The restore's repaint repeats the stored screen: not stored twice.
    pty.emitData("screen content\r\n");
    // Real output after the restore, still inside the grace window: stored.
    pty.emitData("late real output\r\n");

    expect(session.getScrollback().toString()).toBe(
      `${stored}early real output\r\nlate real output\r\n`,
    );
  });

  it("does not store the dip's reduced-height repaint, and live listeners still get it", async () => {
    const { session, pty } = await setup();
    const before = session.getScrollback().toString();
    const live: string[] = [];
    session.onData((c) => live.push(c.toString()));

    session.requestRedraw();
    await vi.advanceTimersByTimeAsync(300); // dip
    pty.emitData("half-height frame");

    expect(live).toEqual(["half-height frame"]);
    expect(session.getScrollback().toString()).toBe(before);
  });
});
