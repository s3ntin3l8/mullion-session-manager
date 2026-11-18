// Session state file persistence (issue #323) — what a backend restart restores from <id>.state.json.
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
  nodePtyMock,
} from "../helpers/pty-manager-harness.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deriveInstanceId } from "../../src/services/session-process.js";
import { getScopeBackend } from "../../src/services/scope/index.js";

vi.mock("node-pty", () => nodePtyMock());
vi.mock("../../src/services/bundle-sync.js", () => bundleSyncMock());
vi.mock("node:child_process", async (importOriginal) => childProcessMock(await importOriginal()));
vi.mock("../../src/services/cgroup-inventory.js", () => cgroupInventoryMock());

const { PtyManager, Session } = await import("../../src/services/pty-manager.js");

describe("Session state file persistence (issue #323)", () => {
  let sessionsDir: string;

  beforeEach(() => {
    sessionsDir = fs.mkdtempSync(path.join(os.tmpdir(), "pty-state-test-"));
  });

  afterEach(() => {
    fs.rmSync(sessionsDir, { recursive: true, force: true });
  });

  function makeSession(id = "1") {
    return new Session({
      id,
      cwd: "/tmp",
      command: "bash",
      socketPath: path.join(sessionsDir, `${id}.sock`),
      cols: 80,
      rows: 24,
      hookSocketPath: path.join(sessionsDir, "hooks.sock"),
      controlSocketPath: path.join(sessionsDir, "mullion.sock"),
      sessionsDir,
      scope: getScopeBackend({
        sessionsDir,
        instanceId: deriveInstanceId(sessionsDir),
      }),
    });
  }

  function stateFilePath(id = "1"): string {
    return path.join(sessionsDir, `${id}.state.json`);
  }

  function socketPath(id = "1"): string {
    return path.join(sessionsDir, `${id}.sock`);
  }

  it("reports stateRestored=true for a fresh session with no state file on disk (nothing lost)", () => {
    const session = makeSession();
    const info = session.toInfo();
    expect(info.stateRestored).toBe(true);
    expect(info.staleHooks).toBe(false);
    expect(info.restoredVersion).toBeNull();
  });

  it("persists the pty size and storedPtySize reads it back for an untracked session (#2271)", () => {
    const session = makeSession();
    session.resize(150, 50);
    // kill() flushes the debounced state file (and disables further writes).
    session.kill();

    expect(new PtyManager({ sessionsDir }).storedPtySize("1")).toEqual({ cols: 150, rows: 50 });
  });

  it("storedPtySize is null without a state file, or when it predates persisted sizes (#2271)", () => {
    expect(new PtyManager({ sessionsDir }).storedPtySize("1")).toBeNull();

    fs.writeFileSync(
      stateFilePath("1"),
      JSON.stringify({ v: 1, launchedAtVersion: "0.0.0", state: { permissionState: "idle" } }),
    );
    expect(new PtyManager({ sessionsDir }).storedPtySize("1")).toBeNull();

    fs.writeFileSync(
      stateFilePath("1"),
      JSON.stringify({
        v: 1,
        launchedAtVersion: "0.0.0",
        state: { ptySize: { cols: "x", rows: 2 } },
      }),
    );
    expect(new PtyManager({ sessionsDir }).storedPtySize("1")).toBeNull();
  });

  it("restores state from a valid file on construction", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "pending",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 2,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
        turnPromptSource: "loop_wakeup",
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.stateRestored).toBe(true);
    expect(info.permissionState).toBe("pending");
    expect(info.subagentCount).toBe(2);
    // Phase 5 (Track A) — a state file written before the subagent
    // registry existed simply has no `subagents` key at all (an upgrade
    // scenario, not a corrupt one) — subagentCount survives with an empty
    // registry rather than the restore failing or the count being zeroed.
    expect(info.subagents).toEqual([]);
    // Issue #1735 — who authored the turn in flight survives the restart, so
    // the restored session judges its next `progress: done` against the
    // right source. Asserted BEHAVIOURALLY: the restored source is a
    // machine wakeup, so a turn end with a wakeup still PENDING must not
    // mark the work as finished — which is the whole point of carrying it
    // across a restart.
    session.emitHookEvent({ kind: "progress", phase: "done", wakeupsPending: true });
    expect(session.toInfo().lastTurnEndedAt).not.toBeNull();
    expect(session.toInfo().workFinishedAt).toBeNull();
    // With nothing pending it is finished — the `/loop`'s final iteration.
    session.emitHookEvent({ kind: "progress", phase: "done", wakeupsPending: false });
    expect(session.toInfo().workFinishedAt).not.toBeNull();
  });

  it("restores a persisted subagent registry from state file, keyed correctly on reconstruction", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 1,
        subagents: [
          {
            agentId: "sub-1",
            agentType: "Explore",
            startedAt: 1000,
            endedAt: null,
            summary: null,
            fileChanges: 3,
            toolFailures: 0,
            eventCount: 3,
          },
        ],
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.subagentCount).toBe(1);
    expect(info.subagents).toEqual([
      {
        agentId: "sub-1",
        agentType: "Explore",
        startedAt: 1000,
        endedAt: null,
        summary: null,
        fileChanges: 3,
        toolFailures: 0,
        eventCount: 3,
      },
    ]);
  });

  // Issue: opencode/Claude Code TUI sessions became unscrollable/frozen
  // after a Mullion backend restart — this is issue #93 one lifetime
  // boundary deeper. #93 taught getScrollback() to synthesize its
  // alt-screen/mouse-tracking preamble from tracked Session state rather
  // than trusting the raw ring buffer, but that tracked state itself was
  // in-memory only. A dtach master survives a backend restart; the Session
  // object doesn't — so a freshly-constructed Session replayed a
  // known-stale "primary buffer, no mouse tracking" preamble to the next
  // attaching client while the real, still-running TUI stayed in alt-screen
  // with mouse tracking on. These three tests exercise readStateFile()'s
  // restore of `termModes` by checking the one thing a reattaching client
  // actually observes: the synthesized getScrollback() preamble.
  it("restores tracked alt-screen/mouse-tracking state from state file into the scrollback preamble", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
        termModes: { inAltScreen: true, mouseTracking: { protocol: "ANY", encoding: "SGR" } },
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");

    // Empty ring buffer (nothing has streamed through onData yet) — the
    // entire replay is the restored preamble itself.
    expect(session.getScrollback().toString("utf8")).toBe("\x1b[?1049h\x1b[?1003h\x1b[?1006h");
  });

  it("falls back to today's defaults when a pre-existing state file has no termModes key (upgrade, not corruption)", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
        // No `termModes` key at all — a state file written before this fix.
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");

    expect(session.getScrollback().toString("utf8")).toBe("\x1b[?1049l");
  });

  it("skips a malformed mouseTracking value instead of throwing, while still restoring a valid inAltScreen", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
        // A protocol/encoding outside xterm.js's own enum would otherwise
        // poison getScrollback()'s MOUSE_PROTOCOL_ENABLE/MOUSE_ENCODING_ENABLE
        // lookups rather than just falling back to "no tracking".
        termModes: { inAltScreen: true, mouseTracking: { protocol: "BOGUS", encoding: "SGR" } },
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");

    // inAltScreen restores independently of the sibling mouseTracking
    // validation failing — only the mouse half falls back to the default.
    expect(session.getScrollback().toString("utf8")).toBe("\x1b[?1049h");
  });

  // Own-review finding — `s.termModes !== undefined` alone lets a literal
  // `null` (JSON-serializable, unlike `undefined`) slip past the guard and
  // into `s.termModes.inAltScreen`, throwing a TypeError synchronously
  // inside the Session constructor instead of falling back to defaults like
  // every other field in readStateFile(). `!= null` (loose) rejects both
  // `undefined` and `null` in one check, matching this method's own
  // documented "skip an unexpected shape, don't throw" posture.
  it("does not throw when a state file has a literal `termModes: null` — falls back to defaults", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
        termModes: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    let session: ReturnType<typeof makeSession> | undefined;
    expect(() => {
      session = makeSession("1");
    }).not.toThrow();
    expect(session?.getScrollback().toString("utf8")).toBe("\x1b[?1049l");
  });

  // Issue #428 — backgroundTasks is part of StoredStateFields (unlike the
  // PERSISTED backgroundTasksAt value, deliberately not saved — see
  // collectState()'s own comment). The restore path still re-stamps
  // backgroundTasksAt to restore-time via setBackgroundTasks() (Hermes
  // review, PR #453) — without this, a restored outstanding set could never
  // be cleared by the staleness sweep at all, since isStale(null, ...) is
  // always false.
  it("restores a latched backgroundTasks list from state file, re-stamping backgroundTasksAt to restore time", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: 123,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const before = Date.now();
    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.backgroundTasks).toEqual([
      { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
    ]);
    expect(info.outstandingBackgroundTasks).toEqual([
      { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
    ]);
    expect(info.backgroundTasksAt).not.toBeNull();
    expect(info.backgroundTasksAt as number).toBeGreaterThanOrEqual(before);
  });

  it("restores an all-terminal backgroundTasks list from state file with backgroundTasksAt left null", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.outstandingBackgroundTasks).toEqual([]);
    expect(info.backgroundTasksAt).toBeNull();
  });

  // Fresh-review finding on PR #453 — turnEndPingSent isn't itself
  // persisted, but must be DERIVED correctly on restore rather than always
  // defaulting to false, or a restart can produce a duplicate "Finished"
  // ping for a turn the original process already notified about. Asserted
  // behaviorally (turnEndPingSent has no toInfo() field of its own) via
  // whether a later drain-reporting event fires a fresh agentIdle.
  it("restoring an already-latched, already-drained turn does not re-fire agentIdle on a later duplicate drain report", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: 123,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    // A late/reordered duplicate SubagentStop re-reports the same
    // already-drained state post-restart.
    session.emitHookEvent({
      kind: "subagent",
      state: "finished",
      agentType: "Explore",
      backgroundTasks: [
        { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
      ],
    });

    expect(
      session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
    ).toHaveLength(0);
  });

  it("restoring an already-latched but still-outstanding turn still fires agentIdle exactly once when it later drains", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: 123,
        lastAssistantMessage: null,
        backgroundTasks: [
          { id: "t1", type: "subagent", status: "running", description: "Explore agent" },
        ],
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    session.emitHookEvent({
      kind: "subagent",
      state: "finished",
      agentType: "Explore",
      backgroundTasks: [
        { id: "t1", type: "subagent", status: "completed", description: "Explore agent" },
      ],
    });
    // The drain SCHEDULES the deferred agentIdle ping; confirm it.
    session.tick(Date.now() + 3_000);

    expect(
      session.getEvents().filter((e) => e.kind === "attention" && e.payload.attention === true),
    ).toHaveLength(1);
  });

  it("a state file written before backgroundTasks existed (no key at all) restores with the empty default", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();

    expect(info.backgroundTasks).toEqual([]);
    expect(info.outstandingBackgroundTasks).toEqual([]);
  });

  it("restores permissionState pending from state file", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "pending",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "idle",
        gatePrompt: null,
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    expect(session.toInfo().permissionState).toBe("pending");
  });

  // Issue #844 — a "waiting" gate restored from disk is known-stale: the
  // `pendingGates` socket/timer it depended on lived only in the PREVIOUS
  // process's memory and cannot have survived. spawn()'s reattach path must
  // resolve it to "lapsed" rather than leaving an answerable-looking
  // "waiting" gate that a `POST /api/sessions/:id/review-gate` click would
  // always 409 against.
  it("resolves a restored 'waiting' gate to 'lapsed' on reattach, not a live-looking zombie (issue #844)", async () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: {
        permissionState: "idle",
        planState: "idle",
        errorState: "idle",
        errorAt: null,
        errorDetail: null,
        gateState: "waiting",
        gatePrompt: "rm -rf /tmp/scratch",
        promoteState: "idle",
        promoteSummary: null,
        promoteSuggestedBaseRef: null,
        attentionKind: null,
        compactState: "idle",
        subagentCount: 0,
        elicitationState: "idle",
        elicitationServer: null,
        lastTurnEndedAt: null,
        lastAssistantMessage: null,
      },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));
    // The dtach master surviving a restart is what makes this a genuine
    // reattach rather than a fresh session — see the "reports
    // stateRestored=false..." tests below for the file this mirrors.
    fs.writeFileSync(socketPath("1"), "");

    const session = makeSession("1");
    // readStateFile() (mid-constructor) restores the raw value as-is —
    // spawn()'s reattach path is what's responsible for correcting it.
    expect(session.toInfo().gateState).toBe("waiting");

    // Mirrors PtyManager.getOrCreate()'s own ordering — onEvent is
    // subscribed BEFORE spawn() is called, which is exactly the ordering
    // constraint that makes emitting from spawn()'s savedState block (post-
    // construction) work, unlike readStateFile() (mid-constructor, before
    // any subscriber could exist).
    const seen: unknown[] = [];
    session.onEvent((event) => seen.push(event));

    await session.spawn();

    expect(session.toInfo().gateState).toBe("lapsed");
    expect(session.toInfo().gatePrompt).toBeNull();
    // resolveGate() is the only path that both emits a `review_gate` event
    // (so the timeline shows a resolution, not an orphaned "waiting" row)
    // and clears the "reviewGate" attention kind — a bare field assignment
    // would have silently skipped both.
    const gateEvents = session.getEvents().filter((e) => e.kind === "review_gate");
    expect(gateEvents).toHaveLength(1);
    expect(gateEvents[0]?.payload).toMatchObject({ state: "lapsed" });
    expect(
      seen.some(
        (e) =>
          typeof e === "object" &&
          e !== null &&
          (e as { kind?: string }).kind === "review_gate" &&
          (e as { payload?: { state?: string } }).payload?.state === "lapsed",
      ),
    ).toBe(true);
  });

  it("handles a corrupt state file gracefully by using defaults", () => {
    fs.writeFileSync(stateFilePath("1"), "not valid json");

    const session = makeSession("1");
    const info = session.toInfo();
    expect(info.stateRestored).toBe(true);
    expect(info.permissionState).toBe("idle");
  });

  it("handles a state file with missing fields by using defaults for those fields", () => {
    const state = { v: 1, launchedAtVersion: "0.0.0", state: {} };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();
    // permissionState should default to "idle" when not in the file
    expect(info.stateRestored).toBe(true);
    expect(info.permissionState).toBe("idle");
  });

  it("reports stateRestored=false when the dtach socket already exists (a real reattach) but there is no state file to restore from", () => {
    // Unlike the "fresh session, no state file" case above, an existing
    // socket means a dtach master really did survive a restart — so a
    // missing state file here is genuine data loss, not "nothing to
    // restore yet", and stateRestored must NOT be forced true.
    fs.writeFileSync(socketPath("1"), "");

    const session = makeSession("1");
    expect(session.toInfo().stateRestored).toBe(false);
  });

  it("reports stateRestored=false when the dtach socket already exists but the state file is corrupt", () => {
    fs.writeFileSync(socketPath("1"), "");
    fs.writeFileSync(stateFilePath("1"), "not valid json");

    const session = makeSession("1");
    const info = session.toInfo();
    expect(info.stateRestored).toBe(false);
    expect(info.permissionState).toBe("idle");
  });

  it("reports staleHooks=true when current version differs from launchedAtVersion", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.0.0",
      state: { permissionState: "idle" },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();
    // The current app version is "0.2.9" — older than 0.2.9 would be stale
    expect(info.staleHooks).toBe(true);
  });

  it("reports staleHooks=false when launchedAtVersion matches current version", () => {
    const { version } = JSON.parse(fs.readFileSync("package.json", "utf8")) as { version: string };
    const state = {
      v: 1,
      launchedAtVersion: version,
      state: { permissionState: "idle" },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));

    const session = makeSession("1");
    const info = session.toInfo();
    expect(info.staleHooks).toBe(false);
    expect(info.restoredVersion).toBe(version);
  });

  it("reports restoredVersion from the state file", () => {
    const state = {
      v: 1,
      launchedAtVersion: "0.1.0",
      state: { permissionState: "idle" },
    };
    fs.writeFileSync(stateFilePath("1"), JSON.stringify(state));
    const session = makeSession("1");
    expect(session.toInfo().restoredVersion).toBe("0.1.0");
  });

  it("forces a flush at MAX_WRITE_DELAY_MS even when continuous activity keeps resetting the 5s debounce window", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const session = makeSession("1");
      const filePath = stateFilePath("1");

      // Each emit lands well inside the 5s trailing-edge debounce window
      // (scheduleStateFileWrite's own setTimeout), so the debounce timer
      // keeps getting reset before it can ever fire on its own -- the ONLY
      // thing that can force a write here is the MAX_WRITE_DELAY_MS
      // (30s) ceiling armed on the very first dirty transition.
      for (let i = 0; i < 8; i++) {
        session.emitHookEvent({ kind: "notification", title: `n${i}`, body: "" });
        await vi.advanceTimersByTimeAsync(4000); // t = 4000, 8000, ..., 32000
        if (i < 7) {
          expect(fs.existsSync(filePath)).toBe(false);
        }
      }

      // The ceiling armed at t=0 for t=30000 fires within the final 4s
      // advance (t: 28000 -> 32000), despite the trailing debounce having
      // been reset every 4s the whole way through and never once reaching
      // its own 5s window uninterrupted.
      expect(fs.existsSync(filePath)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
