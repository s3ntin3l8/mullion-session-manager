import { describe, it, expect } from "vitest";
import {
  clampToBytes,
  extractMarkedRegion,
  upsertMarkedRegion,
  topLevelLines,
  upsertMarkedRegionAfterIntro,
} from "../../src/services/marked-region.js";

const START = "<!-- start -->";
const END = "<!-- end -->";

describe("extractMarkedRegion", () => {
  it("extracts the trimmed text between the markers", () => {
    const text = `before\n${START}\n  hello world  \n${END}\nafter`;
    expect(extractMarkedRegion(text, START, END)).toBe("hello world");
  });

  it("ignores text outside the markers", () => {
    const text = `IGNORE ME\n${START}\nkept\n${END}\nIGNORE ME TOO`;
    const region = extractMarkedRegion(text, START, END);
    expect(region).not.toContain("IGNORE");
  });

  it("returns null when the start marker is missing", () => {
    expect(extractMarkedRegion(`no start\n${END}`, START, END)).toBeNull();
  });

  it("returns null when the end marker is missing", () => {
    expect(extractMarkedRegion(`${START}\nno end`, START, END)).toBeNull();
  });

  it("returns null when the end marker precedes the start marker", () => {
    expect(extractMarkedRegion(`${END}\nbody\n${START}`, START, END)).toBeNull();
  });

  it("first-region-wins: a second START...END pair is not concatenated in", () => {
    const text = `${START}\nfirst\n${END}\nmiddle\n${START}\nsecond\n${END}`;
    expect(extractMarkedRegion(text, START, END)).toBe("first");
  });

  it("matches markers across CRLF line endings", () => {
    const text = `${START}\r\nhello\r\n${END}`;
    expect(extractMarkedRegion(text, START, END)).toBe("hello");
  });
});

describe("clampToBytes", () => {
  it("returns the text unchanged, no marker appended, when it already fits", () => {
    const text = "short";
    expect(clampToBytes(text, 100, "source.md")).toBe(text);
  });

  it("truncates and appends a marker naming the source when over budget", () => {
    const text = "a".repeat(50);
    const result = clampToBytes(text, 10, "source.md");
    expect(result).not.toBe(text);
    expect(result).toContain("[mullion: truncated at 10 bytes");
    expect(result).toContain("source.md");
  });

  it("the retained body portion never exceeds maxBytes", () => {
    const text = "x".repeat(1000);
    const maxBytes = 50;
    const result = clampToBytes(text, maxBytes, "source.md");
    const bodyOnly = result.split("\n\n[mullion: truncated")[0];
    expect(Buffer.byteLength(bodyOnly, "utf8")).toBeLessThanOrEqual(maxBytes);
  });

  it("never splits a multibyte UTF-8 character mid-sequence", () => {
    // "é" is 2 bytes in UTF-8; repeat enough times that a byte-oblivious
    // slice at an odd byte count would land mid-character.
    const text = "é".repeat(20);
    const result = clampToBytes(text, 7, "source.md");
    expect(result).not.toContain("�");
  });
});

describe("upsertMarkedRegion", () => {
  it("appends a fresh region to empty text", () => {
    expect(upsertMarkedRegion("", START, END, "hello")).toBe(`${START}\nhello\n${END}\n`);
  });

  it("appends a fresh region after existing content, separated by a blank line", () => {
    const result = upsertMarkedRegion("# Title\n\nSome prose.", START, END, "hello");
    expect(result).toBe(`# Title\n\nSome prose.\n\n${START}\nhello\n${END}\n`);
  });

  it("replaces an existing region in place, leaving surrounding text untouched", () => {
    const text = `before\n${START}\nold content\n${END}\nafter`;
    const result = upsertMarkedRegion(text, START, END, "new content");
    expect(result).toBe(`before\n${START}\nnew content\n${END}\nafter`);
  });

  it("trims the body before placing it between the markers", () => {
    const result = upsertMarkedRegion("", START, END, "  padded  \n");
    expect(result).toBe(`${START}\npadded\n${END}\n`);
  });

  it("only replaces the FIRST region — matches extractMarkedRegion's own first-region-only contract", () => {
    const text = `${START}\nfirst\n${END}\nmiddle\n${START}\nsecond\n${END}`;
    const result = upsertMarkedRegion(text, START, END, "replaced");
    expect(result).toBe(`${START}\nreplaced\n${END}\nmiddle\n${START}\nsecond\n${END}`);
  });

  it("drops an orphan end marker that precedes the start marker instead of leaving two", () => {
    const text = `${END}\nold\n${START}`;
    const result = upsertMarkedRegion(text, START, END, "hello");
    expect(result).toBe(`old\n\n${START}\nhello\n${END}\n`);
  });

  it("drops a lone start marker line, keeping the text around it", () => {
    const result = upsertMarkedRegion(`intro\n${START}\nhand written\n`, START, END, "hello");
    expect(result).toBe(`intro\nhand written\n\n${START}\nhello\n${END}\n`);
    expect(result.split(START)).toHaveLength(2);
  });

  it("drops a lone end marker line, keeping the text around it", () => {
    const result = upsertMarkedRegion(`intro\n${END}\nhand written\n`, START, END, "hello");
    expect(result).toBe(`intro\nhand written\n\n${START}\nhello\n${END}\n`);
  });

  it("cuts only the marker when it sits inline in prose", () => {
    const result = upsertMarkedRegion(`keep ${START} this`, START, END, "hello");
    expect(result).toBe(`keep  this\n\n${START}\nhello\n${END}\n`);
  });

  it("is stable on a second run over a half-edited file", () => {
    const once = upsertMarkedRegion(`intro\n${START}\nhand written\n`, START, END, "hello");
    expect(upsertMarkedRegion(once, START, END, "hello")).toBe(once);
  });

  it("follows a CRLF file's line endings when it removes an orphan marker", () => {
    const result = upsertMarkedRegion(`# T\r\n${START}\r\nhand\r\n`, START, END, "a\nb");
    expect(result).toBe(`# T\r\nhand\r\n\r\n${START}\r\na\r\nb\r\n${END}\r\n`);
    expect(result.replace(/\r\n/g, "")).not.toContain("\n");
  });

  it("upsertMarkedRegionAfterIntro does not double a CR in a CRLF body either", () => {
    const text = "# T\r\n\r\n## A\r\nx\r\n";
    const once = upsertMarkedRegionAfterIntro(text, START, END, "a\r\nb");
    expect(once).not.toContain("\r\r");
    expect(upsertMarkedRegionAfterIntro(once, START, END, "a\r\nb")).toBe(once);
  });

  it("is stable on a second run over a CRLF file", () => {
    const once = upsertMarkedRegion(`# T\r\n${START}\r\nhand\r\n`, START, END, "a\nb");
    expect(upsertMarkedRegion(once, START, END, "a\nb")).toBe(once);
  });

  it("does not double a CR when the body itself already has CRLF endings", () => {
    const once = upsertMarkedRegion("# T\r\nhand\r\n", START, END, "a\r\nb");
    expect(once).toBe(`# T\r\nhand\r\n\r\n${START}\r\na\r\nb\r\n${END}\r\n`);
    expect(upsertMarkedRegion(once, START, END, "a\r\nb")).toBe(once);
    expect(once).not.toContain("\r\r");
  });

  it("gives a marker-free CRLF file a CRLF region, and a re-run is byte-identical", () => {
    const once = upsertMarkedRegion("# T\r\nhand\r\n", START, END, "x");
    expect(once).toBe(`# T\r\nhand\r\n\r\n${START}\r\nx\r\n${END}\r\n`);
    expect(upsertMarkedRegion(once, START, END, "x")).toBe(once);
  });

  it("handles #-style markers like the .gitignore region", () => {
    const m1 = "# mullion:worktrees:start";
    const m2 = "# mullion:worktrees:end";
    const result = upsertMarkedRegion(`node_modules\n${m1}\n`, m1, m2, ".wt/");
    expect(result).toBe(`node_modules\n\n${m1}\n.wt/\n${m2}\n`);
  });

  it("round-trips through extractMarkedRegion", () => {
    const result = upsertMarkedRegion("# Doc", START, END, "round trip body");
    expect(extractMarkedRegion(result, START, END)).toBe("round trip body");
  });
});

describe("upsertMarkedRegionAfterIntro", () => {
  it("replaces an existing region in place, like upsertMarkedRegion", () => {
    const text = `# T\n\n${START}\nold\n${END}\n\n## A\nbody`;
    expect(upsertMarkedRegionAfterIntro(text, START, END, "new")).toBe(
      upsertMarkedRegion(text, START, END, "new"),
    );
  });

  it("inserts a new region right before the first ## heading", () => {
    const text = "# T\n\nintro prose\n\n## Workflow rules\nrule\n\n## Other\nx\n";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result).toBe(
      `# T\n\nintro prose\n\n${START}\nbody\n${END}\n\n## Workflow rules\nrule\n\n## Other\nx\n`,
    );
    expect(extractMarkedRegion(result, START, END)).toBe("body");
  });

  it("does not treat a ## line inside a fenced code block as a heading", () => {
    const text = "# T\n\n```md\n## not a heading\n```\n\n## Real\nx";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result.indexOf(START)).toBeGreaterThan(result.indexOf("```\n\n"));
    expect(result.indexOf(START)).toBeLessThan(result.indexOf("## Real"));
  });

  it("puts the region first when the file starts with a ## heading", () => {
    const result = upsertMarkedRegionAfterIntro("## A\nx", START, END, "body");
    expect(result).toBe(`${START}\nbody\n${END}\n\n## A\nx`);
  });

  it("appends when the file has no ## heading", () => {
    const result = upsertMarkedRegionAfterIntro("# T\n\nonly prose", START, END, "body");
    expect(result).toBe(`# T\n\nonly prose\n\n${START}\nbody\n${END}\n`);
  });

  it("creates the region for an empty file", () => {
    expect(upsertMarkedRegionAfterIntro("", START, END, "body")).toBe(`${START}\nbody\n${END}\n`);
  });

  it("skips a ## inside leading YAML frontmatter", () => {
    const text = "---\ntitle: x\n## k\n---\n# T\n\n## A\nx";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result.startsWith("---\ntitle: x\n## k\n---\n# T")).toBe(true);
    expect(result.indexOf(START)).toBeLessThan(result.indexOf("## A"));
    expect(result.indexOf(START)).toBeGreaterThan(result.indexOf("# T"));
  });

  it("matches fences by character and length, so a ``` line inside a ~~~ block does not close it", () => {
    const text = "# T\n~~~\n```\n## no\n~~~\n\n## Real\nx";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result.indexOf(START)).toBeGreaterThan(result.indexOf("~~~\n\n"));
    expect(result.indexOf(START)).toBeLessThan(result.indexOf("## Real"));
    const longer = "# T\n````\n```\n## no\n````\n\n## Real\nx";
    const r2 = upsertMarkedRegionAfterIntro(longer, START, END, "body");
    expect(r2.indexOf(START)).toBeGreaterThan(r2.indexOf("````\n\n"));
  });

  it("skips a ## inside a multi-line HTML comment", () => {
    const text = "# T\n\n<!--\n## hidden\n-->\n\n## Real\nx";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result.indexOf(START)).toBeGreaterThan(result.indexOf("-->"));
    expect(result.indexOf(START)).toBeLessThan(result.indexOf("## Real"));
  });

  it("drops a lone start marker (end deleted), keeps the text and places ONE fresh region", () => {
    const text = `# T\n\nintro\n${START}\nhand-written\n\n## A\nx\n`;
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result.match(new RegExp(START, "g"))).toHaveLength(1);
    expect(result.match(new RegExp(END, "g"))).toHaveLength(1);
    expect(result).toContain("hand-written");
    expect(result.indexOf(START)).toBeLessThan(result.indexOf("## A"));
    // The next run replaces only the region, never the text around it.
    const again = upsertMarkedRegionAfterIntro(result, START, END, "body2");
    expect(again).toContain("hand-written");
    expect(again).toContain("body2");
    expect(again).not.toContain("\nbody\n");
  });

  it("drops a lone end marker the same way", () => {
    const result = upsertMarkedRegionAfterIntro(`# T\nold\n${END}\n## A\nx`, START, END, "body");
    expect(result.match(new RegExp(END, "g"))).toHaveLength(1);
    expect(result).toContain("old");
  });

  it("treats an end marker before the start marker as half-edited, not as a region", () => {
    const result = upsertMarkedRegionAfterIntro(
      `# T\n${END}\nmid\n${START}\n## A\nx`,
      START,
      END,
      "body",
    );
    expect(result.match(new RegExp(START, "g"))).toHaveLength(1);
    expect(result.match(new RegExp(END, "g"))).toHaveLength(1);
    expect(result).toContain("mid");
  });

  it("replaces a complete region in place and does not move it (a repo scaffolded earlier keeps its placement)", () => {
    const text = `# T\n\n## A\nx\n\n${START}\nold\n${END}\n\n## B\ny\n`;
    const result = upsertMarkedRegionAfterIntro(text, START, END, "new");
    expect(result).toBe(`# T\n\n## A\nx\n\n${START}\nnew\n${END}\n\n## B\ny\n`);
  });

  it("does not mistake a leading thematic break for frontmatter", () => {
    const text = "---\n\nSome intro prose.\n\n---\n\n## Real\nx";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(result.indexOf(START)).toBeLessThan(result.indexOf("## Real"));
    expect(result.indexOf(START)).toBeGreaterThan(result.indexOf("Some intro prose."));
  });

  it("keeps a CRLF file CRLF", () => {
    const text = "# T\r\n\r\nintro\r\n\r\n## A\r\nx\r\n";
    const result = upsertMarkedRegionAfterIntro(text, START, END, "a\nb");
    expect(result).toBe(
      `# T\r\n\r\nintro\r\n\r\n${START}\r\na\r\nb\r\n${END}\r\n\r\n## A\r\nx\r\n`,
    );
    expect(result).not.toMatch(/[^\r]\n/);
  });
});

describe("topLevelLines", () => {
  it("flags frontmatter, fences and multi-line comments as not top level", () => {
    const lines = ["---", "a: 1", "---", "p", "```", "c", "```", "<!--", "x", "-->", "q"];
    expect(topLevelLines(lines)).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });

  it("treats an empty frontmatter block as frontmatter", () => {
    expect(topLevelLines(["---", "---", "p"])).toEqual([false, false, true]);
  });

  it("does not treat an unclosed leading --- as frontmatter", () => {
    expect(topLevelLines(["---", "a"])).toEqual([true, true]);
  });

  it("ignores a single-line comment", () => {
    expect(topLevelLines(["<!-- c -->", "p"])).toEqual([true, true]);
  });
});
