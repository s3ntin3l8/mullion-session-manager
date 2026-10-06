// Terminal-mode truth tracked from the byte stream a Session observes —
// alt-screen, mouse tracking, bracketed paste — plus the two detect carries
// that let a sequence split across a PTY read boundary still be recognized,
// and the synthesis of the scrollback-replay preamble from that tracked
// state. Extracted from pty-manager.ts's Session (issue #1544); behaviour is
// unchanged. See Session.onData for the order these steps are driven in
// (alt-screen first, so Session can emit its status_change event BEFORE the
// remaining modes/carries update — which is why this class exposes
// fine-grained steps rather than one observe() call).
import {
  detectAltScreenSwitch,
  applyMouseModeChanges,
  carryPartialEscape,
  detectCwdChange,
  carryPartialOsc,
  detectBracketedPaste,
  INITIAL_MOUSE_TRACKING_STATE,
  type MouseTrackingState,
} from "./attention-detect.js";

// The two escape sequences synthesized as a scrollback-replay preamble (see
// Session.getScrollback()) — the modern alt-screen-buffer pair. Prepending
// one of these lets a fresh xterm.js land in the tracked TRUE screen mode
// rather than whatever mode the raw buffered bytes happen to leave it in.
const ALT_SCREEN_ENTER = "\x1b[?1049h";
const ALT_SCREEN_EXIT = "\x1b[?1049l";

// Canonical enable sequences synthesized into the scrollback-replay preamble
// for tracked mouse-tracking state (see MouseTrackingState in
// attention-detect.ts) — same "always emit the modern form regardless of
// which variant the program actually used" rationale as ALT_SCREEN_ENTER/EXIT
// above. Only enable sequences are needed: when tracked state is the default
// (protocol "NONE" / encoding "DEFAULT"), nothing is appended to the preamble
// at all — see buildPreamble().
const MOUSE_PROTOCOL_ENABLE: Record<Exclude<MouseTrackingState["protocol"], "NONE">, string> = {
  X10: "\x1b[?9h",
  VT200: "\x1b[?1000h",
  DRAG: "\x1b[?1002h",
  ANY: "\x1b[?1003h",
};
const MOUSE_ENCODING_ENABLE: Record<Exclude<MouseTrackingState["encoding"], "DEFAULT">, string> = {
  SGR: "\x1b[?1006h",
  SGR_PIXELS: "\x1b[?1016h",
};

const BRACKETED_PASTE_ENABLE = "\x1b[?2004h";

/** The persisted shape (`StoredStateFields.termModes`). */
export interface StoredTermModes {
  inAltScreen: boolean;
  mouseTracking: MouseTrackingState;
  bracketedPaste?: boolean;
}

/** What {@link TerminalModeTracker.applyAltScreen} learned from a chunk. */
export interface AltScreenResult {
  /** The mode the chunk landed on (even if it re-asserted the current one). */
  mode: "alt" | "primary";
  /** End offset of the matched sequence, relative to the detect chunk. */
  endIndex: number;
  /** True only on a genuine flip (not a re-assertion of the tracked mode). */
  flipped: boolean;
  /** True only on a genuine alt -> primary flip. */
  exited: boolean;
}

export class TerminalModeTracker {
  /** Tracked screen-mode truth (issue #83) — see Session.getScrollback(). */
  inAltScreen = false;
  /** Tracked mouse-tracking mode (issue #93). */
  mouseTracking: MouseTrackingState = INITIAL_MOUSE_TRACKING_STATE;
  /** Tracked bracketed-paste mode, DECSET/DECRST 2004 (issue #1155). */
  bracketedPaste = false;
  // Unterminated CSI prefix dangling at the end of the previous chunk —
  // detection-only, never used for scrollback or fan-out.
  private detectCarry = "";
  // Same role for OSC 7's variable-length payload (see carryPartialOsc).
  private cwdDetectCarry = "";

  /** True when both carries are empty (the plain-chunk fast path needs this). */
  get carriesEmpty(): boolean {
    return this.detectCarry === "" && this.cwdDetectCarry === "";
  }

  /** Length of the CSI carry that prefixes the next detect chunk. */
  get detectCarryLength(): number {
    return this.detectCarry.length;
  }

  /** The copy of `data` the CSI detectors should scan (carry + data). */
  detectChunk(data: string): string {
    return this.detectCarry + data;
  }

  /**
   * Alt-screen detection over `detectChunk`. Updates `inAltScreen` only on a
   * genuine flip (issue #166's transition guard). Returns null when the chunk
   * carries no switch at all.
   */
  applyAltScreen(detectChunk: string): AltScreenResult | null {
    const sw = detectAltScreenSwitch(detectChunk);
    if (sw === null) return null;
    const nowInAltScreen = sw.mode === "alt";
    const flipped = nowInAltScreen !== this.inAltScreen;
    const exited = flipped && this.inAltScreen && !nowInAltScreen;
    if (flipped) this.inAltScreen = nowInAltScreen;
    return { mode: sw.mode, endIndex: sw.endIndex, flipped, exited };
  }

  /** Mouse + bracketed-paste updates, then refreshes the CSI carry. */
  applyInputModes(detectChunk: string): void {
    this.mouseTracking = applyMouseModeChanges(detectChunk, this.mouseTracking);
    const bpChange = detectBracketedPaste(detectChunk);
    if (bpChange !== null) this.bracketedPaste = bpChange;
    this.detectCarry = carryPartialEscape(detectChunk);
  }

  /**
   * OSC 7 live-cwd detection over `data` with its own carry (an OSC 7 payload
   * is a full path, so a read boundary landing mid-path is a real
   * possibility). Returns the announced cwd, or null.
   */
  detectCwd(data: string): string | null {
    const cwdDetectChunk = this.cwdDetectCarry + data;
    const cwdChange = detectCwdChange(cwdDetectChunk);
    this.cwdDetectCarry = carryPartialOsc(cwdDetectChunk);
    return cwdChange;
  }

  /** Drop the CSI carry — a byte-stream artifact of the old attach-client. */
  clearDetectCarry(): void {
    this.detectCarry = "";
  }

  /** Drop the OSC carry — same reasoning as {@link clearDetectCarry}. */
  clearCwdDetectCarry(): void {
    this.cwdDetectCarry = "";
  }

  /**
   * Restore from a persisted `termModes` (Session.readStateFile only).
   * Validated rather than trusted: a malformed shape is skipped, not thrown,
   * and a `protocol`/`encoding` outside the enum xterm.js supports would
   * otherwise poison {@link buildPreamble}'s index lookups, so the mouse
   * state alone falls back to "no tracking" while a valid inAltScreen still
   * restores. A stored bracketedPaste is deliberately NOT restored (forced
   * false): a stale `true` would wrap the next paste in bytes a program not
   * in bracketed-paste mode won't strip, so the respawned program must
   * re-enable it itself.
   */
  restore(termModes: StoredTermModes | null | undefined): void {
    if (termModes != null && typeof termModes.inAltScreen === "boolean") {
      this.inAltScreen = termModes.inAltScreen;
      const { protocol, encoding } = termModes.mouseTracking ?? INITIAL_MOUSE_TRACKING_STATE;
      const validProtocol = protocol === "NONE" || Object.hasOwn(MOUSE_PROTOCOL_ENABLE, protocol);
      const validEncoding =
        encoding === "DEFAULT" || Object.hasOwn(MOUSE_ENCODING_ENABLE, encoding);
      if (validProtocol && validEncoding) {
        this.mouseTracking = { protocol, encoding };
      }
    }
    if (termModes != null && typeof termModes.bracketedPaste === "boolean") {
      this.bracketedPaste = false;
    }
  }

  /** The persisted snapshot (`StoredStateFields.termModes`). */
  snapshot(): StoredTermModes {
    return {
      inAltScreen: this.inAltScreen,
      mouseTracking: this.mouseTracking,
      bracketedPaste: this.bracketedPaste,
    };
  }

  /**
   * The scrollback-replay preamble synthesized from tracked state: always an
   * explicit alt-screen enter/exit, then mouse protocol/encoding enables
   * (only when non-default), then bracketed paste (only when active).
   */
  buildPreamble(): Buffer {
    const altPreamble = this.inAltScreen ? ALT_SCREEN_ENTER : ALT_SCREEN_EXIT;
    let mousePreamble = "";
    if (this.mouseTracking.protocol !== "NONE") {
      mousePreamble += MOUSE_PROTOCOL_ENABLE[this.mouseTracking.protocol];
    }
    if (this.mouseTracking.encoding !== "DEFAULT") {
      mousePreamble += MOUSE_ENCODING_ENABLE[this.mouseTracking.encoding];
    }
    const bpPreamble = this.bracketedPaste ? BRACKETED_PASTE_ENABLE : "";
    return Buffer.from(altPreamble + mousePreamble + bpPreamble, "utf8");
  }
}
