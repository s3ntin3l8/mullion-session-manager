// PtyManager activity/attention signals (WS-6) — idle vs working, the attention kinds, and the silence context.
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

  afterEach(async () => {
    await destroyPtyManagerFixture({ sessionsDir, manager });
  });

  describe("activity/attention signals (WS-6)", () => {
    it("reports idle with no activity yet, and stays idle for a single spawn-time burst", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.toInfo()).toMatchObject({ activity: "idle", lastActivityAt: null });

      // A bash prompt draw at spawn is exactly one output burst — it must
      // NOT read as "working" (that was the bug: a single recent timestamp
      // was treated the same as sustained output).
      fakePtyChildren[0].emitData("some output");
      const info = session.toInfo();
      expect(info.activity).toBe("idle");
      expect(info.lastActivityAt).toEqual(expect.any(Number));
    });

    it("reports working once output has persisted for at least the sustain window", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("some output");
        expect(session.toInfo().activity).toBe("idle"); // single burst, not sustained yet

        // More output arrives well within the streak-gap window, 1.2s into
        // the same streak — past the 1s sustain threshold, so now "working".
        vi.setSystemTime(start + 1200);
        fakePtyChildren[0].emitData("more output");
        expect(session.toInfo().activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("reads as idle while output closely follows a keystroke, e.g. a TUI echoing what the user types (#97)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        session.write("h");
        fakePtyChildren[0].emitData("h"); // echoed keystroke
        expect(session.toInfo().activity).toBe("idle"); // single burst anyway

        // A second keystroke 1.2s later would normally push this streak past
        // SUSTAIN_MS into "working" (see the previous test) — but each write()
        // is followed immediately by its echo, so the streak never stops
        // looking like echo rather than autonomous output.
        vi.setSystemTime(start + 1200);
        session.write("e");
        fakePtyChildren[0].emitData("e");
        expect(session.toInfo().activity).toBe("idle");
      } finally {
        vi.useRealTimers();
      }
    });

    it("resumes reading as working once output persists well past the echo window, e.g. real agent output after a submit", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        session.write("prompt\n"); // user submits, no further input after this

        vi.setSystemTime(start + 1200);
        fakePtyChildren[0].emitData("agent output 1"); // streak just started
        expect(session.toInfo().activity).toBe("idle"); // not sustained yet

        // 2.4s past the submit — well outside USER_INPUT_ECHO_MS — so this
        // sustained streak is genuine autonomous work, not echo.
        vi.setSystemTime(start + 2400);
        fakePtyChildren[0].emitData("agent output 2");
        expect(session.toInfo().activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps accruing a single streak across gaps shorter than STREAK_GAP_MS, e.g. periodic status pings", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("status: 1");
        expect(session.toInfo().activity).toBe("idle"); // streak just started

        // A gap of 3s between chunks is longer than IDLE_THRESHOLD_MS (2s)
        // but shorter than STREAK_GAP_MS (4s) — the streak must carry over
        // rather than reset, so it keeps accruing toward "working".
        vi.setSystemTime(start + 3000);
        fakePtyChildren[0].emitData("status: 2");
        expect(session.toInfo().activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    it("accepts a caller-supplied idle threshold (Settings -> Notifications & status)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("some output");
        vi.setSystemTime(start + 1200);
        fakePtyChildren[0].emitData("more output"); // now sustained

        vi.setSystemTime(start + 1210);
        // A 1ms threshold: definitely idle by now.
        expect(session.toInfo(1).activity).toBe("idle");
        // A 60s threshold: still well within the window, so still "working".
        expect(session.toInfo(60_000).activity).toBe("working");
      } finally {
        vi.useRealTimers();
      }
    });

    // Issue #171/#98: the ad-hoc "bell followed by another chunk within
    // ATTENTION_CLEAR_WINDOW_MS clears it" heuristic these three tests used
    // to cover is gone — replaced by the explicit attention-detect.ts state
    // machine (IDLE -> PENDING_ATTENTION -> ATTENTION -> CLEARING). A signal
    // no longer confirms synchronously; it must go uncontradicted for its
    // own per-kind ATTENTION_CONFIRM_MS window (checked by Session.tick(),
    // the one new timer this PR adds — see ATTENTION_EVAL_INTERVAL_MS in
    // pty-manager.ts) before `attention` reads true. Tests call tick()
    // directly with a synthetic `now` rather than waiting on the real
    // interval or faking real timers, per tick()'s own doc comment.
    it("does not set attention while a bell is still debouncing (PENDING_ATTENTION)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.toInfo().attention).toBe(false);
      fakePtyChildren[0].emitData("done\x07");
      // Not yet confirmed — the bell's own 2s debounce hasn't elapsed.
      expect(session.toInfo().attention).toBe(false);
    });

    it("confirms attention once a bell's debounce window elapses with nothing to contradict it", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("done\x07");
      session.tick(Date.now() + 2_000); // past ATTENTION_CONFIRM_MS.bell

      const info = session.toInfo();
      expect(info.attention).toBe(true);
      expect(info.attentionAt).toEqual(expect.any(Number));
    });

    it("cancels a pending bell if plain output arrives before its debounce window elapses", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("progress\x07"); // bell mid-work -> PENDING_ATTENTION
      // Output resumes before the bell's window elapses — that's itself
      // evidence the program is still working, so the pending signal is
      // cancelled outright rather than ever confirming.
      fakePtyChildren[0].emitData("more progress");
      session.tick(Date.now() + 3_000); // well past the bell's own window
      expect(session.toInfo().attention).toBe(false);
    });

    it("keeps attention set when a confirmed bell is followed by silence", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("done\x07");
      session.tick(Date.now() + 2_000); // confirms
      expect(session.toInfo().attention).toBe(true);

      // No further output arrives — nothing clears the flag, and re-ticking
      // an already-confirmed session is a no-op, so it correctly keeps
      // reading as "needs input".
      session.tick(Date.now() + 7_000);
      expect(session.toInfo().attention).toBe(true);
    });

    it("never confirms attention from a rapid BEL burst during heavy output (issue #171 false-positive regression)", async () => {
      // The original bug: a bell followed by ANOTHER chunk within the burst
      // window cleared attention a tick later, but each bell in a rapid
      // burst still transiently flagged `attention: true` (and emitted a
      // #166 event) the instant it arrived, before self-correcting. This
      // simulates a busy Ink-style TUI (Claude Code/Codex) ringing the bell
      // roughly every 200ms as an incidental part of normal rendering —
      // each one must just re-arm the pending window, never confirm.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      let lastBellAt = 0;
      try {
        const start = Date.now();
        for (let i = 0; i < 20; i++) {
          lastBellAt = start + i * 200;
          vi.setSystemTime(lastBellAt);
          fakePtyChildren[0].emitData(`frame ${i}\x07`);
          expect(session.toInfo().attention).toBe(false);
        }

        // Even ticking shortly after the LAST bell in the burst — before
        // ITS OWN 2s debounce has elapsed — must not confirm.
        session.tick(lastBellAt + 500);
        expect(session.toInfo().attention).toBe(false);
      } finally {
        vi.useRealTimers();
      }

      // Only once the burst genuinely STOPS and stays quiet for the bell's
      // full debounce window does it confirm — the correct "eventually
      // actually done" case, not a false positive.
      session.tick(lastBellAt + 2_000);
      expect(session.toInfo().attention).toBe(true);
    });

    it("confirms an OSC 9 notification faster than a bare bell (per-kind thresholds)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b]9;Build finished\x07"); // OSC 9 notification
      session.tick(Date.now() + 1_000); // notification's own, shorter threshold
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not yet confirm a bare bell at the 1s mark a notification would already confirm at", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("done\x07");
      session.tick(Date.now() + 1_000); // still short of the bell's 2s threshold
      expect(session.toInfo().attention).toBe(false);
      session.tick(Date.now() + 2_000);
      expect(session.toInfo().attention).toBe(true);
    });

    it("sets attention on a working->idle title transition (#98)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b]2;Thinking…\x07"); // working title
      expect(session.toInfo().attention).toBe(false);

      // titleIdle is a zero-threshold kind (already a deliberate, debounced
      // signal by construction — see ATTENTION_CONFIRM_MS) — confirms
      // immediately, no tick() needed.
      fakePtyChildren[0].emitData("\x1b]2;Ready\x07"); // idle title
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not set attention for an idle title with no prior working title observed", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      // First title this session has ever reported is already idle — there
      // was no "working" read to transition FROM, so this isn't the #98
      // signal at all.
      fakePtyChildren[0].emitData("\x1b]2;Ready\x07");
      expect(session.toInfo().attention).toBe(false);
    });

    it("sets attention when a program exits alt-screen mode back to the shell prompt (#98)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b[?1049h"); // enter alt-screen (e.g. an editor opening)
      expect(session.toInfo().attention).toBe(false);

      fakePtyChildren[0].emitData("\x1b[?1049l"); // exit -- zero-threshold, confirms immediately
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not set attention on ENTERING alt-screen, only on exit", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      fakePtyChildren[0].emitData("\x1b[?1049h");
      expect(session.toInfo().attention).toBe(false);
    });

    it("sets attention after a sustained work streak goes silent for long enough (#98 sustained-silence-after-work)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("agent output 1"); // streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("agent output 2");
        expect(session.toInfo().activity).toBe("working");
        expect(session.toInfo().attention).toBe(false); // not silent yet

        // No further output at all — tick well past SUSTAINED_SILENCE_MS
        // since the last chunk. This is a purely time-driven signal (see
        // Session.tick's own doc comment) — nothing byte-driven triggers it.
        session.tick(start + 1_200 + 10_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
    });

    it("does not fire the sustained-silence signal for a single spawn-time burst (not a real work streak)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("prompt draw"); // single burst, never sustained
        session.tick(start + 15_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(false);
    });

    it("does not fire sustained-silence for a PROVEN hook-active agent's startup splash render (a brand-new, never-touched terminal)", async () => {
      // "claude" matches claudeCodeAdapter, so this session's hooksActive is
      // true. Follow-up to #275 (gap #1): the long HOOK_FALLBACK_SILENCE_MS
      // watchdog additionally requires hooksProven — established here via
      // markHooksProven(), standing in for Claude Code's own SessionStart
      // hook (see hooks.ts's session_start branch, which this Session-level
      // test can't reach directly). Once proven, its own Stop hook (routed
      // to the agentIdle signal) is the authoritative "turn is over" signal,
      // so the byte-driven guess must stay silent even though the splash
      // render below looks byte-for-byte identical to the "real work streak"
      // case above.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("splash frame 1"); // streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- looks "sustained"
        fakePtyChildren[0].emitData("splash frame 2");
        expect(session.toInfo().activity).toBe("working");

        // Left untouched (no keystroke, no hook signal) well past
        // SUSTAINED_SILENCE_MS — a hookless session would flag here (see
        // the "sustained-silence-after-work" test above).
        session.tick(start + 1_200 + 10_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(false);
    });

    it("a MATCHED-but-never-PROVEN hooksActive session uses the slow watchdog, same as a proven session", async () => {
      // Models the untrusted-codex scenario: hooksActive true (an adapter
      // matched), but no hook has ever actually fired, so hooksProven never
      // latches. Before this fix, tick() used the fast 10s bound here,
      // causing repeated "needs input" cycles (every 10s of silence after
      // a work streak). Now hooksActive alone gates the long watchdog — the
      // hook pipeline gets 60s to prove itself, avoiding the false-alarm
      // cycle for sessions whose hooks arrived at least once before a
      // restart. Uses "claude" (not "codex") purely to avoid codex's
      // real-$CODEX_HOME managedInstall filesystem write — see the
      // dedicated "Codex (issue #252)" describe block below for that
      // adapter's own install coverage; the latch logic under test here is
      // adapter-agnostic.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("work output 2");
        expect(session.toInfo().attention).toBe(false);

        // Well past the fast 10s bound — must NOT fire, because hooksActive
        // gates the 60s watchdog regardless of hooksProven.
        session.tick(start + 1_200 + 60_000 - 1);
        expect(session.toInfo().attention).toBe(false);

        // Past the 60s HOOK_FALLBACK_SILENCE_MS bound — fires.
        session.tick(start + 1_200 + 60_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
    });

    it("does eventually fire the fallback sustained-silence signal for a PROVEN hook-active session after HOOK_FALLBACK_SILENCE_MS (dead/wedged hook pipeline safety net)", async () => {
      // Same "claude" hooksActive session as the splash-render test above,
      // proven via markHooksProven() (see that test's comment), but silent
      // for much longer than any legitimate startup render could ever take
      // — this must still surface attention eventually, covering a killed
      // agent process or crashed forwarder that never sends its Stop/"done"
      // hook message at all, despite having proven itself once already.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("work output 2");
        expect(session.toInfo().attention).toBe(false); // not silent long enough yet

        // Still well short of HOOK_FALLBACK_SILENCE_MS -- must not fire yet
        // (unlike the never-proven codex case above, which fires here).
        session.tick(start + 1_200 + 10_000);
        expect(session.toInfo().attention).toBe(false);

        // Past HOOK_FALLBACK_SILENCE_MS with no hook signal ever arriving --
        // the fallback watchdog must now fire.
        session.tick(start + 1_200 + 60_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
    });

    it("markHooksProven latches monotonically -- once proven, later ticks keep using the slow watchdog even across further activity", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");
        vi.setSystemTime(start + 1_200);
        fakePtyChildren[0].emitData("work output 2");

        // A second, later hook message (not just the first) must not
        // somehow "un-prove" the session -- still on the slow bound.
        session.emitHookEvent({ kind: "file_change", path: "/tmp/x.ts", action: "modify" });
        session.tick(start + 1_200 + 10_000);
        expect(session.toInfo().attention).toBe(false); // still short of the slow bound
        session.tick(start + 1_200 + 60_000);
        expect(session.toInfo().attention).toBe(true); // slow bound still applies
      } finally {
        vi.useRealTimers();
      }
    });

    it("issue #1228: a hookless session's silence event carries the last real scrollback line as context", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        // \r\n, not bare \n — a real pty's actual line terminator (node-pty,
        // this repo's own backend). Regression coverage for a prior bug
        // where the trailing \r before \n was misread as an overwrite
        // marker, discarding every ordinary line as blank.
        fakePtyChildren[0].emitData("build step 1\r\n"); // streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData(`${"\x1b[1m"}build succeeded${"\x1b[22m"}\r\n`);

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBe("build succeeded");
    });

    it("issue #1228: attaches real context even when total buffered scrollback exactly equals the scan cap (not a truncated read)", async () => {
      // Regression test: getScrollbackTail(SILENCE_SCAN_TAIL_BYTES).length
      // alone can't tell "the read was cut short" apart from "the session
      // simply has exactly that many bytes buffered, no more" — both
      // produce a tail of that same length. Sized so the two chunks below
      // sum to EXACTLY 8192 (SILENCE_SCAN_TAIL_BYTES) in total, with a real,
      // non-blank final line — a prior version of this code mistook this
      // for a truncated read and discarded that final line as a possibly
      // partial fragment, losing it entirely.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        const filler = `${"x".repeat(8178)}\r\n`; // 8180 bytes
        fakePtyChildren[0].emitData(filler); // streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        const finalLine = "final line\r\n"; // 12 bytes -- 8180 + 12 = 8192
        fakePtyChildren[0].emitData(finalLine);

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBe("final line");
    });

    it("issue #1228: does not attach scrollback context for an alt-screen session (a TUI's redraw is not a meaningful line)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200);
        fakePtyChildren[0].emitData("TUI frame 2");

        session.tick(start + 1_200 + 10_000);
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBeUndefined();
    });

    it("issue #1228: does not attach scrollback context for a hooksActive session (sessionContextMap already covers it on the frontend)", async () => {
      // "claude" matches claudeCodeAdapter, so hooksActive is true from
      // spawn — see the "PROVEN hook-active agent" test above for why this
      // alone is enough to change tick()'s behavior, independent of
      // hooksProven.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "claude",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);
      session.markHooksProven();

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("work output 1");

        vi.setSystemTime(start + 1_200);
        fakePtyChildren[0].emitData("work output 2");

        session.tick(start + 1_200 + 60_000); // past HOOK_FALLBACK_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBeUndefined();
    });

    it("issue #1296: does not surface a stale alt-screen redraw fragment as silence context after exiting alt-screen with no further output", async () => {
      // Regression test for the gap #1228's own !this.inAltScreen gate left
      // open: that check is signal-time only, but getScrollbackTail() reads
      // raw bytes regardless of screen mode — so a session that exits
      // alt-screen and then produces genuinely zero further output could
      // still walk backward into TUI redraw bytes physically still sitting
      // in the ring.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("TUI frame 2");

        // Exits alt-screen with no further output. altScreenExited sets
        // candidateKind = "altScreenExit", which CONFIRMS attention — tick()'s
        // silence branch only ever runs from `state === "idle"`, so without
        // clearing that confirmation first, the silence signal would never
        // fire and this test would pass vacuously (no event at all) whether
        // or not the fix actually works.
        fakePtyChildren[0].emitData("\x1b[?1049l");
        session.write("y"); // a genuine, non-immune userInput clears it
        expect(session.toInfo().attention).toBe(false);

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBeUndefined();
    });

    it("issue #1296: still surfaces a real line written after exiting alt-screen (the watermark doesn't over-suppress)", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("\x1b[?1049l"); // exits alt-screen, no trailing text in this chunk
        session.write("y"); // clears the altScreenExit confirmation
        expect(session.toInfo().attention).toBe(false);

        fakePtyChildren[0].emitData("build succeeded\r\n"); // real output after the exit

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBe("build succeeded");
    });

    it("issue #1303: still surfaces a real line that shares the SAME PTY chunk as the alt-screen exit sequence", async () => {
      // Unlike the #1296 regression test above (exit sequence and the real
      // line arrive in two separate onData chunks), this puts them in ONE
      // chunk — exactly the shape #1296's own fix was conservative about:
      // it watermarked at the whole chunk's end, so "build succeeded" here
      // would have been excluded right along with the escape sequence.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        // Exit sequence AND the shell's next prompt text share one PTY read.
        fakePtyChildren[0].emitData("\x1b[?1049lbuild succeeded\r\n");
        session.write("y"); // clears the altScreenExit confirmation
        expect(session.toInfo().attention).toBe(false);

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBe("build succeeded");
    });

    it("issue #1303: still surfaces a real line when the exit sequence itself is split across two PTY reads via detectCarry", async () => {
      // Exercises the offsetInData = endIndex - this.detectCarry.length term
      // directly: the exit sequence's closing byte arrives in a SEPARATE
      // chunk from where it started, so detectChunk (this carry + data) is
      // longer than `data` itself when the match is found. Getting the carry
      // subtraction wrong (or dropping it) would misalign endIndex against
      // `data` and either throw or chop into "build succeeded" itself.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("\x1b[?1049"); // exit sequence missing its closing "l" -- carried
        fakePtyChildren[0].emitData("lbuild succeeded\r\n"); // completes the exit, same read as the real line
        session.write("y"); // clears the altScreenExit confirmation
        expect(session.toInfo().attention).toBe(false);

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBe("build succeeded");
    });

    it("issue #1303: does not rewind the watermark into an earlier, already-buffered chunk when the exit itself lands during a redraw-nudge suppression window", async () => {
      // requestRedraw()'s suppression window skips scrollbackBuffer.push()
      // for whatever arrives while it's open (see redraw-nudge.ts). If the
      // alt-screen exit sequence — with trailing bytes — arrives DURING that
      // window, totalBytesEverPushed() doesn't include this chunk at all, so
      // subtracting its trailing-byte count would walk the watermark
      // backward into the PREVIOUS (already pushed, still alt-screen)
      // chunk — reopening #1296's bug from the other direction.
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
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

        // Flush the spawn-time nudge so it doesn't interfere below.
        await vi.advanceTimersByTimeAsync(700 + 500);

        const start = Date.now();
        vi.setSystemTime(start);
        pty.emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        pty.emitData("TUI frame 2"); // pushed normally, no suppression active yet

        // Starts a suppression window -- `suppressed` flips synchronously,
        // before the dip/restore timers even fire.
        session.requestRedraw();
        await vi.advanceTimersByTimeAsync(300); // dip: repaint in flight; exit + repaint bytes must not land in the ring
        pty.emitData("\x1b[?1049lstale");
        session.write("y"); // clears the altScreenExit confirmation
        expect(session.toInfo().attention).toBe(false);

        // Let the whole dip (300ms) + restore (400ms) + grace (500ms) cycle
        // elapse so capture resumes as normal. Faking "Date" alongside the
        // timers advances the mocked clock by the same amount, so the real
        // post-nudge chunk below lands at start + 1_200 + 1_200, not
        // start + 1_200 -- the final tick() target accounts for that.
        await vi.advanceTimersByTimeAsync(400 + 500);

        pty.emitData("build succeeded\r\n"); // genuine post-nudge output

        session.tick(start + 1_200 + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
        expect(session.toInfo().attention).toBe(true);
        const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
        const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
        expect(confirmed?.payload.context).toBe("build succeeded");
      } finally {
        vi.useRealTimers();
      }
    });

    it("issue #1303: does not surface an escape-only trailing fragment as context when the exit sequence's trailing bytes are just a teardown repaint", async () => {
      // A real TUI's teardown commonly writes clear-screen/cursor-home right
      // alongside the alt-screen exit itself (e.g. `\x1b[?1049l\x1b[2J\x1b[H`,
      // no real text at all). Narrowing the watermark to the sequence's own
      // end offset (rather than the whole chunk) makes `sinceAltExit`
      // positive here where it used to be exactly 0 -- this only stays safe
      // because lastMeaningfulLine's own CSI-stripping (terminal-text.ts)
      // already collapses pure escape bytes to nothing, same as it would for
      // any other escape-only scrollback content.
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      vi.useFakeTimers({ toFake: ["Date"] });
      try {
        const start = Date.now();
        vi.setSystemTime(start);
        fakePtyChildren[0].emitData("\x1b[?1049hTUI frame 1"); // enters alt-screen, streak starts

        vi.setSystemTime(start + 1_200); // past SUSTAIN_MS -- a genuine streak
        fakePtyChildren[0].emitData("\x1b[?1049l\x1b[2J\x1b[H"); // exit + escape-only teardown, no real text
        session.write("y"); // clears the altScreenExit confirmation
        expect(session.toInfo().attention).toBe(false);

        session.tick(start + 1_200 + 10_000); // past SUSTAINED_SILENCE_MS
      } finally {
        vi.useRealTimers();
      }
      expect(session.toInfo().attention).toBe(true);
      const silenceEvents = session.getEvents().filter((e) => e.kind === "attention");
      const confirmed = silenceEvents.find((e) => e.payload.signal === "silence");
      expect(confirmed?.payload.context).toBeUndefined();
    });

    it("tracks the most recent OSC 0/2 title-change payload", async () => {
      const session = manager.getOrCreate({
        id: "1",
        cwd: "/tmp",
        command: "bash",
        cols: 80,
        rows: 24,
      });
      await waitForSpawn(session);

      expect(session.toInfo().lastTitle).toBeNull();
      fakePtyChildren[0].emitData("\x1b]2;waiting for input\x07");
      expect(session.toInfo().lastTitle).toBe("waiting for input");
    });
  });
});
