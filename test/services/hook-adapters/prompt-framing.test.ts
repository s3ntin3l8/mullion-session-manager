import { describe, expect, it } from "vitest";
import {
  MAX_PROMPT_BYTES,
  sanitizePromptText,
  standardPromptFraming,
} from "../../../src/services/hook-adapters/shared.js";
import { getAdapterPromptFraming } from "../../../src/services/hook-adapters/index.js";

const PASTE = { bracketedPaste: true };
const PLAIN = { bracketedPaste: false };

describe("standardPromptFraming", () => {
  it("wraps the text in bracketed-paste markers and submits with Enter after a delay", () => {
    expect(standardPromptFraming("hello", PASTE)).toEqual({
      body: "\u001b[200~hello\u001b[201~",
      submit: "\r",
      submitDelayMs: 150,
    });
  });

  it("keeps newlines inside the paste (CRLF/CR normalized to LF)", () => {
    expect(standardPromptFraming("a\r\nb\rc", PASTE).body).toBe("\u001b[200~a\nb\nc\u001b[201~");
  });

  it("without bracketed paste, collapses lines to single spaces (a bare newline would submit)", () => {
    expect(standardPromptFraming("  first\n\n  second \n third ", PLAIN).body).toBe(
      "first second third",
    );
  });

  it("strips ESC and other control characters, so text cannot end the paste early or inject keystrokes", () => {
    const evil = "ok\u001b[201~\u0003\u0004rm -rf /\u001b[200~\u0000\u007f";
    for (const ctx of [PASTE, PLAIN]) {
      const body = standardPromptFraming(evil, ctx).body;
      const inner = ctx.bracketedPaste
        ? body.slice("\u001b[200~".length, -"\u001b[201~".length)
        : body;
      // eslint-disable-next-line no-control-regex
      expect(inner).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
      expect(inner).toBe("ok[201~rm -rf /[200~");
    }
  });

  it("strips C1 controls (incl. the 8-bit CSI U+009B) and bidi marks, and treats U+0085/U+2028/U+2029 as newlines", () => {
    const body = (text: string, ctx: { bracketedPaste: boolean }) =>
      standardPromptFraming(text, ctx).body;
    expect(body("a\u009b31mb\u0090c\u202ed\u2066e", PASTE)).toBe("\u001b[200~a31mbcde\u001b[201~");
    expect(body("a\u0085b\u2028c\u2029d", PASTE)).toBe("\u001b[200~a\nb\nc\nd\u001b[201~");
    expect(body("a\u0085b\u2028c", PLAIN)).toBe("a b c");
  });

  it("without bracketed paste, a raw tab (a completion keypress) becomes a space", () => {
    expect(standardPromptFraming("a\tb", PLAIN).body).toBe("a b");
    expect(standardPromptFraming("a\tb", PASTE).body).toBe("\u001b[200~a\tb\u001b[201~");
  });

  it("sanitizePromptText leaves nothing for control-only text", () => {
    expect(sanitizePromptText("\u001b\u0003\u009b").trim()).toBe("");
  });

  it("keeps tabs and non-ASCII text intact", () => {
    expect(standardPromptFraming("a\tb — ünï 日本", PASTE).body).toBe(
      "\u001b[200~a\tb — ünï 日本\u001b[201~",
    );
  });

  it("exposes a sane prompt size cap", () => {
    expect(MAX_PROMPT_BYTES).toBe(32 * 1024);
  });
});

describe("getAdapterPromptFraming", () => {
  it.each(["claude", "claude --model sonnet", "codex", "opencode"])(
    "frames a prompt for %s",
    (command) => {
      expect(getAdapterPromptFraming(command, "hi", PASTE)).toMatchObject({
        body: "\u001b[200~hi\u001b[201~",
        submit: "\r",
      });
    },
  );

  it.each(["bash", "zsh", "agy", "aider", "gemini", ""])(
    "has no prompt delivery for %j (shell, agy, or unknown CLI)",
    (command) => {
      expect(getAdapterPromptFraming(command, "hi", PASTE)).toBeNull();
    },
  );
});
