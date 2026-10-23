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
        getCell: () => undefined,
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
