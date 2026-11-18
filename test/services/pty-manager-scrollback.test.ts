// PtyManager scrollback — the replay buffer, the alt-screen/cwd/mouse-tracking preamble, and the attention flag a repaint does not clear.
//
// Split out of the former test/services/pty-manager.test.ts (issue #3277) —
// that file sat at the file-size ratchet's ceiling, so a change here could no
// longer land next to the tests it belongs with. The shared mock preamble and
// helpers live in test/helpers/pty-manager-harness.ts.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  bundleSyncMock,
  cgroupInventoryMock,
  childProcessMock,
  createPtyManagerFixture,
  destroyPtyManagerFixture,
  fakePtyChildren,
  nodePtyMock,
  resetPtyManagerMocks,
  waitForSpawn,
} from "../helpers/pty-manager-harness.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager } = await import("../../src/services/pty-manager.js");

describe("PtyManager", () => {
  let sessionsDir: string;
  let manager: InstanceType<typeof PtyManager>;

  beforeEach(() => {
    // Every test starts from a clean slate: no fake PTYs, no `systemctl`
    // fixtures and no cgroup-inventory call log left over from a sibling.
    resetPtyManagerMocks();
    ({ sessionsDir, manager } = createPtyManagerFixture(PtyManager));
  });

  afterEach(() => {
    destroyPtyManagerFixture({ sessionsDir, manager });
  });

  // getScrollback() always prepends a screen-mode preamble (see pty-manager.ts)
  // — "\x1b[?1049l" while tracked state is primary (the default), so a fresh
  // xterm.js is guaranteed to land with a scrollbar. Assert with a suffix
  // check rather than exact equality so these tests don't hard-code the
  // preamble's own byte content.
  const PRIMARY_PREAMBLE = "\x1b[?1049l";

  // Perf audit finding B8(1) — getScrollbackTail() backs the 10s
  // dev-server-detect sweep (dev-server-detect.ts's
  // detectDevServerPortForPlainSession): it must return only the most
  // recent bytes, not getScrollback()'s full ring, and — unlike
  // getScrollback() — no mode preamble, since callers only feed it into a
  // text scan.
  describe("getScrollbackTail", () => {
    it("returns everything (no preamble) when total scrollback is under the requested cap", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData("hello world");

      expect(session.getScrollbackTail(1024).toString()).toBe("hello world");
    });

    it("returns only the last N bytes when scrollback exceeds the requested cap", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      fakePtyChildren[0].emitData("a".repeat(100));
      fakePtyChildren[0].emitData("b".repeat(100));
      fakePtyChildren[0].emitData("c".repeat(100));

      const tail = session.getScrollbackTail(150);
      expect(tail.length).toBe(150);
      // Exactly the last 150 bytes of "a"*100 + "b"*100 + "c"*100: the last
      // 50 b's followed by all 100 c's.
      expect(tail.toString()).toBe(`${"b".repeat(50)}${"c".repeat(100)}`);
    });

    it("never returns more than the requested cap even across many small chunks", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      for (let i = 0; i < 50; i++) fakePtyChildren[0].emitData(`chunk-${i}-`);

      const tail = session.getScrollbackTail(64);
      expect(tail.length).toBeLessThanOrEqual(64);
      // Must end with the very last chunk emitted.
      expect(tail.toString().endsWith("chunk-49-")).toBe(true);
    });
  });

  it("tracks alt-screen state and prepends a matching preamble on replay", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // Enter alt-screen (e.g. a TUI starting up) with no matching exit yet —
    // the true state is alt, so replay should land a fresh xterm.js there
    // too rather than forcing it back to primary.
    fakePtyChildren[0].emitData("\x1b[?1049hTUI frame");
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);

    // Exiting again should flip tracked state back to primary.
    fakePtyChildren[0].emitData("\x1b[?1049lback to shell");
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);
  });

  it("tracks the legacy ?47 and ?1047 alt-screen pairs too", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?47h");
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);

    fakePtyChildren[0].emitData("\x1b[?1047l");
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);
  });

  it("uses the LAST switch in a chunk when a chunk contains more than one", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1049h...\x1b[?1049l...\x1b[?1049h");
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);
  });

  it("still tracks an alt-screen switch when a PTY read splits the escape sequence across two chunks", async () => {
    // Regression test for a real live desync: two consecutive `onData`
    // reads landing mid-sequence (e.g. right after "\x1b[?1049") used to
    // leave `inAltScreen` stuck at its old value forever, since neither
    // half alone matches ALT_SCREEN_SWITCH. See carryPartialEscape in
    // attention-detect.ts.
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("TUI starting\x1b[?1049");
    // Split lands mid-sequence — tracked state must not have flipped yet.
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);

    fakePtyChildren[0].emitData("hTUI frame");
    // The read that completes the sequence must be the one that flips it.
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h")).toBe(true);

    // And the raw scrollback itself must NOT contain any duplicated bytes
    // from the carry — it's detection-only, never fed into scrollback.
    expect(session.getScrollback().toString()).toBe("\x1b[?1049hTUI starting\x1b[?1049hTUI frame");
  });

  it("still tracks a split mouse-tracking DECSET across two chunks", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("enabling tracking\x1b[?100");
    fakePtyChildren[0].emitData("3h");
    expect(session.getScrollback().toString().startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h`)).toBe(
      true,
    );
  });

  it("does not carry a dangling partial escape across a kill()+respawn into the new attach-client's stream", async () => {
    // Review follow-up on the split-sequence fix above: a stale
    // detectCarry left over from the OLD attach-client's last chunk must
    // not be prepended to the NEW attach-client's first chunk after a
    // respawn — that byte sequence belongs to a stream that's gone.
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);

    // Leave a dangling partial alt-screen escape uncompleted, then kill.
    fakePtyChildren[0].emitData("TUI starting\x1b[?1049");
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    expect(fakePtyChildren).toHaveLength(2);

    // The new attach-client's first chunk happens to complete what WOULD
    // have been the old dangling sequence, were it (wrongly) still carried.
    fakePtyChildren[1].emitData("hfresh shell output");
    expect(session.getScrollback().toString().startsWith(PRIMARY_PREAMBLE)).toBe(true);
  });

  // Live cwd tracking (issue: sidebar worktree display) — see detectCwdChange/
  // carryPartialOsc in attention-detect.ts.
  it("starts with liveCwd null until the shell emits an OSC 7 sequence", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    expect(session.toInfo().liveCwd).toBeNull();
  });

  it("sets liveCwd from an OSC 7 sequence in the PTY stream", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]7;file:///home/user/worktree\x07");
    expect(session.toInfo().liveCwd).toBe("/home/user/worktree");
  });

  it("uses the LAST cwd when a chunk contains more than one OSC 7 sequence", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]7;file:///first\x07some output\x1b]7;file:///second\x07");
    expect(session.toInfo().liveCwd).toBe("/second");
  });

  it("still tracks a cwd change when a PTY read splits the OSC 7 sequence across two chunks", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b]7;file:///home/user/wor");
    // Split lands mid-path — must not have picked up a bogus partial value.
    expect(session.toInfo().liveCwd).toBeNull();

    fakePtyChildren[0].emitData("ktree\x07");
    expect(session.toInfo().liveCwd).toBe("/home/user/worktree");

    // And the raw scrollback must NOT contain any duplicated bytes from the
    // carry — same detection-only contract as detectCarry.
    expect(session.getScrollback().toString()).toBe(
      `${PRIMARY_PREAMBLE}\x1b]7;file:///home/user/worktree\x07`,
    );
  });

  it("keeps liveCwd (true ongoing shell state) across a kill()+respawn, unlike the byte-stream carry", async () => {
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);

    fakePtyChildren[0].emitData("\x1b]7;file:///home/user/worktree\x07");
    fakePtyChildren[0].kill();

    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    expect(fakePtyChildren).toHaveLength(2);

    expect(session.toInfo().liveCwd).toBe("/home/user/worktree");
  });

  it("resets attentionState on respawn so a stale confirmedKind doesn't leak into the new incarnation", async () => {
    // Set up confirmed attention via a BEL byte + tick past its debounce window.
    const first = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(first);
    fakePtyChildren[0].emitData("done\x07");
    first.tick(Date.now() + 2_000);
    expect(first.toInfo().attention).toBe(true);

    // Kill and respawn — the new session must have a fresh attention machine.
    fakePtyChildren[0].kill();
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    expect(session.toInfo().attention).toBe(false);
    expect(session.toInfo().attentionKind).toBeNull();
    expect(session.toInfo().attentionAt).toBeNull();
  });

  // Mirrors the alt-screen preamble tests above, for the same class of gap
  // (issue #93): tracked mouse-tracking state, synthesized into the replay
  // preamble so a reconnecting client doesn't silently lose mouse tracking
  // once the program's original enabling escape ages out of the scrollback
  // ring buffer. See MouseTrackingState's docstring in attention-detect.ts.
  it("tracks mouse-tracking state and prepends a matching preamble on replay", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1003h\x1b[?1006h");
    // startsWith, not exact equality — the raw buffered bytes ALSO begin
    // with this same escape sequence (ScrollbackBuffer.push() stores it
    // verbatim regardless of mode tracking), same reason the alt-screen
    // tests above use startsWith rather than asserting the full byte count.
    expect(
      session.getScrollback().toString().startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h`),
    ).toBe(true);
  });

  it("restores mouse tracking on replay even after the original enabling bytes are evicted from scrollback — the confirmed #93 bug", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1003h\x1b[?1006h");
    // Push well past the 1 MiB scrollback cap so the enabling escape above
    // is FIFO-evicted — the same thing that happens to a real, heavily-
    // active session (e.g. the "WORKING" opencode session from the live
    // repro) between when it started and when a browser reconnects.
    const chunk = "x".repeat(256 * 1024);
    for (let i = 0; i < 8; i++) fakePtyChildren[0].emitData(chunk);

    const scrollback = session.getScrollback().toString();
    expect(scrollback.startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h`)).toBe(true);
    // Confirm the raw bytes are genuinely gone from the buffered portion —
    // this is the preamble doing real work, not coincidentally still there.
    expect(scrollback.slice(`${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h`.length)).not.toContain(
      "\x1b[?1003h",
    );
  });

  it("does not resurrect mouse tracking that was explicitly disabled before reconnect", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1003h\x1b[?1006h");
    fakePtyChildren[0].emitData("\x1b[?1003l\x1b[?1006l");

    // Final tracked state is NONE/DEFAULT, so the mouse preamble is empty —
    // this IS exact-equality-safe (unlike the enabled-state tests above)
    // since nothing is being prepended on top of the raw buffered bytes,
    // which are both emitted chunks concatenated verbatim (neither evicted).
    expect(session.getScrollback().toString()).toBe(
      `${PRIMARY_PREAMBLE}\x1b[?1003h\x1b[?1006h\x1b[?1003l\x1b[?1006l`,
    );
  });

  it("replays the LAST protocol set when it changes mid-session", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1000h");
    fakePtyChildren[0].emitData("\x1b[?1003h");

    // Check the PREAMBLE specifically (its known, exact prefix), not the
    // whole getScrollback() output — the raw buffered bytes legitimately
    // still contain "\x1b[?1000h" as history (ScrollbackBuffer.push() stores
    // everything verbatim regardless of mode tracking), so a whole-string
    // not-toContain check would be testing the wrong thing.
    const scrollback = session.getScrollback().toString();
    expect(scrollback.startsWith(`${PRIMARY_PREAMBLE}\x1b[?1003h`)).toBe(true);
    expect(scrollback.startsWith(`${PRIMARY_PREAMBLE}\x1b[?1000h`)).toBe(false);
  });

  it("omits the mouse preamble when a DECRST for any protocol code resets the whole protocol axis (xterm's own cross-code fall-through)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    // ?1002h then ?1003h then ?1003l — real xterm.js ends at NONE here (its
    // DECRST case block falls through 9/1000/1002/1003 into one
    // activeProtocol = 'NONE' assignment), even though ?1002 itself was
    // never reset. This is the case that would trip up a naive per-code
    // "last seen on" map instead of tracking the derived protocol enum.
    fakePtyChildren[0].emitData("\x1b[?1002h\x1b[?1003h");
    fakePtyChildren[0].emitData("\x1b[?1003l");

    // Final tracked protocol is NONE, so the mouse preamble is empty —
    // exact-equality-safe against the raw buffered bytes (both chunks,
    // concatenated verbatim, neither evicted) with no preamble contribution.
    expect(session.getScrollback().toString()).toBe(
      `${PRIMARY_PREAMBLE}\x1b[?1002h\x1b[?1003h\x1b[?1003l`,
    );
  });

  it("combines the alt-screen and mouse-tracking preambles correctly", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    fakePtyChildren[0].emitData("\x1b[?1049h\x1b[?1003h\x1b[?1006h");

    // startsWith, not exact equality — same duplication reason as the
    // mouse-only "prepends a matching preamble" test above.
    expect(session.getScrollback().toString().startsWith("\x1b[?1049h\x1b[?1003h\x1b[?1006h")).toBe(
      true,
    );
  });

  it("suppresses scrollback capture during a redraw-nudge repaint but still delivers it live", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];

      // Flush the spawn-time nudge (attachClient() -> RedrawNudge.trigger())
      // so it doesn't interfere with the assertions below.
      await vi.advanceTimersByTimeAsync(700 + 500);
      const before = session.getScrollback().toString();

      session.requestRedraw();
      await vi.advanceTimersByTimeAsync(300); // the dip's repaint arrives (live fan-out: see pty-manager-redraw-capture.test.ts)
      pty.emitData("repaint frame");
      // It must not land in the buffer replayed to the next attaching client.
      expect(session.getScrollback().toString()).toBe(before);

      // Once the suppression window (restore 400ms + grace 500ms) has fully
      // elapsed, capture resumes as normal.
      await vi.advanceTimersByTimeAsync(400 + 500);
      pty.emitData("post-nudge output");
      expect(session.getScrollback().toString()).toBe(`${before}post-nudge output`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a requestRedraw() repaint does not clear a confirmed attention flag, and — follow-up to #275 (gap #3) — neither does ANY later cosmetic output; only a genuine decision does", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      const pty = fakePtyChildren[0];
      await vi.advanceTimersByTimeAsync(700 + 500); // flush the spawn-time nudge

      // Simulates a Claude Code Notification hook flagging "needs permission".
      session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
      expect(session.toInfo().attention).toBe(true);

      // Opening the workspace tab attaches -> requestRedraw() -> nudge
      // dip/restore -> the program's repaint arrives here as plain output.
      session.requestRedraw();
      pty.emitData("repainted frame");
      expect(session.toInfo().attention).toBe(true);

      // Reported bug this hardening pass fixes: a cosmetic repaint (here,
      // simulating the SIGWINCH repaint a mere terminal select/resize
      // provokes) arriving well AFTER the suppression window has closed —
      // i.e. exactly the case the old redraw-nudge-suppression-only fix
      // did NOT cover — must still not clear a hookNotification-confirmed
      // flag. Only a genuine decision may (see below).
      await vi.advanceTimersByTimeAsync(300 + 400 + 500);
      pty.emitData("just a repaint, not a decision");
      expect(session.toInfo().attention).toBe(true);

      // A real keystroke answering the prompt is the genuine decision that
      // finally clears it.
      session.write("y");
      expect(session.toInfo().attention).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an agentIdle-confirmed flag, unlike hookNotification/reviewGate, still clears on plain output (informational, not a pending decision)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    const pty = fakePtyChildren[0];

    session.emitHookEvent({ kind: "progress", phase: "done" });
    // agentIdle now settles for 3s (ATTENTION_SETTLE_MS) before it confirms —
    // advance past that window so it's actually CONFIRMED before exercising
    // the output-clears-it behavior this test is about.
    session.tick(Date.now() + 3_000);
    expect(session.toInfo().attention).toBe(true);

    pty.emitData("the agent's next turn starts producing output");
    expect(session.toInfo().attention).toBe(false);
  });

  it("a focus-report / mouse-report / OSC color-reply write() does not count as genuine user input and does not clear a confirmed flag", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.emitHookEvent({ kind: "notification", title: "Permission needed", body: "" });
    expect(session.toInfo().attention).toBe(true);

    session.write("\x1b[I"); // DECSET ?1004 focus-in report
    expect(session.toInfo().attention).toBe(true);
    session.write("\x1b[<0;10;5M"); // SGR mouse report
    expect(session.toInfo().attention).toBe(true);
    session.write("\x1b]11;rgb:1e1e/1e1e/1e1e\x07"); // OSC 11 color-query reply
    expect(session.toInfo().attention).toBe(true);
    session.write("\x1b[?997;1n"); // theme-toggle color-scheme notification
    expect(session.toInfo().attention).toBe(true);

    // A genuine keystroke (even a single arrow key) does clear it.
    session.write("\x1b[A");
    expect(session.toInfo().attention).toBe(false);
  });

  it("a promoteRequest-confirmed flag is output-immune and clears only via Session.resolvePromote (gap #3)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "bash",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    const pty = fakePtyChildren[0];

    session.emitHookEvent({ kind: "promote_request", summary: "Refactor the widget layer" });
    expect(session.toInfo().attention).toBe(true);

    // The tool call this unblocks producing PTY output must not clear it.
    pty.emitData("just a repaint, not a decision");
    expect(session.toInfo().attention).toBe(true);

    // The web-UI decision (no keystroke) is what finally resolves it.
    session.resolvePromote("accepted");
    expect(session.toInfo().attention).toBe(false);
  });

  it("an opencode permission-prompt notification (gap #2) survives a cosmetic repaint and clears on notification_resolved (permission.replied)", async () => {
    // Simulates opencode-plugin.js's mapping of a real permission.updated
    // event into a `notification` hook message (see
    // test/hooks/opencode-plugin.test.ts for the mapping itself) — this
    // Session-level test proves the resulting attention behavior end to end:
    // same output-immunity gap #3 gives Claude Code's own Notification hook,
    // and the same auto-approved-permission resolution path gap #2 adds.
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "opencode",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);
    const pty = fakePtyChildren[0];

    session.emitHookEvent({
      kind: "notification",
      title: "opencode",
      body: "Run `rm -rf build/`?",
    });
    expect(session.toInfo().attention).toBe(true);

    // A cosmetic repaint (the reported bug this hardening pass fixes) must
    // not clear it.
    pty.emitData("just a repaint, not a decision");
    expect(session.toInfo().attention).toBe(true);

    // opencode's permission.replied (an auto-approved permission, no
    // keystroke) is what finally resolves it.
    session.emitHookEvent({ kind: "notification_resolved" });
    expect(session.toInfo().attention).toBe(false);
  });

  it("notification_resolved does not dismiss a NEWER, unrelated confirmed flag (gated on confirmedKind)", async () => {
    const session = manager.getOrCreate({
      id: "1",
      cwd: "/tmp",
      command: "opencode",
      cols: 80,
      rows: 24,
    });
    await waitForSpawn(session);

    session.emitHookEvent({ kind: "notification", title: "opencode", body: "Permission needed" });
    // A fresh review_gate supersedes the notification as the currently-
    // confirmed kind before the permission's own resolution arrives.
    session.emitHookEvent({ kind: "review_gate", state: "waiting", prompt: "Deploy?" });
    expect(session.toInfo().attention).toBe(true);

    session.emitHookEvent({ kind: "notification_resolved" });

    // The stale permission resolution must not clear the newer review gate.
    expect(session.toInfo().attention).toBe(true);
  });
});
