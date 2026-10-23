// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { computePathLinksForRow, looksLikeFilePath } from "./terminalPathLinks.js";
import type { LinkBufferSource } from "./terminalLinks.js";

function bufferOf(...rows: string[]): LinkBufferSource {
  return {
    cols: 200,
    getLine: (y: number) => {
      const text = rows[y];
      if (text === undefined) return undefined;
      return {
        isWrapped: false,
        length: text.length,
        translateToString: () => text,
        getCell: (x: number) => ({ getChars: () => text[x] ?? "" }),
      };
    },
  };
}

const linksIn = (row: string) => computePathLinksForRow(bufferOf(row), 0);

describe("looksLikeFilePath", () => {
  it("accepts relative, nested, dot-prefixed, absolute and dotfile paths", () => {
    for (const p of [
      "src/a.ts",
      "./src/a.ts",
      "../x/y.json",
      "/home/u/proj/src/a.ts",
      ".env",
      ".env.local",
      "dir/.env",
      "package.json",
      "Makefile",
      "src/Dockerfile",
      "docs/README.md",
      "a.test.tsx",
      "~/x.ts",
      "~/.claude/plans/p.md",
      "~/.minimax/v2/sessions/2026/10/22/20-56-29-329-session_bXZz/artifacts/plan.md",
    ]) {
      expect(looksLikeFilePath(p), p).toBe(true);
    }
  });

  it("rejects URLs, directories, versions, prose abbreviations and domains", () => {
    for (const p of [
      "https://example.com/a.ts",
      "src/utils",
      "src/utils/",
      "e.g.",
      "1.2.3",
      "v1.2",
      "example.com",
      "github.com/org/repo",
      "~",
      "~/",
      "~user/x.ts",
      "~/e.g.",
      "-rf",
      "foo.bar",
      "..",
      ".",
      "a",
      "//cdn/x.js",
    ]) {
      expect(looksLikeFilePath(p), p).toBe(false);
    }
  });
});

describe("computePathLinksForRow", () => {
  it("links a path with columns and strips trailing punctuation", () => {
    const [link] = linksIn("error in src/app.ts:42:7.");
    expect(link).toMatchObject({
      path: "src/app.ts",
      text: "src/app.ts:42:7",
      line: 42,
      col: 7,
      startCol: 9,
      endCol: 24,
    });
  });

  it("links the path inside quotes and brackets, and several per row", () => {
    const links = linksIn('Edit "src/a.ts" then (lib/b.js:3) and .env');
    expect(links.map((l) => l.path)).toEqual(["src/a.ts", "lib/b.js", ".env"]);
    expect(links[1]).toMatchObject({ line: 3, col: undefined });
  });

  it("does not link URLs or plain prose", () => {
    expect(linksIn("see https://example.com/docs/index.html for e.g. details v1.2")).toEqual([]);
  });

  it("links a ~/ path with a line suffix", () => {
    const [link] = linksIn("plan at ~/.claude/plans/p.md:12 done");
    expect(link.text).toBe("~/.claude/plans/p.md:12");
    expect(link.path).toBe("~/.claude/plans/p.md");
    expect(link.line).toBe(12);
  });

  it("handles a trailing colon and empty/missing rows", () => {
    expect(linksIn("src/a.ts:")[0].text).toBe("src/a.ts");
    expect(linksIn("")).toEqual([]);
    expect(computePathLinksForRow(bufferOf("x"), 5)).toEqual([]);
  });
});

describe("computePathLinksForRow across wrapped rows", () => {
  const PLAN = "~/.minimax/v2/sessions/2026/10/22/20-13-37-973-session_bXZzX2JkMz";
  const REST = "FkNTE1OGUzNzQwNWFiOTU5YjMwODY5ODY3ZjA2/artifacts/plan.md";
  const FULL = PLAN + REST;
  const row1 = `Plan  ${PLAN}`;
  const row2 = `      ${REST}`;

  function wrapped(cols: number, rows: string[], softFrom?: number): LinkBufferSource {
    return {
      cols,
      getLine: (y: number) => {
        const text = rows[y];
        if (text === undefined) return undefined;
        return {
          isWrapped: softFrom !== undefined && y >= softFrom,
          length: text.length,
          translateToString: () => text,
          getCell: (x: number) => ({ getChars: () => text[x] ?? "" }),
        };
      },
    };
  }

  it("joins a hard-wrapped path hovered on either row", () => {
    const buf = wrapped(row1.length + 1, [row1, row2]);
    const first = computePathLinksForRow(buf, 0);
    const second = computePathLinksForRow(buf, 1);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({ path: FULL, rowCount: 2, startCol: 6, endCol: row1.length });
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ path: FULL, rowCount: 2, startCol: 6, endCol: row2.length });
  });

  it("joins a soft-wrapped path", () => {
    const buf = wrapped(200, [row1, REST], 1);
    expect(computePathLinksForRow(buf, 1)[0]).toMatchObject({ rowCount: 2 });
  });

  it("does not join when the first row is nowhere near the margin", () => {
    const buf = wrapped(200, [row1, row2]);
    expect(computePathLinksForRow(buf, 0)).toEqual([]);
    expect(computePathLinksForRow(buf, 1)[0]).toMatchObject({ path: REST, rowCount: 1 });
  });

  it("does not glue a trailing prose word onto a path on the next row", () => {
    const prose = "see the docs at";
    const buf = wrapped(prose.length + 1, [prose, "src/a.ts"]);
    expect(computePathLinksForRow(buf, 1)[0]).toMatchObject({ path: "src/a.ts", rowCount: 1 });
  });

  it("does not join a continuation that starts a new path", () => {
    const buf = wrapped(row1.length + 1, [row1, "/var/log/syslog.txt"]);
    expect(computePathLinksForRow(buf, 1)[0]).toMatchObject({ rowCount: 1 });
  });

  it("keeps a :line:col suffix that lands on the continuation row", () => {
    const head = "see ~/projects/some/deep/dir/nested/sub";
    const buf = wrapped(head.length + 1, [head, "dir/file.ts:12:3"]);
    expect(computePathLinksForRow(buf, 0)[0]).toMatchObject({
      path: "~/projects/some/deep/dir/nested/subdir/file.ts",
      line: 12,
      col: 3,
      rowCount: 2,
    });
  });

  it("keeps a list of complete paths separate at a normal width", () => {
    const buf = wrapped(120, ["  • artifacts/plan.md", "  • src/terminalLinks.ts"]);
    expect(computePathLinksForRow(buf, 0)).toMatchObject([
      { path: "artifacts/plan.md", rowCount: 1 },
    ]);
    expect(computePathLinksForRow(buf, 1)).toMatchObject([
      { path: "src/terminalLinks.ts", rowCount: 1 },
    ]);
  });

  it("joins via a corroborating neighbour row when the margin is far away", () => {
    // An inset panel: a nearby row's edge lands just past this row's edge.
    const neighbour = "x".repeat(row1.length + 1);
    const buf = wrapped(200, [row1, row2, neighbour]);
    expect(computePathLinksForRow(buf, 0)[0]).toMatchObject({ path: FULL, rowCount: 2 });
    expect(computePathLinksForRow(buf, 1)[0]).toMatchObject({ path: FULL, rowCount: 2 });
  });
});
