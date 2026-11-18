// PtyManager title_change event coalescing (A1) — how a burst of title changes is bounded without losing an event.
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
    describe("title_change event coalescing (A1)", () => {
      it("bounds emitted title_change events during a rapid burst while attention/idle-detection still observes EVERY raw title change", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          // Realistic TUI spinner/timer churn: 20 title rewrites, 50ms apart
          // (~1s total), alternating a "working" and an idle title so every
          // odd tick is a genuine #98 working->idle transition -- prior to
          // this fix, EVERY one of these 20 raw changes would also have
          // produced its own persisted+broadcast title_change event.
          for (let i = 0; i < 20; i++) {
            const working = i % 2 === 0;
            const title = working ? "Thinking…" : "Ready";
            fakePtyChildren[0].emitData(`\x1b]2;${title}\x07`);

            // Detection runs off the RAW signal on EVERY tick, uninterrupted
            // by the still-pending debounce asserted below -- lastTitle
            // always reflects the very latest raw title, not the debounced
            // one.
            expect(session.toInfo().lastTitle).toBe(title);
            if (!working) {
              // A working->idle transition is a zero-threshold attention
              // signal (#98) -- confirms immediately, mid-burst, even
              // though not a single title_change EVENT has fired yet (this
              // is exactly the "detection stays live, persistence gets
              // coalesced" split — see scheduleTitleChangeEvent()'s doc
              // comment). If the debounce accidentally gated detection too
              // (the regression this test exists to catch), this would
              // still read false here.
              expect(session.toInfo().attention).toBe(true);
            }

            // The title_change EVENT itself stays coalesced through the
            // whole burst -- still inside the trailing-edge debounce
            // window every tick reset.
            expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

            await vi.advanceTimersByTimeAsync(50);
          }

          // Let TITLE_CHANGE_EVENT_DEBOUNCE_MS elapse from the last raw
          // title change.
          await vi.advanceTimersByTimeAsync(3_000);

          const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
          // 20 raw title-change signals (each one independently observed by
          // attention/idle-detection above, mid-burst) -> 1 emitted event: a
          // 95% reduction on this burst alone, carrying the LATEST title,
          // not the one that started the window.
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "Ready" });
        } finally {
          vi.useRealTimers();
        }
      });

      it("forces an eventual title_change event at the 15s ceiling under CONTINUOUS 1Hz title churn that never lets the 3s trailing debounce elapse on its own", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          // Simulates production's measured ~1 title_change/sec for an
          // actively-working agent: a title change every 1s, well inside
          // the 3s trailing-edge debounce window, resetting it every time
          // -- the only thing that can force an emission here is the 15s
          // ceiling armed once, on the FIRST pending title (t=0).
          for (let i = 0; i < 14; i++) {
            fakePtyChildren[0].emitData(`\x1b]2;working (${i})\x07`);
            await vi.advanceTimersByTimeAsync(1_000); // t = 1000, 2000, ..., 14000
          }
          // At t=14000 the last emit (i=13) set its own debounce deadline
          // for t=17000 -- well AFTER the ceiling's fixed t=15000 deadline,
          // so whatever fires next can only be the ceiling, not the
          // trailing debounce settling on its own.
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

          await vi.advanceTimersByTimeAsync(1_000); // t = 15000 -- ceiling fires
          const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "working (13)" });

          // Steady state under sustained, unbroken churn: this same cycle
          // repeats every CEILING_MS (15s) instead of every ~1s -- a ~15x
          // (~93%) reduction, closely tracking the audit's own measured
          // 93.6% title_change share of production's session_events table.
          // Mirrors the first cycle's exact shape: the ceiling that just
          // fired at t=15000 re-armed fresh (for t=30000) on the very next
          // pending title, so 14 more 1s-spaced emits land one tick short
          // of that new deadline (t=29000) before a final explicit advance
          // crosses it.
          for (let i = 14; i < 28; i++) {
            fakePtyChildren[0].emitData(`\x1b]2;working (${i})\x07`);
            await vi.advanceTimersByTimeAsync(1_000); // t = 16000, ..., 29000
          }
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(1);
          await vi.advanceTimersByTimeAsync(1_000); // t = 30000 -- ceiling fires again
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(2);
        } finally {
          vi.useRealTimers();
        }
      });

      it("flushes a still-pending debounced title_change event on kill() rather than dropping it", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          fakePtyChildren[0].emitData("\x1b]2;Ready\x07");
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

          manager.kill("1");

          const titleEvents = session.getEvents().filter((e) => e.kind === "title_change");
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "Ready" });
        } finally {
          vi.useRealTimers();
        }
      });

      it("also flushes a still-pending debounced title_change event when the pty process exits on its own (crash/natural exit, not Session.kill()) — Hermes review, PR #593", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
          const session = manager.getOrCreate({
            id: "1",
            cwd: "/tmp",
            command: "claude",
            cols: 80,
            rows: 24,
          });
          await waitForSpawn(session);

          fakePtyChildren[0].emitData("\x1b]2;Done\x07");
          expect(session.getEvents().filter((e) => e.kind === "title_change")).toHaveLength(0);

          // The pty process dying on its own (a crash, or — very commonly —
          // an agent program exiting cleanly right after a final title
          // rewrite) — NOT session.kill()/manager.kill(). This fires the
          // exit listener spawn() registered via ptyProcess.onExit()
          // directly, the same path a real crash takes, bypassing kill()'s
          // own flushTitleChangeEvent() call entirely.
          fakePtyChildren[0].kill();

          const events = session.getEvents();
          const titleEvents = events.filter((e) => e.kind === "title_change");
          // The pending title_change must still be flushed here -- not
          // silently dropped for another 3-15s (or forever, if this Session
          // instance never spawns again) -- exactly the "session ended with
          // unflushed state" class of bug the state file's own A8 fix
          // already covers, now closed for this debounce too.
          expect(titleEvents).toHaveLength(1);
          expect(titleEvents[0].payload).toEqual({ title: "Done" });

          // Chronological order preserved: the flush happens BEFORE the
          // exit handler's own status_change("exited") emission, matching
          // what actually happened (the title changed, then the process
          // exited) — not after, which would invert it.
          const exitedEvent = events.find(
            (e) => e.kind === "status_change" && e.payload.reason === "exited",
          );
          expect(exitedEvent).toBeDefined();
          expect(titleEvents[0].seq).toBeLessThan(exitedEvent!.seq);
        } finally {
          vi.useRealTimers();
        }
      });
    });
  });
});
