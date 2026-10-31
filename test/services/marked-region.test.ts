import { describe, it, expect } from "vitest";
import {
  clampToBytes,
  extractMarkedRegion,
  stripMarkedRegion,
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

  it("ignores markers inside inline code, fenced blocks, prose, or longer tokens", () => {
    expect(extractMarkedRegion(`Use \`${START}\` and \`${END}\`.`, START, END)).toBeNull();
    expect(extractMarkedRegion(`Use ${START} and ${END} in prose.`, START, END)).toBeNull();
    expect(extractMarkedRegion(`\`\`\`\n${START}\nfenced\n${END}\n\`\`\``, START, END)).toBeNull();
    const withRealAfterFence = `\`\`\`\n${START}\nfenced\n${END}\n\`\`\`\n${START}\nreal\n${END}`;
    expect(extractMarkedRegion(withRealAfterFence, START, END)).toBe("real");
  });

  it("extracts a region whose body contains an unclosed fence", () => {
    const text = `${START}\n## Setup\n\`\`\`sh\nnpm install\n${END}\n\n\`\`\`sh\nnpm test\n\`\`\``;
    expect(extractMarkedRegion(text, START, END)).toBe("## Setup\n```sh\nnpm install");
    const withBareLater = `${START}\n## Setup\n\`\`\`sh\nnpm install\n${END}\n\n## Later\n\`\`\`\nplain\n\`\`\``;
    expect(extractMarkedRegion(withBareLater, START, END)).toBe("## Setup\n```sh\nnpm install");
  });
});

describe("stripMarkedRegion", () => {
  it("strips the first complete top-level region and leaves surrounding text intact", () => {
    const text = `before\n${START}\nbody\n${END}\nafter`;
    expect(stripMarkedRegion(text, START, END)).toBe("before\n\nafter");
  });

  it("returns the input unchanged when no complete pair is present", () => {
    expect(stripMarkedRegion(`only\n${START}\nhere`, START, END)).toBe(`only\n${START}\nhere`);
  });

  it("ignores a marker prefix inside a longer token instead of stripping from it", () => {
    const m1 = "# mullion:worktrees:start";
    const m2 = "# mullion:worktrees:end";
    const text = `# mullion:worktrees:started-by-hand\n.wt/\n${m1}\n.wt/\n${m2}\n`;
    expect(stripMarkedRegion(text, m1, m2)).toBe("# mullion:worktrees:started-by-hand\n.wt/\n\n");
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

  it("leaves a marker mentioned inline in prose untouched and ignores it on re-run", () => {
    const once = upsertMarkedRegion(`Use ${START} to start.`, START, END, "hello");
    expect(once).toBe(`Use ${START} to start.\n\n${START}\nhello\n${END}\n`);
    const twice = upsertMarkedRegion(once, START, END, "updated");
    expect(twice).toBe(`Use ${START} to start.\n\n${START}\nupdated\n${END}\n`);
  });

  it("ignores inline start and end markers on the same prose line instead of replacing between them", () => {
    const once = upsertMarkedRegion(`${START} a ${START} b ${END}`, START, END, "hello");
    expect(once).toBe(`${START} a ${START} b ${END}\n\n${START}\nhello\n${END}\n`);
    expect(upsertMarkedRegion(once, START, END, "updated")).toBe(
      `${START} a ${START} b ${END}\n\n${START}\nupdated\n${END}\n`,
    );
  });

  it("does not cut marker text out of a longer token in .gitignore, and ignores it on re-run", () => {
    const m1 = "# mullion:worktrees:start";
    const m2 = "# mullion:worktrees:end";
    const once = upsertMarkedRegion(
      `node_modules\n# mullion:worktrees:started-by-hand\n`,
      m1,
      m2,
      ".wt/",
    );
    expect(once).toBe(`node_modules\n# mullion:worktrees:started-by-hand\n\n${m1}\n.wt/\n${m2}\n`);
    expect(once).not.toContain("\ned-by-hand");
    expect(upsertMarkedRegion(once, m1, m2, ".wt/")).toBe(once);
  });

  it("leaves a quoted marker inside an inline code span untouched and ignores it on re-run", () => {
    const inlineSpan = upsertMarkedRegion(`Quoted \`${START}\` marker.`, START, END, "hello");
    expect(inlineSpan).toBe(`Quoted \`${START}\` marker.\n\n${START}\nhello\n${END}\n`);
    expect(upsertMarkedRegion(inlineSpan, START, END, "updated")).toBe(
      `Quoted \`${START}\` marker.\n\n${START}\nupdated\n${END}\n`,
    );

    const loneSpanLine = upsertMarkedRegion(`\`${START}\``, START, END, "hello");
    expect(loneSpanLine).toBe(`\`${START}\`\n\n${START}\nhello\n${END}\n`);
    expect(upsertMarkedRegion(loneSpanLine, START, END, "updated")).toBe(
      `\`${START}\`\n\n${START}\nupdated\n${END}\n`,
    );
  });

  it("leaves a marker inside a fenced code block untouched and ignores it on re-run", () => {
    const fenced = `# Doc\n\n\`\`\`html\n${START}\n\`\`\`\n`;
    const once = upsertMarkedRegion(fenced, START, END, "hello");
    expect(once).toBe(`# Doc\n\n\`\`\`html\n${START}\n\`\`\`\n\n${START}\nhello\n${END}\n`);
    expect(upsertMarkedRegion(once, START, END, "updated")).toBe(
      `# Doc\n\n\`\`\`html\n${START}\n\`\`\`\n\n${START}\nupdated\n${END}\n`,
    );
  });

  it("strips a second orphan start after a complete pair when replacing the pair", () => {
    const text = `${START}\nold\n${END}\nmid\n${START}\ntail`;
    const once = upsertMarkedRegion(text, START, END, "new");
    expect(once).toBe(`${START}\nnew\n${END}\nmid\ntail`);
    expect(upsertMarkedRegion(once, START, END, "new")).toBe(once);
  });

  it("strips an orphan start before a complete pair without eating the text between the two starts", () => {
    const text = `${START}\nkeep me\n${START}\nold\n${END}`;
    const once = upsertMarkedRegion(text, START, END, "new");
    expect(once).toBe(`keep me\n${START}\nnew\n${END}`);
    expect(upsertMarkedRegion(once, START, END, "new")).toBe(once);
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

  it("leaves inline and fenced markers alone and ignores them on re-run", () => {
    const text = `# T\n\nUse ${START} or \`${START}\`.\n\n\`\`\`\n${START}\n${END}\n\`\`\`\n\n## A\nx\n`;
    const once = upsertMarkedRegionAfterIntro(text, START, END, "body");
    expect(once).toContain(`Use ${START} or \`${START}\`.`);
    expect(once).toContain(`\`\`\`\n${START}\n${END}\n\`\`\``);
    expect(extractMarkedRegion(once, START, END)).toBe("body");
    const twice = upsertMarkedRegionAfterIntro(once, START, END, "body2");
    expect(twice).toContain(`Use ${START} or \`${START}\`.`);
    expect(extractMarkedRegion(twice, START, END)).toBe("body2");
  });

  it("replaces an existing region in place when an unclosed fence or stray comment precedes it", () => {
    const text = `# Proj\n\n\`\`\`bash\nnpm run dev\n\n## Rules\n${START}\nold region\n${END}\n`;
    const once = upsertMarkedRegionAfterIntro(text, START, END, "new region");
    expect(once).toBe(
      `# Proj\n\n\`\`\`bash\nnpm run dev\n\n## Rules\n${START}\nnew region\n${END}\n`,
    );
    expect(once.match(new RegExp(START, "g"))).toHaveLength(1);
    expect(upsertMarkedRegionAfterIntro(once, START, END, "new region")).toBe(once);

    const withLaterBareFence = `# Proj\n\n\`\`\`bash\nnpm run dev\n\n## Rules\n${START}\nold region\n${END}\n\n## Later\n\`\`\`\nplain\n\`\`\`\n`;
    const bareOnce = upsertMarkedRegionAfterIntro(withLaterBareFence, START, END, "new region");
    expect(bareOnce).toBe(
      `# Proj\n\n\`\`\`bash\nnpm run dev\n\n## Rules\n${START}\nnew region\n${END}\n\n## Later\n\`\`\`\nplain\n\`\`\`\n`,
    );
    expect(bareOnce.match(new RegExp(START, "g"))).toHaveLength(1);
    expect(upsertMarkedRegionAfterIntro(bareOnce, START, END, "new region")).toBe(bareOnce);

    const withBareUnclosedOpener = `# Proj\n\n\`\`\`\nnpm run dev\n\n## Rules\n${START}\nold region\n${END}\n\n## Later\n\`\`\`\n`;
    const bareOpenerOnce = upsertMarkedRegionAfterIntro(
      withBareUnclosedOpener,
      START,
      END,
      "new region",
    );
    expect(bareOpenerOnce).toBe(
      `# Proj\n\n\`\`\`\nnpm run dev\n\n## Rules\n${START}\nnew region\n${END}\n\n## Later\n\`\`\`\n`,
    );
    expect(bareOpenerOnce.match(new RegExp(START, "g"))).toHaveLength(1);

    const withStrayComment = `# Proj\n\n<!-- unclosed\n\n${START}\nold region\n${END}\n`;
    const commentOnce = upsertMarkedRegionAfterIntro(withStrayComment, START, END, "new region");
    expect(commentOnce).toBe(`# Proj\n\n<!-- unclosed\n\n${START}\nnew region\n${END}\n`);
    expect(commentOnce.match(new RegExp(START, "g"))).toHaveLength(1);
  });

  it("replaces a region whose own body contains an unclosed fence without duplicating it", () => {
    const text = `# Proj\n\n${START}\nbody\n\`\`\`bash\nnpm run dev\n${END}\n\n## Later\n\`\`\`bash\nnpm test\n\`\`\`\n`;
    const once = upsertMarkedRegionAfterIntro(text, START, END, "clean body");
    expect(once).toBe(
      `# Proj\n\n${START}\nclean body\n${END}\n\n## Later\n\`\`\`bash\nnpm test\n\`\`\`\n`,
    );
    expect(once.match(new RegExp(START, "g"))).toHaveLength(1);

    const withBareFenceLater = `# Proj\n\n${START}\nbody\n\`\`\`bash\nnpm run dev\n${END}\n\n## Later\n\`\`\`\nplain\n\`\`\`\n`;
    const bareOnce = upsertMarkedRegionAfterIntro(withBareFenceLater, START, END, "clean body");
    expect(bareOnce).toBe(
      `# Proj\n\n${START}\nclean body\n${END}\n\n## Later\n\`\`\`\nplain\n\`\`\`\n`,
    );
    expect(bareOnce.match(new RegExp(START, "g"))).toHaveLength(1);

    const withSingleTrailingBareFence = `# Proj\n\n${START}\nbody\n\`\`\`\nnpm run dev\n${END}\n\n\`\`\`\n`;
    const singleTrailingOnce = upsertMarkedRegionAfterIntro(
      withSingleTrailingBareFence,
      START,
      END,
      "clean body",
    );
    expect(singleTrailingOnce).toBe(`# Proj\n\n${START}\nclean body\n${END}\n\n\`\`\`\n`);
    expect(singleTrailingOnce.match(new RegExp(START, "g"))).toHaveLength(1);
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

  it("does not hide the rest of the document after an unclosed fence or unclosed comment", () => {
    expect(topLevelLines(["```bash", "npm run dev", "## Heading"])).toEqual([true, true, true]);
    expect(topLevelLines(["```bash", "unclosed", "```sh", "closed", "```", "after"])).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(topLevelLines(["```bash", "unclosed", "```", "closed", "```", "after"])).toEqual([
      true,
      true,
      false,
      false,
      false,
      true,
    ]);
    expect(topLevelLines(["<!-- unclosed", "<!-- single -->", "after"])).toEqual([
      true,
      true,
      true,
    ]);
    expect(topLevelLines(["<!-- unclosed", "after"])).toEqual([true, true]);
  });
});
