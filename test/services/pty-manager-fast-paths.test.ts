import { describe, it, expect } from "vitest";
import {
  detectAttentionSignals,
  detectAltScreenSwitch,
  applyMouseModeChanges,
  detectBracketedPaste,
  carryPartialEscape,
  detectCwdChange,
  carryPartialOsc,
  INITIAL_MOUSE_TRACKING_STATE,
} from "../../src/services/attention-detect.js";
import { isGenuineUserInput } from "../../src/services/pty-manager.js";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomString(rand: () => number, alphabet: string[], maxLen: number): string {
  const n = Math.floor(rand() * maxLen);
  let s = "";
  for (let i = 0; i < n; i++) s += alphabet[Math.floor(rand() * alphabet.length)];
  return s;
}

// Plain text including the bracket/digit/semicolon pieces of every escape
// sequence the detectors look for — but no ESC (0x1b) and no BEL (0x07).
const PLAIN_ALPHABET = [..."abc XYZ019;?[]\\hlmMRIO<>:/#é\n\r\t"];

describe("onData fast-path premise (issue #1523): ESC/BEL-free chunks are a no-op for every detector", () => {
  it("every detector returns its 'nothing found' result and leaves no carry", () => {
    const rand = mulberry32(7);
    for (let i = 0; i < 500; i++) {
      const chunk = randomString(rand, PLAIN_ALPHABET, 80);
      expect(detectAltScreenSwitch(chunk)).toBeNull();
      expect(applyMouseModeChanges(chunk, INITIAL_MOUSE_TRACKING_STATE)).toBe(
        INITIAL_MOUSE_TRACKING_STATE,
      );
      expect(detectBracketedPaste(chunk)).toBeNull();
      expect(carryPartialEscape(chunk)).toBe("");
      expect(detectCwdChange(chunk)).toBeNull();
      expect(carryPartialOsc(chunk)).toBe("");
      expect(detectAttentionSignals(chunk)).toEqual({
        bell: false,
        notification: false,
        titleChange: null,
      });
    }
  });
});

// The pre-#1523 implementation, verbatim, as the reference.
/* eslint-disable no-control-regex */
const REFERENCE_SHAPES: RegExp[] = [
  /\x1b\[[IO]/g,
  /\x1b\[M[\s\S]{3}/g,
  /\x1b\[<\d+;\d+;\d+[Mm]/g,
  /\x1b\[\d+;\d+R/g,
  /\x1b\[>?\??[\d;]*c/g,
  /\x1b\](?:10|11|12);[^\x07\x1b]*(?:\x07|\x1b\\)/g,
  /\x1b\[\?997;[12]n/g,
];
/* eslint-enable no-control-regex */
function referenceIsGenuine(data: string): boolean {
  let remainder = data;
  for (const shape of REFERENCE_SHAPES) remainder = remainder.replace(shape, "");
  return remainder.length > 0;
}

describe("isGenuineUserInput fast path (issue #1523)", () => {
  it("matches the reference implementation on random mixes of text and automated replies", () => {
    const rand = mulberry32(99);
    const pieces = [
      "a",
      "ls\r",
      "\x03",
      " ",
      "é",
      "\x1b[I",
      "\x1b[O",
      "\x1b[M abc",
      "\x1b[<0;10;20M",
      "\x1b[12;40R",
      "\x1b[?1;2c",
      "\x1b]11;rgb:0000/0000/0000\x07",
      "\x1b[?997;1n",
      "\x1b",
      "\x1b[A",
      "\x1b[200~paste\x1b[201~",
    ];
    for (let i = 0; i < 1000; i++) {
      const data = randomString(rand, pieces, 6);
      expect(isGenuineUserInput(data)).toBe(referenceIsGenuine(data));
    }
  });

  it("empty input is not genuine, plain input is", () => {
    expect(isGenuineUserInput("")).toBe(false);
    expect(isGenuineUserInput("x")).toBe(true);
    expect(isGenuineUserInput("\x1b[I")).toBe(false);
  });
});
