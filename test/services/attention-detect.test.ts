import { describe, it, expect } from "vitest";
import {
  detectAttentionSignals,
  classifyActivityFromTitle,
  detectAltScreenSwitch,
  applyMouseModeChanges,
  carryPartialEscape,
  detectCwdChange,
  carryPartialOsc,
  advanceAttention,
  ATTENTION_CONFIRM_MS,
  INITIAL_ATTENTION_STATE,
  INITIAL_MOUSE_TRACKING_STATE,
  type AttentionMachineState,
  type MouseTrackingState,
} from "../../src/services/attention-detect.js";

const ESC = "\x1b";
const BEL = "\x07";
const ST = `${ESC}\\`;

describe("detectAttentionSignals", () => {
  it("returns all-clear for plain output with no escape sequences", () => {
    expect(detectAttentionSignals("just some regular output\n")).toEqual({
      bell: false,
      notification: false,
      titleChange: null,
    });
  });

  it("detects a bare bell byte", () => {
    expect(detectAttentionSignals(`done${BEL}`)).toEqual({
      bell: true,
      notification: false,
      titleChange: null,
    });
  });

  it("detects an OSC 9 notification terminated with BEL, without counting the terminator as a bare bell", () => {
    const chunk = `${ESC}]9;Build finished${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.notification).toBe(true);
    expect(result.bell).toBe(false); // BEL is just the OSC terminator here, not a bare bell
  });

  it("detects an OSC 777 notification terminated with ST", () => {
    const chunk = `${ESC}]777;notify;Title;Body${ST}`;
    const result = detectAttentionSignals(chunk);
    expect(result.notification).toBe(true);
    expect(result.bell).toBe(false); // ST terminator, no bare BEL byte
  });

  it("extracts the payload of an OSC 2 title-change sequence", () => {
    const chunk = `${ESC}]2;my-session — waiting${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.titleChange).toBe("my-session — waiting");
    expect(result.notification).toBe(false);
  });

  it("extracts the payload of an OSC 0 icon+title sequence", () => {
    const chunk = `${ESC}]0;claude: done${ST}`;
    expect(detectAttentionSignals(chunk).titleChange).toBe("claude: done");
  });

  it("keeps the LAST title when multiple OSC 0/2 sequences appear in one chunk", () => {
    const chunk = `${ESC}]2;first${BEL}${ESC}]2;second${BEL}`;
    expect(detectAttentionSignals(chunk).titleChange).toBe("second");
  });

  it("ignores OSC codes that aren't 0/2/9/777, and doesn't count their BEL terminator as a bell", () => {
    const chunk = `${ESC}]4;1;rgb:00/00/00${BEL}`; // OSC 4 = palette color
    expect(detectAttentionSignals(chunk)).toEqual({
      bell: false,
      notification: false,
      titleChange: null,
    });
  });

  it("still detects a bare bell alongside OSC-terminator BELs in the same chunk", () => {
    const chunk = `some output${ESC}]2;title${BEL}more output${BEL}${ESC}]9;notify${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.bell).toBe(true); // the standalone BEL between "more output" and the OSC 9 sequence
    expect(result.notification).toBe(true);
    expect(result.titleChange).toBe("title");
  });

  it("does not treat a title/notification OSC sequence's BEL terminator as a bare bell", () => {
    const chunk = `some output${ESC}]2;title${BEL}more output${ESC}]9;notify${BEL}`;
    const result = detectAttentionSignals(chunk);
    expect(result.bell).toBe(false);
    expect(result.notification).toBe(true);
    expect(result.titleChange).toBe("title");
  });
});

describe("classifyActivityFromTitle", () => {
  it("reads 'working' from an explicit status word", () => {
    expect(classifyActivityFromTitle("Thinking…", "claude")).toBe("working");
    expect(classifyActivityFromTitle("opencode: Generating", "opencode")).toBe("working");
  });

  it("reads 'working' from a trailing ellipsis", () => {
    expect(classifyActivityFromTitle("Compiling...", "make")).toBe("working");
  });

  it("reads 'idle' from an explicit status word", () => {
    expect(classifyActivityFromTitle("Waiting for input", "claude")).toBe("idle");
    expect(classifyActivityFromTitle("Ready", "opencode")).toBe("idle");
  });

  it("returns null for a plain shell title, leaving the caller's own heuristic to decide", () => {
    // Bash/zsh write `user@host:cwd` into the title on every prompt draw —
    // no status word, so this must NOT be misread as "idle" or "working".
    expect(classifyActivityFromTitle("bjoern@host:~/projects/mullion", "bash")).toBeNull();
  });

  it("returns null when there is no title yet", () => {
    expect(classifyActivityFromTitle(null, "bash")).toBeNull();
  });

  it("prefers 'idle' over a trailing ellipsis when a title contains both", () => {
    // "Waiting..." matches both the idle word "Waiting" and the working
    // pattern's trailing ellipsis — the idle word must win.
    expect(classifyActivityFromTitle("Waiting...", "opencode")).toBe("idle");
  });
});

describe("applyMouseModeChanges", () => {
  it("returns the same reference (not just an equal value) for plain output with no mode switches", () => {
    const prev: MouseTrackingState = { protocol: "ANY", encoding: "SGR" };
    expect(applyMouseModeChanges("just some regular output\n", prev)).toBe(prev);
  });

  it("tracks a single protocol enable", () => {
    expect(applyMouseModeChanges(`${ESC}[?1003h`, INITIAL_MOUSE_TRACKING_STATE)).toEqual({
      protocol: "ANY",
      encoding: "DEFAULT",
    });
  });

  it("tracks a single encoding enable", () => {
    expect(applyMouseModeChanges(`${ESC}[?1006h`, INITIAL_MOUSE_TRACKING_STATE)).toEqual({
      protocol: "NONE",
      encoding: "SGR",
    });
  });

  it("tracks the confirmed #93 bug sequence: protocol and encoding enabled together", () => {
    expect(
      applyMouseModeChanges(`${ESC}[?1003h${ESC}[?1006h`, INITIAL_MOUSE_TRACKING_STATE),
    ).toEqual({ protocol: "ANY", encoding: "SGR" });
  });

  it("last-set-wins across separate calls", () => {
    let state = applyMouseModeChanges(`${ESC}[?1000h`, INITIAL_MOUSE_TRACKING_STATE);
    expect(state.protocol).toBe("VT200");
    state = applyMouseModeChanges(`${ESC}[?1003h`, state);
    expect(state.protocol).toBe("ANY");
  });

  it("resets the whole protocol axis to NONE on DECRST for any protocol code, not just the one last set (xterm's own fall-through)", () => {
    // ?1000l reset arrives while ?1003 (ANY) is the active protocol — real
    // xterm.js still collapses to NONE here (InputHandler's DECRST case
    // block falls through 9/1000/1002/1003 into one assignment), which is
    // exactly why this reducer tracks a derived enum rather than a raw
    // per-code on/off map.
    let state = applyMouseModeChanges(`${ESC}[?1003h`, INITIAL_MOUSE_TRACKING_STATE);
    expect(state.protocol).toBe("ANY");
    state = applyMouseModeChanges(`${ESC}[?1000l`, state);
    expect(state.protocol).toBe("NONE");
  });

  it("returns to the initial state on matching disable", () => {
    let state = applyMouseModeChanges(`${ESC}[?1003h${ESC}[?1006h`, INITIAL_MOUSE_TRACKING_STATE);
    state = applyMouseModeChanges(`${ESC}[?1003l${ESC}[?1006l`, state);
    expect(state).toEqual(INITIAL_MOUSE_TRACKING_STATE);
  });

  it("tracks the SGR_PIXELS encoding", () => {
    let state = applyMouseModeChanges(`${ESC}[?1016h`, INITIAL_MOUSE_TRACKING_STATE);
    expect(state.encoding).toBe("SGR_PIXELS");
    state = applyMouseModeChanges(`${ESC}[?1016l`, state);
    expect(state.encoding).toBe("DEFAULT");
  });

  it("treats 1005/1015 DECSET as a no-op but honors their DECRST as a courtesy reset to DEFAULT", () => {
    // xterm.js no longer implements 1005 (utf8 ext mode)/1015 (urxvt ext
    // mode) — DECSET for either is a no-op there, so tracking a DECSET for
    // them would silently diverge from what a real xterm.js ends up with.
    let state = applyMouseModeChanges(`${ESC}[?1006h`, INITIAL_MOUSE_TRACKING_STATE);
    state = applyMouseModeChanges(`${ESC}[?1005h`, state);
    expect(state.encoding).toBe("SGR"); // 1005h is a no-op, SGR from 1006h is untouched
    state = applyMouseModeChanges(`${ESC}[?1005l`, state);
    expect(state.encoding).toBe("DEFAULT"); // 1005l still courtesy-resets encoding
  });

  it("ignores unrelated DECSET modes (alt-screen, bracketed paste, application cursor keys)", () => {
    const prev: MouseTrackingState = { protocol: "ANY", encoding: "SGR" };
    const chunk = `${ESC}[?1049h${ESC}[?2004h${ESC}[?1h`;
    expect(applyMouseModeChanges(chunk, prev)).toBe(prev);
  });
});

describe("carryPartialEscape", () => {
  it("returns empty for a chunk with no escape byte at all", () => {
    expect(carryPartialEscape("just some regular output\n")).toBe("");
  });

  it("returns empty when the chunk ends with a fully-terminated sequence", () => {
    expect(carryPartialEscape(`hello${ESC}[?1049h`)).toBe("");
    expect(carryPartialEscape(`hello${ESC}[?1006l`)).toBe("");
  });

  it("carries a bare trailing ESC", () => {
    expect(carryPartialEscape(`some output${ESC}`)).toBe(ESC);
  });

  it("carries ESC[", () => {
    expect(carryPartialEscape(`some output${ESC}[`)).toBe(`${ESC}[`);
  });

  it("carries ESC[?", () => {
    expect(carryPartialEscape(`some output${ESC}[?`)).toBe(`${ESC}[?`);
  });

  it("carries a partial parameter (mid-digit, one byte short of the full code)", () => {
    expect(carryPartialEscape(`some output${ESC}[?104`)).toBe(`${ESC}[?104`);
  });

  it("carries the full 4-digit code when only the final h/l is missing", () => {
    expect(carryPartialEscape(`some output${ESC}[?1049`)).toBe(`${ESC}[?1049`);
  });

  it("does not carry a completed sequence followed by plain text", () => {
    expect(carryPartialEscape(`${ESC}[?1049hsome more text`)).toBe("");
  });

  it("does not carry an unrelated partial OSC sequence (different grammar, out of scope)", () => {
    expect(carryPartialEscape(`some output${ESC}]0;partial title`)).toBe("");
  });

  it("only considers the LAST escape byte in the chunk", () => {
    // A complete sequence earlier in the chunk must not confuse the tail
    // check for the dangling one at the end.
    expect(carryPartialEscape(`${ESC}[?1049h${ESC}[?100`)).toBe(`${ESC}[?100`);
  });
});

describe("detectCwdChange", () => {
  it("returns null for a chunk with no OSC 7 sequence", () => {
    expect(detectCwdChange("just some regular output\n")).toBeNull();
  });

  it("extracts an absolute path from a BEL-terminated file:// URL", () => {
    expect(detectCwdChange(`${ESC}]7;file:///home/user/project${BEL}`)).toBe("/home/user/project");
  });

  it("extracts an absolute path from an ST-terminated file:// URL", () => {
    expect(detectCwdChange(`${ESC}]7;file:///home/user/project${ST}`)).toBe("/home/user/project");
  });

  it("strips a non-empty host in the file:// URL", () => {
    expect(detectCwdChange(`${ESC}]7;file://myhost/home/user/project${BEL}`)).toBe(
      "/home/user/project",
    );
  });

  it("percent-decodes the path", () => {
    expect(detectCwdChange(`${ESC}]7;file:///home/user/my%20project${BEL}`)).toBe(
      "/home/user/my project",
    );
  });

  it("keeps the LAST cwd when multiple OSC 7 sequences appear in one chunk", () => {
    const chunk = `${ESC}]7;file:///first${BEL}${ESC}]7;file:///second${BEL}`;
    expect(detectCwdChange(chunk)).toBe("/second");
  });

  it("ignores a malformed payload that isn't a file:// URL", () => {
    expect(detectCwdChange(`${ESC}]7;not-a-url${BEL}`)).toBeNull();
  });

  it("ignores a payload with an unparseable percent-escape rather than throwing", () => {
    expect(() => detectCwdChange(`${ESC}]7;file:///home/user/bad%${BEL}`)).not.toThrow();
    expect(detectCwdChange(`${ESC}]7;file:///home/user/bad%${BEL}`)).toBeNull();
  });

  it("doesn't confuse an unrelated OSC code (e.g. OSC 2 title) for a cwd change", () => {
    expect(detectCwdChange(`${ESC}]2;my title${BEL}`)).toBeNull();
  });
});

describe("carryPartialOsc", () => {
  it("returns empty for a chunk with no escape byte at all", () => {
    expect(carryPartialOsc("just some regular output\n")).toBe("");
  });

  it("returns empty when the chunk ends with a fully-terminated OSC 7 sequence", () => {
    expect(carryPartialOsc(`${ESC}]7;file:///home/user${BEL}`)).toBe("");
    expect(carryPartialOsc(`${ESC}]7;file:///home/user${ST}`)).toBe("");
  });

  it("carries a bare trailing ESC that starts an OSC sequence", () => {
    expect(carryPartialOsc(`some output${ESC}]`)).toBe(`${ESC}]`);
  });

  it("carries an unterminated OSC 7 sequence mid-path", () => {
    const dangling = `${ESC}]7;file:///home/user/my-proj`;
    expect(carryPartialOsc(`some output${dangling}`)).toBe(dangling);
  });

  it("carries a dangling ESC that could be the start of an ST terminator", () => {
    const dangling = `${ESC}]7;file:///home/user${ESC}`;
    expect(carryPartialOsc(dangling)).toBe(dangling);
  });

  it("does not carry a completed sequence followed by plain text", () => {
    expect(carryPartialOsc(`${ESC}]7;file:///home${BEL}some more text`)).toBe("");
  });

  it("only considers the LAST escape byte in the chunk", () => {
    const dangling = `${ESC}]7;file:///second`;
    expect(carryPartialOsc(`${ESC}]7;file:///first${BEL}${dangling}`)).toBe(dangling);
  });

  it("ignores a dangling escape sequence that isn't OSC-shaped (CSI, out of scope)", () => {
    expect(carryPartialOsc(`some output${ESC}[?1049`)).toBe("");
  });

  it("known limitation: doesn't carry a fresh dangling ESC that immediately follows an already-terminated OSC 7 in the same chunk", () => {
    // A narrow, accepted gap (same "best-effort, not every edge case" scope
    // as detectAttentionSignals' own OSC parsing): once `oscStart` resolves
    // to an already-terminated sequence, this returns "" outright rather
    // than also checking for a SECOND, later dangling ESC start — the read
    // boundary would have to land at the single worst possible byte (right
    // as one sequence closes and a brand new one begins) for this to matter,
    // and the shell's next prompt draw self-heals moments later regardless.
    expect(carryPartialOsc(`${ESC}]7;file:///home/user${BEL}${ESC}`)).toBe("");
  });
});

describe("chunk-boundary split sequences (the bug carryPartialEscape closes)", () => {
  // Simulates Session's onData handler in pty-manager.ts: prepend the
  // previous chunk's carry, run both detectors, then compute the next carry.
  function step(
    data: string,
    carry: string,
    mouseState: MouseTrackingState,
  ): { altScreenSwitch: "alt" | "primary" | null; mouseState: MouseTrackingState; carry: string } {
    const combined = carry + data;
    return {
      altScreenSwitch: detectAltScreenSwitch(combined),
      mouseState: applyMouseModeChanges(combined, mouseState),
      carry: carryPartialEscape(combined),
    };
  }

  it("misses an alt-screen switch when a PTY read splits it and no carry is applied (documents the bug)", () => {
    const chunk1 = `some output${ESC}[?104`;
    const chunk2 = `9h`;
    expect(detectAltScreenSwitch(chunk1)).toBeNull();
    expect(detectAltScreenSwitch(chunk2)).toBeNull(); // "9h" alone matches nothing
  });

  it("still detects the alt-screen switch when the split lands mid-digit, via the carry", () => {
    const s1 = step(`some output${ESC}[?104`, "", INITIAL_MOUSE_TRACKING_STATE);
    expect(s1.altScreenSwitch).toBeNull();
    expect(s1.carry).toBe(`${ESC}[?104`);

    const s2 = step("9h", s1.carry, s1.mouseState);
    expect(s2.altScreenSwitch).toBe("alt");
  });

  it("still detects the alt-screen switch when the split lands right after ESC", () => {
    const s1 = step("program output", "", INITIAL_MOUSE_TRACKING_STATE);
    const s2 = step(ESC, s1.carry, s1.mouseState);
    expect(s2.carry).toBe(ESC);
    const s3 = step("[?1049h", s2.carry, s2.mouseState);
    expect(s3.altScreenSwitch).toBe("alt");
  });

  it("still detects a split mouse-tracking DECSET across two reads", () => {
    const s1 = step(`enabling mouse tracking${ESC}[?100`, "", INITIAL_MOUSE_TRACKING_STATE);
    expect(s1.mouseState).toBe(INITIAL_MOUSE_TRACKING_STATE); // no complete code yet
    const s2 = step("3h", s1.carry, s1.mouseState);
    expect(s2.mouseState.protocol).toBe("ANY");
  });

  it("does not double-detect when the sequence arrives whole (carry stays empty)", () => {
    const s1 = step(`${ESC}[?1049h`, "", INITIAL_MOUSE_TRACKING_STATE);
    expect(s1.altScreenSwitch).toBe("alt");
    expect(s1.carry).toBe("");
    const s2 = step("plain output, no escapes", s1.carry, s1.mouseState);
    expect(s2.altScreenSwitch).toBeNull();
  });

  it("byte-at-a-time split still accumulates correctly across many reads", () => {
    const bytes = `${ESC}[?1049h`.split("");
    let carry = "";
    let lastSwitch: "alt" | "primary" | null = null;
    for (const b of bytes) {
      const r = step(b, carry, INITIAL_MOUSE_TRACKING_STATE);
      carry = r.carry;
      if (r.altScreenSwitch !== null) lastSwitch = r.altScreenSwitch;
    }
    expect(lastSwitch).toBe("alt");
    expect(carry).toBe("");
  });
});

describe("advanceAttention (issue #171/#98 attention state machine)", () => {
  const T0 = 1_000_000; // arbitrary base epoch, kept small/readable in assertions

  it("stays idle and returns the same reference for plain output or a tick with no pending signal", () => {
    const output = advanceAttention(INITIAL_ATTENTION_STATE, { type: "output", now: T0 });
    expect(output.next).toBe(INITIAL_ATTENTION_STATE);
    expect(output.emit).toEqual([]);
    expect(output.log).toEqual([]);

    const tick = advanceAttention(INITIAL_ATTENTION_STATE, { type: "tick", now: T0 });
    expect(tick.next).toBe(INITIAL_ATTENTION_STATE);
  });

  it("a nonzero-threshold signal (bell) from idle enters PENDING_ATTENTION without emitting yet", () => {
    const { next, emit, log } = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    });
    expect(next).toEqual({
      state: "pending_attention",
      pendingKind: "bell",
      pendingSince: T0,
      confirmedAt: null,
      confirmedKind: null,
    });
    expect(emit).toEqual([]);
    expect(log).toEqual([{ from: "idle", to: "pending_attention", kind: "bell" }]);
  });

  it("does not confirm a tick before the pending kind's own threshold has elapsed", () => {
    const pending = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;
    const { next, emit } = advanceAttention(pending, {
      type: "tick",
      now: T0 + ATTENTION_CONFIRM_MS.bell - 1,
    });
    expect(next).toBe(pending); // unchanged
    expect(emit).toEqual([]);
  });

  it("confirms via tick exactly once the pending kind's threshold has elapsed, emitting attention:true", () => {
    const pending = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;
    const confirmAt = T0 + ATTENTION_CONFIRM_MS.bell;
    const { next, emit, log } = advanceAttention(pending, { type: "tick", now: confirmAt });
    expect(next).toEqual({
      state: "attention",
      pendingKind: null,
      pendingSince: null,
      confirmedAt: confirmAt,
      confirmedKind: "bell",
    });
    expect(emit).toEqual([{ attention: true, signal: "bell" }]);
    expect(log).toEqual([{ from: "pending_attention", to: "attention", kind: "bell" }]);
  });

  it("cancels a pending signal outright when plain output arrives before it confirms", () => {
    const pending = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;
    const { next, emit } = advanceAttention(pending, { type: "output", now: T0 + 100 });
    expect(next).toEqual(INITIAL_ATTENTION_STATE);
    expect(emit).toEqual([]);
  });

  it("a fresh signal while still pending restarts the window against the newest kind/timestamp, never confirming from the arrival alone", () => {
    // This is the exact mechanism that fixes issue #171's false positive: a
    // second (or third, fourth, ...) bell arriving before the first one's
    // window elapsed just re-arms PENDING_ATTENTION rather than being
    // treated as "still attention, extend it" the way an already-CONFIRMED
    // session's repeat signal is.
    const first = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;
    const { next, emit } = advanceAttention(first, {
      type: "signal",
      kind: "bell",
      now: T0 + 200,
    });
    expect(next).toEqual({
      state: "pending_attention",
      pendingKind: "bell",
      pendingSince: T0 + 200, // window restarted, not extended from T0
      confirmedAt: null,
      confirmedKind: null,
    });
    expect(emit).toEqual([]); // never confirmed, so nothing to emit
  });

  it("false-positive regression: a rapid BEL burst never confirms attention, only genuine silence after it does", () => {
    // Simulates a busy TUI ringing the bell every 200ms — well inside
    // ATTENTION_CONFIRM_MS.bell (2000ms) — for a full second, i.e. exactly
    // the pattern that used to trip the old ATTENTION_CLEAR_WINDOW_MS logic
    // into a transient true/false flicker on every single bell.
    let state: AttentionMachineState = INITIAL_ATTENTION_STATE;
    let lastBellAt = T0;
    for (let i = 0; i < 6; i++) {
      lastBellAt = T0 + i * 200;
      const { next, emit } = advanceAttention(state, {
        type: "signal",
        kind: "bell",
        now: lastBellAt,
      });
      state = next;
      expect(emit).toEqual([]); // never confirms mid-burst
      expect(state.state).not.toBe("attention");
    }

    // A tick shortly after the LAST bell — still short of ITS OWN
    // threshold — must not confirm either.
    const tooSoon = advanceAttention(state, {
      type: "tick",
      now: lastBellAt + ATTENTION_CONFIRM_MS.bell - 1,
    });
    expect(tooSoon.next.state).toBe("pending_attention");

    // Only once the burst genuinely stops and stays quiet for the full
    // window does it confirm — this is the correct "eventually actually
    // done" case, not a false positive.
    const confirmed = advanceAttention(state, {
      type: "tick",
      now: lastBellAt + ATTENTION_CONFIRM_MS.bell,
    });
    expect(confirmed.next.state).toBe("attention");
    expect(confirmed.emit).toEqual([{ attention: true, signal: "bell" }]);
  });

  it.each(["titleIdle", "altScreenExit", "silence"] as const)(
    "confirms a zero-threshold kind (%s) immediately from idle, with no PENDING_ATTENTION step",
    (kind) => {
      expect(ATTENTION_CONFIRM_MS[kind]).toBe(0);
      const { next, emit, log } = advanceAttention(INITIAL_ATTENTION_STATE, {
        type: "signal",
        kind,
        now: T0,
      });
      expect(next).toEqual({
        state: "attention",
        pendingKind: null,
        pendingSince: null,
        confirmedAt: T0,
        confirmedKind: kind,
      });
      expect(emit).toEqual([{ attention: true, signal: kind }]);
      expect(log).toEqual([{ from: "idle", to: "attention", kind }]);
    },
  );

  it("per-kind thresholds: a notification confirms sooner than a bare bell would at the same elapsed time", () => {
    expect(ATTENTION_CONFIRM_MS.notification).toBeLessThan(ATTENTION_CONFIRM_MS.bell);

    const pendingNotification = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "notification",
      now: T0,
    }).next;
    const pendingBell = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;

    const elapsedAt = T0 + ATTENTION_CONFIRM_MS.notification;
    expect(advanceAttention(pendingNotification, { type: "tick", now: elapsedAt }).next.state).toBe(
      "attention",
    );
    expect(advanceAttention(pendingBell, { type: "tick", now: elapsedAt }).next.state).toBe(
      "pending_attention", // not yet — bell's own, longer threshold hasn't elapsed
    );
  });

  it("a repeated signal once already confirmed refreshes confirmedAt without re-emitting or re-logging", () => {
    const confirmed: AttentionMachineState = {
      state: "attention",
      pendingKind: null,
      pendingSince: null,
      confirmedAt: T0,
      confirmedKind: "bell",
    };
    const { next, emit, log } = advanceAttention(confirmed, {
      type: "signal",
      kind: "bell",
      now: T0 + 5_000,
    });
    expect(next).toEqual({ ...confirmed, confirmedAt: T0 + 5_000, confirmedKind: "bell" });
    expect(emit).toEqual([]);
    expect(log).toEqual([]);
  });

  it("a tick while already confirmed is a no-op", () => {
    const confirmed: AttentionMachineState = {
      state: "attention",
      pendingKind: null,
      pendingSince: null,
      confirmedAt: T0,
      confirmedKind: "bell",
    };
    const { next, emit } = advanceAttention(confirmed, { type: "tick", now: T0 + 5_000 });
    expect(next).toBe(confirmed);
    expect(emit).toEqual([]);
  });

  it("plain output while confirmed clears attention, passing through CLEARING in the log within the same call", () => {
    const confirmed: AttentionMachineState = {
      state: "attention",
      pendingKind: null,
      pendingSince: null,
      confirmedAt: T0,
      confirmedKind: "bell",
    };
    const { next, emit, log } = advanceAttention(confirmed, { type: "output", now: T0 + 500 });
    expect(next).toEqual(INITIAL_ATTENTION_STATE);
    expect(emit).toEqual([{ attention: false }]);
    expect(log).toEqual([
      { from: "attention", to: "clearing" },
      { from: "clearing", to: "idle" },
    ]);
  });
});

describe("advanceAttention — output-immune confirmed kinds (attention-hook hardening follow-up)", () => {
  const T0 = 1_000_000;

  // Nonzero-threshold kinds (bell, notification) land in PENDING_ATTENTION
  // first (see enterPending) — a tick past their own threshold is needed to
  // actually reach "attention". Zero-threshold kinds confirm immediately.
  function confirmedWith(kind: AttentionMachineState["confirmedKind"]): AttentionMachineState {
    const afterSignal = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: kind!,
      now: T0,
    }).next;
    if (afterSignal.state === "attention") return afterSignal;
    const threshold = ATTENTION_CONFIRM_MS[kind!];
    return advanceAttention(afterSignal, { type: "tick", now: T0 + threshold }).next;
  }

  it.each(["hookNotification", "reviewGate", "promoteRequest"] as const)(
    "plain output does NOT clear a confirmed %s — only userInput or a superseding signal can",
    (kind) => {
      const confirmed = confirmedWith(kind);
      const { next, emit } = advanceAttention(confirmed, { type: "output", now: T0 + 500 });
      expect(next).toBe(confirmed); // noop: same reference, nothing changed
      expect(emit).toEqual([]);
    },
  );

  it.each(["bell", "notification", "titleIdle", "altScreenExit", "silence", "agentIdle"] as const)(
    "plain output still clears a confirmed %s exactly as before (output-immunity is opt-in, not global)",
    (kind) => {
      const confirmed = confirmedWith(kind);
      const { next, emit } = advanceAttention(confirmed, { type: "output", now: T0 + 500 });
      expect(next).toEqual(INITIAL_ATTENTION_STATE);
      expect(emit).toEqual([{ attention: false }]);
    },
  );

  it("a routine bell/titleIdle repaint while a reviewGate is confirmed does not downgrade confirmedKind, so immunity survives", () => {
    const confirmed = confirmedWith("reviewGate");
    const afterBell = advanceAttention(confirmed, {
      type: "signal",
      kind: "bell",
      now: T0 + 100,
    }).next;
    expect(afterBell.confirmedKind).toBe("reviewGate");
    const afterTitleIdle = advanceAttention(afterBell, {
      type: "signal",
      kind: "titleIdle",
      now: T0 + 200,
    }).next;
    expect(afterTitleIdle.confirmedKind).toBe("reviewGate");
    // Still immune: a signal-less chunk after both repaints still must not clear it.
    const { next, emit } = advanceAttention(afterTitleIdle, { type: "output", now: T0 + 300 });
    expect(next).toBe(afterTitleIdle);
    expect(emit).toEqual([]);
  });

  it("the inverse upgrades: a titleIdle confirmation followed by a reviewGate signal becomes output-immune", () => {
    const confirmed = confirmedWith("titleIdle");
    expect(confirmed.confirmedKind).toBe("titleIdle");
    const upgraded = advanceAttention(confirmed, {
      type: "signal",
      kind: "reviewGate",
      now: T0 + 100,
    }).next;
    expect(upgraded.confirmedKind).toBe("reviewGate");
    const { next, emit } = advanceAttention(upgraded, { type: "output", now: T0 + 200 });
    expect(next).toBe(upgraded); // now immune — output no longer clears
    expect(emit).toEqual([]);
  });

  it("userInput clears an immune confirmed kind unconditionally", () => {
    const confirmed = confirmedWith("hookNotification");
    const { next, emit, log } = advanceAttention(confirmed, { type: "userInput", now: T0 + 500 });
    expect(next).toEqual(INITIAL_ATTENTION_STATE);
    expect(emit).toEqual([{ attention: false }]);
    expect(log).toEqual([
      { from: "attention", to: "clearing" },
      { from: "clearing", to: "idle" },
    ]);
  });

  it("userInput clears a non-immune confirmed kind too (a real decision resolves either kind of attention)", () => {
    const confirmed = confirmedWith("bell");
    const { next } = advanceAttention(confirmed, { type: "userInput", now: T0 + 500 });
    expect(next).toEqual(INITIAL_ATTENTION_STATE);
  });

  it("userInput while PENDING_ATTENTION cancels outright, same as plain output", () => {
    const pending = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;
    const { next, emit } = advanceAttention(pending, { type: "userInput", now: T0 + 100 });
    expect(next).toEqual(INITIAL_ATTENTION_STATE);
    expect(emit).toEqual([]);
  });

  it("userInput while idle is a no-op", () => {
    const { next, emit, log } = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "userInput",
      now: T0,
    });
    expect(next).toBe(INITIAL_ATTENTION_STATE);
    expect(emit).toEqual([]);
    expect(log).toEqual([]);
  });

  it("confirmedKind is null in INITIAL_ATTENTION_STATE and after cancelPending/clearAttention", () => {
    expect(INITIAL_ATTENTION_STATE.confirmedKind).toBeNull();
    const confirmed = confirmedWith("reviewGate");
    const cleared = advanceAttention(confirmed, { type: "userInput", now: T0 + 500 }).next;
    expect(cleared.confirmedKind).toBeNull();
    const pending = advanceAttention(INITIAL_ATTENTION_STATE, {
      type: "signal",
      kind: "bell",
      now: T0,
    }).next;
    expect(pending.confirmedKind).toBeNull();
    const cancelled = advanceAttention(pending, { type: "output", now: T0 + 100 }).next;
    expect(cancelled.confirmedKind).toBeNull();
  });
});
