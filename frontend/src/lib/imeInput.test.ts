// @vitest-environment jsdom
//
// The `attachImeInput` cases below drive a REAL `@xterm/xterm` Terminal (not the
// module-level mock TerminalPane.test.tsx uses) with the event shapes captured
// from Gboard on an Android 16 emulator: every key is a keyCode-229 keydown, a
// `beforeinput` and an `input` (insertText) on the helper textarea, and a
// suggestion tap fires TWO 229 keydowns before its single insert.
import { Terminal } from "@xterm/xterm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachImeInput, diffEdit } from "./imeInput.js";

describe("diffEdit", () => {
  it("reports a pure append", () => {
    expect(diffEdit("git hel", "git help")).toEqual({ removed: 0, inserted: "p" });
  });
  it("reports a tail replacement as removed + inserted", () => {
    expect(diffEdit("git helo", "git hello ")).toEqual({ removed: 1, inserted: "lo " });
  });
  it("reports a deletion", () => {
    expect(diffEdit("git hel", "git he")).toEqual({ removed: 1, inserted: "" });
  });
  it("reports a prepend (Gboard inserts at caret 0 in a bare textarea)", () => {
    expect(diffEdit("leh", "lleh")).toEqual({ removed: 0, inserted: "l" });
  });
  it("reports nothing for an unchanged value", () => {
    expect(diffEdit("abc", "abc")).toEqual({ removed: 0, inserted: "" });
  });
});

function keydown229(ta: HTMLTextAreaElement): void {
  const ev = new KeyboardEvent("keydown", { key: "Unidentified", bubbles: true, cancelable: true });
  // jsdom ignores keyCode in KeyboardEventInit; xterm checks it.
  Object.defineProperty(ev, "keyCode", { value: 229 });
  ta.dispatchEvent(ev);
}

// One Gboard edit: `keydowns` 229 keydowns, then beforeinput -> mutate -> input.
function edit(
  ta: HTMLTextAreaElement,
  change: (current: string) => string,
  inputType = "insertText",
  keydowns = 1,
): void {
  for (let i = 0; i < keydowns; i++) keydown229(ta);
  ta.dispatchEvent(new InputEvent("beforeinput", { inputType, bubbles: true, cancelable: true }));
  ta.value = change(ta.value);
  ta.dispatchEvent(new InputEvent("input", { inputType, bubbles: true }));
  vi.runAllTimers();
}
const append = (chunk: string) => (current: string) => current + chunk;

describe("attachImeInput against a real xterm Terminal", () => {
  let term: Terminal;
  let ta: HTMLTextAreaElement;
  let sent: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    term = new Terminal({ cols: 80, rows: 24 });
    term.open(document.body.appendChild(document.createElement("div")));
    ta = term.textarea as HTMLTextAreaElement;
    sent = [];
    term.onData((d) => sent.push(d));
  });
  afterEach(() => {
    term.dispose();
    vi.useRealTimers();
  });

  function typeLine(text: string): void {
    for (const ch of text) edit(ta, append(ch));
  }

  it("without it, a suggestion tap double-sends its text (the bug)", () => {
    typeLine("git helo");
    sent.length = 0;
    edit(ta, (v) => `${v}lo `, "insertText", 2);
    expect(sent).toEqual(["lo ", "lo "]);
  });

  it("sends each typed character exactly once", () => {
    attachImeInput(term);
    typeLine("git status");
    expect(sent.join("")).toBe("git status");
  });

  it("sends a suggestion commit once despite its two keydowns", () => {
    attachImeInput(term);
    typeLine("git hel");
    sent.length = 0;
    edit(ta, append("lo "), "insertText", 2);
    expect(sent.join("")).toBe("lo ");
  });

  it("turns a typo correction into DEL + replacement, never re-sending the line", () => {
    attachImeInput(term);
    typeLine("git helo");
    sent.length = 0;
    edit(ta, (v) => v.replace(/helo$/, "hello "), "insertReplacementText");
    expect(sent.join("")).toBe("\x7f" + "lo ");
    // Later keys stay incremental.
    sent.length = 0;
    typeLine("wo");
    expect(sent).toEqual(["w", "o"]);
  });

  it("maps deleteContentBackward to DEL, once per press", () => {
    attachImeInput(term);
    typeLine("git hel");
    sent.length = 0;
    edit(ta, (v) => v.slice(0, -1), "deleteContentBackward");
    edit(ta, (v) => v.slice(0, -1), "deleteContentBackward");
    expect(sent).toEqual(["\x7f", "\x7f"]);
  });

  it("leaves composing input to xterm", () => {
    const off = attachImeInput(term);
    const spy = vi.spyOn(term, "input");
    ta.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    keydown229(ta);
    ta.dispatchEvent(
      new InputEvent("beforeinput", { inputType: "insertCompositionText", bubbles: true }),
    );
    ta.value = "n";
    ta.dispatchEvent(
      new InputEvent("input", { inputType: "insertCompositionText", bubbles: true }),
    );
    expect(spy).not.toHaveBeenCalled();
    off();
  });

  it("stops intercepting after detach", () => {
    const off = attachImeInput(term);
    off();
    const spy = vi.spyOn(term, "input");
    typeLine("a");
    expect(spy).not.toHaveBeenCalled();
  });
});
