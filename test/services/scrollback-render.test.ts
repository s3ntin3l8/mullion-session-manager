import { describe, it, expect } from "vitest";
import { renderScrollback } from "../../src/services/scrollback-render.js";

const ESC = "\x1b";
const enc = (s: string) => Buffer.from(s, "utf8");
const size = { cols: 40, rows: 6 };

describe("renderScrollback (issue #2112)", () => {
  it("returns plain output unchanged", async () => {
    const out = await renderScrollback(enc("hello\r\nworld\r\n"), size);
    expect(out).toBe("hello\nworld");
  });

  it("resolves in-place repaints to the final screen (a spinner overwritten by its result)", async () => {
    const frames = ["|", "/", "-", "\\"].map((f) => `\r${ESC}[2K${f} thinking`).join("");
    const out = await renderScrollback(enc(`${frames}\r${ESC}[2K✓ the answer is 42\r\n`), size);
    expect(out).toBe("✓ the answer is 42");
    expect(out).not.toContain("thinking");
  });

  it("applies cursor movement: a line rewritten after moving up", async () => {
    const out = await renderScrollback(
      enc(`first\r\nsecond\r\nthird\r\n${ESC}[2A${ESC}[2Kreplaced\r\n`),
      size,
    );
    expect(out.split("\n")).toEqual(["first", "replaced", "third"]);
  });

  it("keeps lines that scrolled off the visible screen", async () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\r\n");
    const out = await renderScrollback(enc(text), { cols: 40, rows: 5 });
    const lines = out.split("\n");
    expect(lines[0]).toBe("line 0");
    expect(lines.at(-1)).toBe("line 29");
  });

  it("returns the normal buffer, then the alternate screen, when the program ends on it", async () => {
    const out = await renderScrollback(enc(`before\r\n${ESC}[?1049h${ESC}[HTUI screen\r\n`), size);
    expect(out).toBe("before\n--- alternate screen ---\nTUI screen");
  });

  it("returns only the normal buffer after the alternate screen was left", async () => {
    const out = await renderScrollback(
      enc(`before\r\n${ESC}[?1049hgarbage${ESC}[?1049l after\r\n`),
      size,
    );
    expect(out).not.toContain("garbage");
    expect(out).toContain("before");
  });

  it("wraps at the given width", async () => {
    const out = await renderScrollback(enc("abcdefghij"), { cols: 5, rows: 4 });
    expect(out).toBe("abcde\nfghij");
  });

  it("keeps only the last maxLines lines", async () => {
    const text = Array.from({ length: 50 }, (_, i) => `l${i}`).join("\r\n");
    const out = await renderScrollback(enc(text), { cols: 20, rows: 5, maxLines: 3 });
    expect(out.split("\n")).toEqual(["l47", "l48", "l49"]);
  });

  it("returns an empty string for no output", async () => {
    expect(await renderScrollback(new Uint8Array(), size)).toBe("");
  });

  it("survives garbage bytes", async () => {
    const out = await renderScrollback(Buffer.from([0xff, 0xfe, 0x1b, 0x5b, 0x99, 0x41]), size);
    expect(typeof out).toBe("string");
  });
});
