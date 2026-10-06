import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  applyStoredState,
  type ApplyStoredStateOptions,
  type StoredStateFields,
  type StoredStateHost,
} from "../../src/services/session-state-persistence.js";
import { AttentionTracker } from "../../src/services/attention-tracker.js";
import { GateRegistry } from "../../src/services/gate-registry.js";
import { TerminalModeTracker } from "../../src/services/terminal-mode-tracker.js";

const NOW = 1_700_000_000_000;

interface Rig {
  host: StoredStateHost;
  log: string[];
  fields: Record<string, unknown>;
  attention: AttentionTracker;
  gates: GateRegistry;
  modes: TerminalModeTracker;
}

function makeRig(): Rig {
  const log: string[] = [];
  const fields: Record<string, unknown> = {};
  const emit = (kind: string, payload: Record<string, unknown>) => {
    log.push(`emit:${kind}:${String(payload.state)}`);
  };
  const attention = new AttentionTracker({ sessionId: "1", emitEvent: emit });
  const gates = new GateRegistry({
    emitEvent: emit,
    clearReviewGateAttention: () => attention.clearIfConfirmedKind("reviewGate"),
  });
  const modes = new TerminalModeTracker();
  const names = [
    "permissionState",
    "planState",
    "errorState",
    "errorAt",
    "errorDetail",
    "promoteState",
    "promoteSummary",
    "promoteSuggestedBaseRef",
    "compactState",
    "subagentCount",
    "subagents",
    "elicitationState",
    "elicitationServer",
    "questionState",
    "questionHeader",
    "questionAt",
    "lastAssistantMessage",
    "currentTodo",
  ] as const;
  const set = Object.fromEntries(
    names.map((n) => [
      n,
      (v: unknown) => {
        fields[n] = v;
        log.push(`set:${n}`);
      },
    ]),
  ) as unknown as StoredStateHost["set"];
  const host: StoredStateHost = {
    set,
    attention,
    gates,
    modes,
    emitEvent: emit,
    stampRestoredLatches: () => log.push("stamp"),
  };
  return { host, log, fields, attention, gates, modes };
}

function fullState(over: Partial<StoredStateFields> = {}): StoredStateFields {
  return {
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
    subagents: [],
    elicitationState: "idle",
    elicitationServer: null,
    questionState: "idle",
    questionHeader: null,
    questionAt: null,
    lastTurnEndedAt: null,
    lastAssistantMessage: null,
    currentTodo: null,
    backgroundTasks: [],
    ...over,
  } as StoredStateFields;
}

const FILE: ApplyStoredStateOptions = {
  lapseWaitingGate: false,
  restoreAttentionKind: true,
  restoreTermModes: true,
};
const RESPAWN: ApplyStoredStateOptions = {
  lapseWaitingGate: true,
  restoreAttentionKind: false,
  restoreTermModes: false,
};

describe("applyStoredState", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("assigns every plain field through the host setters", () => {
    const r = makeRig();
    applyStoredState(
      r.host,
      fullState({
        permissionState: "pending",
        errorState: "error",
        errorAt: 5,
        errorDetail: "boom",
        compactState: "compacting",
        subagentCount: 2,
        elicitationState: "pending",
        elicitationServer: "srv",
        questionState: "pending",
        questionHeader: "h",
        questionAt: 9,
        lastAssistantMessage: "hi",
        currentTodo: "todo",
        promoteState: "pending",
        promoteSummary: "sum",
        promoteSuggestedBaseRef: "main",
      }),
      FILE,
    );
    expect(r.fields).toMatchObject({
      permissionState: "pending",
      errorState: "error",
      errorAt: 5,
      errorDetail: "boom",
      compactState: "compacting",
      subagentCount: 2,
      elicitationState: "pending",
      elicitationServer: "srv",
      questionState: "pending",
      questionHeader: "h",
      questionAt: 9,
      lastAssistantMessage: "hi",
      currentTodo: "todo",
      promoteState: "pending",
      promoteSummary: "sum",
      promoteSuggestedBaseRef: "main",
    });
  });

  it("skips fields missing from an older state file (partial input) — and subagents that are not an array", () => {
    const r = makeRig();
    applyStoredState(
      r.host,
      { permissionState: "pending", subagents: "garbage" as never, backgroundTasks: null as never },
      FILE,
    );
    expect(Object.keys(r.fields)).toEqual(["permissionState"]);
  });

  it("a complete snapshot (spawn()'s collectState()) is applied in full — the guards skip nothing", () => {
    const r = makeRig();
    applyStoredState(r.host, fullState(), RESPAWN);
    const setCalls = r.log.filter((l) => l.startsWith("set:"));
    expect(setCalls).toHaveLength(18); // every setter key, none skipped
  });

  it("restores subagents as the array handed to the setter", () => {
    const r = makeRig();
    const subagents = [{ agentId: "a", startedAt: 1, endedAt: null }] as never;
    applyStoredState(r.host, fullState({ subagents }), FILE);
    expect(r.fields.subagents).toBe(subagents);
  });

  describe("gate", () => {
    const waiting = fullState({ gateState: "waiting", gatePrompt: "approve?" });

    it("lapseWaitingGate:false (readStateFile) restores a waiting gate verbatim, silently", () => {
      const r = makeRig();
      applyStoredState(r.host, waiting, FILE);
      expect([r.gates.state, r.gates.prompt]).toEqual(["waiting", "approve?"]);
      expect(r.log.some((l) => l.startsWith("emit:"))).toBe(false);
    });

    it("lapseWaitingGate:true (spawn) lapses it, emits review_gate, clears the reviewGate attention", () => {
      const r = makeRig();
      r.attention.state = {
        ...r.attention.state,
        state: "attention",
        confirmedKind: "reviewGate",
        confirmedAt: NOW,
      } as never;
      applyStoredState(r.host, waiting, RESPAWN);
      expect([r.gates.state, r.gates.prompt, r.gates.at]).toEqual(["lapsed", null, null]);
      expect(r.log).toContain("emit:review_gate:lapsed");
      expect(r.attention.state.confirmedKind).not.toBe("reviewGate");
    });

    it("the lapse fires at the gate's position: after errorDetail, before promoteState", () => {
      const r = makeRig();
      applyStoredState(r.host, waiting, RESPAWN);
      const lapse = r.log.indexOf("emit:review_gate:lapsed");
      expect(lapse).toBeGreaterThan(r.log.indexOf("set:errorDetail"));
      expect(lapse).toBeLessThan(r.log.indexOf("set:promoteState"));
    });

    it("lapseWaitingGate:true leaves a non-waiting gate as stored", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ gateState: "approved", gatePrompt: null }), RESPAWN);
      expect(r.gates.state).toBe("approved");
      expect(r.log.some((l) => l.startsWith("emit:"))).toBe(false);
    });
  });

  describe("attentionKind", () => {
    it("restoreAttentionKind:true re-signals a persisted kind into the attention machine", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ attentionKind: "permissionRequest" }), FILE);
      expect(r.attention.state.confirmedKind).toBe("permissionRequest");
    });

    it("restoreAttentionKind:true with a null kind leaves the machine idle", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ attentionKind: null }), FILE);
      expect(r.attention.state.confirmedKind).toBeNull();
    });

    it("restoreAttentionKind:false (spawn) ignores a persisted kind", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ attentionKind: "permissionRequest" }), RESPAWN);
      expect(r.attention.state.confirmedKind).toBeNull();
    });
  });

  describe("termModes", () => {
    const termModes = {
      inAltScreen: true,
      mouseTracking: { protocol: "ANY", encoding: "SGR" },
      bracketedPaste: true,
    } as const;

    it("restoreTermModes:true restores alt-screen/mouse and never bracketed paste", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ termModes }), FILE);
      expect(r.modes.inAltScreen).toBe(true);
      expect(r.modes.mouseTracking).toEqual({ protocol: "ANY", encoding: "SGR" });
      expect(r.modes.bracketedPaste).toBe(false);
    });

    it("restoreTermModes:false (spawn) leaves tracked modes untouched", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ termModes }), RESPAWN);
      expect(r.modes.inAltScreen).toBe(false);
      expect(r.modes.mouseTracking).toEqual({ protocol: "NONE", encoding: "DEFAULT" });
    });
  });

  it("stamps latches after every field/background-task restore, in both modes", () => {
    for (const opts of [FILE, RESPAWN]) {
      const r = makeRig();
      applyStoredState(r.host, fullState(), opts);
      const stamp = r.log.indexOf("stamp");
      expect(stamp).toBeGreaterThan(r.log.lastIndexOf("set:currentTodo"));
      expect(r.log.filter((l) => l === "stamp")).toHaveLength(1);
    }
  });

  describe("lastTurnEndedAt / backgroundTasks / turnEndPingSent", () => {
    it("restores lastTurnEndedAt and marks the ping already sent when nothing is outstanding", () => {
      const r = makeRig();
      applyStoredState(r.host, fullState({ lastTurnEndedAt: 123 }), FILE);
      expect(r.attention.lastTurnEndedAt).toBe(123);
      expect(r.attention.turnEndPingSent).toBe(true);
    });

    it("leaves the ping unsent while a background task is still outstanding, re-stamping its timestamp to now", () => {
      const r = makeRig();
      const backgroundTasks = [
        { id: "t1", kind: "bash", status: "running", description: "x", startedAt: 1 },
      ] as never;
      applyStoredState(r.host, fullState({ lastTurnEndedAt: 123, backgroundTasks }), RESPAWN);
      expect(r.attention.turnEndPingSent).toBe(false);
      expect(r.attention.backgroundTasksAt).toBe(NOW);
    });

    it("does not derive turnEndPingSent without a latched turn", () => {
      const r = makeRig();
      r.attention.turnEndPingSent = true;
      applyStoredState(r.host, fullState({ lastTurnEndedAt: null }), FILE);
      expect(r.attention.turnEndPingSent).toBe(true);
    });
  });
});
