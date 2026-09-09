// Node-env unit tests for the wrap-aware link joining/matching logic, using
// hand-built fake buffers rather than a real xterm Terminal (see
// `terminalLinks.xterm.test.ts` for the real-Terminal integration coverage,
// including the exact byte sequence captured from a live Mullion session).
import { describe, expect, it } from "vitest";

import {
  buildWindow,
  computeLinksForRow,
  isSafeLinkUrl,
  MAX_HARD_WRAP_ROWS,
  MAX_JOINED_LENGTH,
  mapOffsetsToRows,
  RIGHT_EDGE_SLACK,
  type LinkBufferCell,
  type LinkBufferLine,
  type LinkBufferSource,
  type LinkSegment,
} from "./terminalLinks.js";

function makeLine(text: string, isWrapped: boolean, cols: number): LinkBufferLine {
  return {
    isWrapped,
    length: cols,
    translateToString: () => text,
    getCell: (x: number): LinkBufferCell | undefined =>
      x < text.length ? { getChars: () => text[x] } : undefined,
  };
}

interface RowSpec {
  text: string;
  isWrapped?: boolean;
}

function makeBuffer(rows: RowSpec[], cols: number): LinkBufferSource {
  const lines = rows.map((r) => makeLine(r.text, r.isWrapped ?? false, cols));
  return {
    cols,
    getLine: (y: number) => lines[y],
  };
}

describe("terminalLinks", () => {
  describe("soft wrap (regression: must not break the working path)", () => {
    it("joins a URL split across isWrapped rows, same as the stock addon", () => {
      const buf = makeBuffer(
        [
          { text: "  soft https://github.com/s3ntin3l8/mullion-session-manager/" },
          { text: "pull/1234 end", isWrapped: true },
        ],
        63,
      );
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://github.com/s3ntin3l8/mullion-session-manager/pull/1234");
      expect(links[0].rowCount).toBe(2);

      // The continuation row must resolve to the same link when queried
      // directly (xterm calls provideLinks per hovered row independently).
      const fromRow1 = computeLinksForRow(buf, 1);
      expect(fromRow1).toHaveLength(1);
      expect(fromRow1[0].text).toBe(links[0].text);
    });
  });

  describe("hard wrap", () => {
    it("joins at the real captured edge (cols=58, row edge=57)", () => {
      const row0 = '     "$MULLION_SOCKET_PATH" "http://localhost/api/session';
      const row1 = 's/$MULLION_SESSION_ID/scrollback" -o "$SB" 2>&1; ls ';
      const cols = row0.length; // the row fills the pane exactly, as captured
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], cols);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("http://localhost/api/sessions/$MULLION_SESSION_ID/scrollback");
      expect(links[0].rowCount).toBe(2);

      const fromRow1 = computeLinksForRow(buf, 1);
      expect(fromRow1).toHaveLength(1);
      expect(fromRow1[0].text).toBe(links[0].text);
    });

    it("underlines only the matched portion on each row (per-segment ranges)", () => {
      const row0 = "x".repeat(20) + "https://example.com/" + "y".repeat(35); // reaches edge (58-3 slack)
      const row1 = "abc/def ghijk";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], row0.length);
      const links0 = computeLinksForRow(buf, 0);
      expect(links0).toHaveLength(1);
      expect(links0[0].startCol).toBe(20); // 0-indexed start of "https"
      expect(links0[0].endCol).toBe(row0.length); // exclusive end = full row
      expect(links0[0].text).toBe("https://example.com/" + "y".repeat(35) + "abc/def");

      const links1 = computeLinksForRow(buf, 1);
      expect(links1).toHaveLength(1);
      expect(links1[0].startCol).toBe(0);
      expect(links1[0].endCol).toBe("abc/def".length);
    });

    it("does not join when the next row starts with whitespace or unrelated text", () => {
      const row0 = "x".repeat(20) + "https://example.com/" + "y".repeat(35);
      const row1 = "  not part of the url";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], row0.length);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/" + "y".repeat(35));
      expect(links[0].rowCount).toBe(1);
    });
  });

  describe("word-wrapped panel corroboration (opencode: interval, not exact-match)", () => {
    // Real bug: opencode word-wraps its own bordered-panel content, so
    // consecutive rows in one wrapped paragraph almost never share an exact
    // right edge the way a fixed-width hard-wrap does — the original
    // exact-column-match corroboration essentially never fires for it. The
    // fix generalizes to interval membership: a nearby row's edge landing
    // in `[P, P + C)`, where `C` is the continuation's next unbreakable
    // chunk, is enough — even when that row is unrelated content that
    // merely happens to reach that far, not a "sibling" row sharing the
    // panel's own wrap width.
    it("joins when a nearby row's edge falls inside the interval, not at the exact same column", () => {
      const row0 = "y".repeat(21) + "https://example.com/abc-"; // P = 45
      const cols = 78;
      const buf = makeBuffer(
        [
          { text: "z".repeat(44) }, // edge 44 — below P, does not qualify alone
          { text: "m".repeat(5) },
          { text: "n".repeat(5) },
          { text: row0 }, // producer, row index 3
          { text: "def/ghi more words" }, // continuation: prefix "def/ghi", span 4 -> interval [45,49)
          { text: "w".repeat(47) }, // edge 47 — inside [45,49), corroborates
        ],
        cols,
      );
      const links = computeLinksForRow(buf, 3);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/abc-def/ghi");
      expect(links[0].rowCount).toBe(2);
    });

    it("does not join when every nearby row's edge falls outside the interval", () => {
      const row0 = "y".repeat(21) + "https://example.com/abc-"; // P = 45
      const cols = 78;
      const buf = makeBuffer(
        [
          { text: "z".repeat(44) }, // edge 44 < 45 — excluded
          { text: "m".repeat(5) },
          { text: "n".repeat(5) },
          { text: row0 }, // producer, row index 3
          { text: "def/ghi more words" }, // span 4 -> interval [45,49)
          { text: "w".repeat(49) }, // edge 49 — interval's exclusive upper bound, excluded
        ],
        cols,
      );
      const links = computeLinksForRow(buf, 3);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/abc-");
      expect(links[0].rowCount).toBe(1);
    });
  });

  describe("mid-token-break exception to the structural gate", () => {
    // opencode's own `git remote -v` output wraps mid-hostname: the
    // continuation ("tracker.git") carries only `.`/`-`, which
    // STRUCTURAL_CHAR_RE alone would reject. Admitted only because the
    // producer row's own text was visibly cut mid-token (ends in `-`).
    it("joins a `.`/`-`-only continuation when the producer row ends mid-token", () => {
      const row0 = "z".repeat(20) + "https://github.com/s3ntin3l8/pocket-"; // ends in "-", flush to margin
      const cols = row0.length;
      const row1 = "portfolio-tracker.git (fetch)";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], cols);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://github.com/s3ntin3l8/pocket-portfolio-tracker.git");
      expect(links[0].rowCount).toBe(2);
    });

    // Pins the prior review's decision in place: without a mid-token
    // producer ending, a `.`/`-`-only continuation stays rejected exactly
    // as before this fix.
    it("still rejects a `.`/`-`-only continuation when the producer row ends on an ordinary character", () => {
      const row0 = "z".repeat(20) + "https://github.com/s3ntin3l8/pocket"; // no trailing "-", flush to margin
      const cols = row0.length;
      const row1 = "portfolio-tracker.git (fetch)";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], cols);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://github.com/s3ntin3l8/pocket");
      expect(links[0].rowCount).toBe(1);
    });

    // Known, accepted residual gap of the `/` half of MID_TOKEN_BREAK_RE
    // (documented in this module's own header): a trailing-slash URL is
    // complete and routine, so a producer ending in `/` is weaker evidence
    // of a mid-token break than one ending in `-`. Combined with a nearby
    // row's edge coincidentally landing in the interval, this CAN still
    // join a URL onto unrelated hyphenated prose. Locked in here as
    // documentation of current, deliberate behaviour — not a target to
    // "fix" blindly — the same way the `/var/log/syslog` case above is: the
    // hover tooltip shows the full reconstructed URL before any click.
    it("still joins hyphenated prose after a trailing-slash URL when a nearby edge coincides — documented limitation", () => {
      const row0 = "z".repeat(20) + "https://example.com/"; // ends in "/", P = 40
      const cols = 78;
      const buf = makeBuffer(
        [
          { text: "q".repeat(42) }, // edge 42 — unrelated content, happens to land in [40,45)
          { text: row0 }, // producer, row index 1
          { text: "well-known limitations apply" }, // prefix "well-known", span 5 -> interval [40,45)
        ],
        cols,
      );
      const links = computeLinksForRow(buf, 1);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/well-known");
    });

    // Review-caught regression: WRAP_BREAK_CHAR_RE (used only to size the
    // corroboration span) didn't include `.`, even though
    // SOFT_STRUCTURAL_CHAR_RE (which gates entry into this guarded branch)
    // admits a lone `.` as sufficient. A continuation with a `.` but no
    // early `-`/`/`/etc. made `prefix.search(WRAP_BREAK_CHAR_RE)` return -1,
    // so the span fell back to the ENTIRE continuation length instead of
    // stopping at the first break opportunity — wildly widening the
    // corroboration interval in exactly this module's most loosely-gated
    // path. Fixed by adding `.` to WRAP_BREAK_CHAR_RE; this pins the narrow
    // span in place so the bug can't silently return.
    it("sizes the corroboration span narrowly for a `.`-only continuation, not the whole continuation length", () => {
      const row0 = "z".repeat(20) + "https://example.com/foo-"; // ends in "-", P = 44
      const cols = 78;
      const continuation = "a." + "x".repeat(60); // WRAP_BREAK_CHAR_RE should stop at the "." (index 1) -> span 2
      const buf = makeBuffer(
        [
          { text: row0 }, // producer, row index 0
          { text: continuation },
          { text: "q".repeat(70) }, // edge 70 — inside the OLD buggy [44,106) span, outside the fixed [44,46)
        ],
        cols,
      );
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/foo-");
      expect(links[0].rowCount).toBe(1);
    });
  });

  describe("safety: the join must never produce a link to the wrong destination", () => {
    it("rejects the classic false positive — two short lines that happen to sit near each other", () => {
      // Real, deliberately adversarial case: neither line is anywhere near
      // the right edge, so H2 must reject it outright.
      const buf = makeBuffer(
        [{ text: "  See https://github.com/foo/bar" }, { text: "  installed at /usr/lib" }],
        58,
      );
      const row0 = buf.getLine(0)!.translateToString(true);
      const row1 = buf.getLine(1)!.translateToString(true);
      expect(row0.replace(/\s+$/, "").length).toBeLessThan(58 - RIGHT_EDGE_SLACK);
      expect(row1.length).toBeGreaterThan(0);

      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://github.com/foo/bar");
      expect(links[0].rowCount).toBe(1);
    });

    it("rejects a join across a written trailing-space gap (H1)", () => {
      // Raw length 40, but the URL itself ends 3 columns before that
      // (written spaces, not unwritten cells) — translateToString(true)
      // would NOT trim these, so a naive `.length`-based edge check would
      // wrongly treat this row as reaching the edge.
      const row0 = "  trailing spaces case https://x.io/a   ";
      const row1 = "bcd/ef";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], 58);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://x.io/a");
      expect(links[0].rowCount).toBe(1);
    });

    it("stops the chain when a hard-wrap continuation row is blank", () => {
      const row0 = "x".repeat(20) + "https://example.com/" + "y".repeat(35);
      const buf = makeBuffer([{ text: row0 }, { text: "" }], row0.length);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/" + "y".repeat(35));
      expect(links[0].rowCount).toBe(1);
    });

    it("does not join when there is no next row at all", () => {
      const row0 = "x".repeat(20) + "https://example.com/" + "y".repeat(35);
      const buf = makeBuffer([{ text: row0 }], row0.length);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].rowCount).toBe(1);
    });

    // Review-caught regression: an earlier, wider STRUCTURAL_CHAR_RE also
    // accepted colons and digits as "structural", so an ordinary English
    // lead-in on the next row ("Note:", "Warning:") wrongly extended a
    // complete, correct URL — appending "Note" to it. Narrowing the class to
    // true URL syntax characters (`/ ? # & =` and `%`) rejects this.
    it("rejects joining ordinary English lead-ins that merely contain a colon or digit", () => {
      const row0 = "x".repeat(20) + "https://example.com/foo" + "z".repeat(13); // flush to the edge
      for (const row1 of ["Note: restart the daemon afterwards", "v2 of the API ships next week"]) {
        const buf = makeBuffer([{ text: row0 }, { text: row1 }], row0.length);
        const links = computeLinksForRow(buf, 0);
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe("https://example.com/foo" + "z".repeat(13));
        expect(links[0].rowCount).toBe(1);
      }
    });

    // Known, accepted residual gap (documented in this module's own header):
    // an unrelated next row that ITSELF opens with a path-shaped token is
    // lexically identical to a genuine wrapped URL path segment — no check
    // on buffer content alone can tell them apart, so this DOES still join.
    // Locked in here as documentation of current, deliberate behaviour (not
    // a target to "fix" blindly) — the hover tooltip is what keeps this
    // safe: a link that visibly reads ".../foo/var/log/syslog" is wrong-
    // looking before it's ever opened, never silently navigated to.
    it("still joins an unrelated absolute path on the next row — documented limitation, not a silent-navigation risk", () => {
      const row0 = "x".repeat(20) + "https://example.com/foo" + "z".repeat(13);
      const row1 = "/var/log/syslog was rotated";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], row0.length);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe("https://example.com/foo" + "z".repeat(13) + "/var/log/syslog");
    });
  });

  describe("gutter glyph variants", () => {
    for (const gutter of ["│ ", "┃ ", "⎿ ", "> ", ""]) {
      it(`joins through a ${JSON.stringify(gutter)} continuation gutter`, () => {
        const row0 = "x".repeat(20) + "https://example.com/" + "y".repeat(35);
        const row1 = `${gutter}abc/def`;
        const buf = makeBuffer([{ text: row0 }, { text: row1 }], row0.length);
        const links = computeLinksForRow(buf, 0);
        expect(links).toHaveLength(1);
        expect(links[0].text).toBe("https://example.com/" + "y".repeat(35) + "abc/def");
      });
    }

    it("strips a single trailing box-border glyph before measuring the edge", () => {
      const inner = "https://example.com/" + "z".repeat(14);
      const row0 = `│ ${inner} │`; // border glyph + 1 space padding on each side
      const row1 = "│ pqr/stu";
      const cols = row0.length; // the bordered panel fills the pane exactly
      const buf = makeBuffer([{ text: row0 }, { text: row1 }], cols);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].text).toBe(inner + "pqr/stu");
    });
  });

  describe("caps", () => {
    it("stops extending after MAX_HARD_WRAP_ROWS continuation rows", () => {
      const cols = 30;
      const rows: RowSpec[] = [{ text: "x".repeat(9) + "https://example.com/" }];
      // "a/" repeated fills every row flush to the right edge (keeps the
      // cols-relative eligibility check passing at each step) while also
      // giving every continuation a structural character near its start
      // (keeps the J4 gate passing) — isolating the row-count cap as the
      // only thing that can stop the chain.
      const contRow = "a/".repeat(cols / 2);
      for (let i = 0; i < MAX_HARD_WRAP_ROWS + 3; i++) {
        rows.push({ text: contRow });
      }
      const buf = makeBuffer(rows, cols);
      const links = computeLinksForRow(buf, 0);
      expect(links).toHaveLength(1);
      expect(links[0].rowCount).toBe(1 + MAX_HARD_WRAP_ROWS);
    });

    it("stops extending once MAX_JOINED_LENGTH is reached (soft wrap)", () => {
      const cols = 200;
      const rows: RowSpec[] = [{ text: "https://example.com/" + "a".repeat(cols - 21) }];
      for (let i = 0; i < 15; i++) {
        rows.push({ text: "b".repeat(cols), isWrapped: true });
      }
      const buf = makeBuffer(rows, cols);
      const { text } = buildWindow(buf, 0);
      expect(text.length).toBeGreaterThanOrEqual(MAX_JOINED_LENGTH);
      expect(text.length).toBeLessThan(MAX_JOINED_LENGTH + cols);
    });
  });

  describe("hover on a hard-wrap continuation row resolves the same link (backward walk)", () => {
    it("reconstructs the full link when queried from the middle of a 3-row hard-wrap chain", () => {
      const cols = 30;
      const row0 = "x".repeat(9) + "https://example.com/"; // 9 + 21 = 30 = cols, edge 30 >= 27
      const row1 = "a/".repeat(cols / 2); // flush to the edge too, chains onward, has a structural char
      const row2 = "bcd/efg";
      const buf = makeBuffer([{ text: row0 }, { text: row1 }, { text: row2 }], cols);
      const expectedText = "https://example.com/" + row1 + "bcd/efg";

      const fromStart = computeLinksForRow(buf, 0);
      expect(fromStart).toHaveLength(1);
      expect(fromStart[0].text).toBe(expectedText);
      expect(fromStart[0].rowCount).toBe(3);

      // The user hovering directly over row 1 — never touching row 0, where
      // the link visually starts — must still resolve to the same link.
      const fromMiddle = computeLinksForRow(buf, 1);
      expect(fromMiddle).toHaveLength(1);
      expect(fromMiddle[0].text).toBe(expectedText);
      expect(fromMiddle[0].rowCount).toBe(3);

      const fromEnd = computeLinksForRow(buf, 2);
      expect(fromEnd).toHaveLength(1);
      expect(fromEnd[0].text).toBe(expectedText);
    });
  });

  describe("mapOffsetsToRows", () => {
    it("maps an offset range spanning two segments to two row ranges", () => {
      const buf = makeBuffer([{ text: "hello world" }, { text: "more text" }], 20);
      const segments: LinkSegment[] = [
        { row: 0, startCol: 0, text: "hello world" },
        { row: 1, startCol: 0, text: "more text" },
      ];
      const ranges = mapOffsetsToRows(buf, segments, 6, 16);
      expect(ranges).toEqual([
        { row: 0, startCol: 6, endCol: 11 },
        { row: 1, startCol: 0, endCol: 5 },
      ]);
    });
  });

  describe("isSafeLinkUrl", () => {
    it("allows http and https", () => {
      expect(isSafeLinkUrl("https://example.com/foo")).toBe(true);
      expect(isSafeLinkUrl("http://example.com/foo")).toBe(true);
    });

    it("rejects other schemes and malformed input", () => {
      expect(isSafeLinkUrl("javascript:alert(1)")).toBe(false);
      expect(isSafeLinkUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
      expect(isSafeLinkUrl("file:///etc/passwd")).toBe(false);
      expect(isSafeLinkUrl("not a url")).toBe(false);
      expect(isSafeLinkUrl("")).toBe(false);
    });
  });
});
