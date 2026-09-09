// @vitest-environment jsdom
//
// Drives real captured byte sequences through a REAL `@xterm/xterm` Terminal
// (not mocked, unlike TerminalPane.test.tsx's module-level xterm mock) and
// asserts against its real buffer. This is the integration counterpart to
// terminalLinks.test.ts's fake-buffer unit tests: it exists specifically to
// catch a mismatch between our narrow `LinkBufferLine`/`LinkBufferSource`
// assumptions and xterm's actual `IBufferLine`/`IBuffer` behavior (e.g.
// `translateToString(true)`'s null-vs-written-space trimming, or
// `isWrapped` semantics), which hand-built fakes can't verify by
// construction.
import { Terminal } from "@xterm/xterm";
import { beforeEach, describe, expect, it } from "vitest";

import { computeLinksForRow, RIGHT_EDGE_SLACK, type LinkBufferSource } from "./terminalLinks.js";

const ESC = String.fromCharCode(27);

function asBufferSource(term: Terminal): LinkBufferSource {
  return {
    cols: term.cols,
    getLine: (y: number) => term.buffer.active.getLine(y),
  };
}

async function write(term: Terminal, data: string): Promise<void> {
  await new Promise<void>((resolve) => term.write(data, resolve));
}

describe("terminalLinks against a real xterm Terminal", () => {
  let term: Terminal;

  beforeEach(() => {
    term = new Terminal({ cols: 58, rows: 30, allowProposedApi: true });
  });

  it("reconstructs a URL hard-wrapped by real CR/CUF/CUD cursor positioning", async () => {
    // Exact byte shape captured from a live Mullion session
    // (`mullion session logs <id>`) — Claude Code's own Ink renderer
    // hard-positions the cursor per visual row instead of letting the
    // terminal soft-wrap.
    const data =
      '     "$MULLION_SOCKET_PATH" "http://localhost/api/session' +
      "\r" +
      ESC +
      "[5C" +
      ESC +
      "[1B" +
      's/$MULLION_SESSION_ID/scrollback" -o "$SB" 2>&1; ls ' +
      "\r\n";
    await write(term, data);

    const buf = asBufferSource(term);
    const line0 = buf.getLine(0)!;
    const line1 = buf.getLine(1)!;
    expect(line0.isWrapped).toBe(false);
    expect(line1.isWrapped).toBe(false); // confirms this is a HARD wrap, not soft

    const links = computeLinksForRow(buf, 0);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("http://localhost/api/sessions/$MULLION_SESSION_ID/scrollback");
    expect(links[0].rowCount).toBe(2);
  });

  it("does not truncate-and-open the wrong URL for the unfixed row alone", async () => {
    // Regression guard for the reported bug: without joining, row 0's own
    // fragment matches the addon's URL regex in isolation and would open
    // https://github.com/s3ntin3l8/mullion-session — truncated, wrong. Uses
    // its own narrower terminal (cols close to row 0's real length) so row 0
    // genuinely reaches the right margin, matching how this shape actually
    // occurs (see the module header for why "reasonably close to the edge"
    // alone isn't the bar — this row clears it outright).
    const row0 = "  see https://github.com/s3ntin3l8/mullion-session";
    const narrowTerm = new Terminal({ cols: row0.length + 2, rows: 30, allowProposedApi: true });
    const data =
      row0 + "\r" + ESC + "[5C" + ESC + "[1B" + "-manager/pull/1234 for details" + "\r\n";
    await write(narrowTerm, data);

    const buf = asBufferSource(narrowTerm);
    const links = computeLinksForRow(buf, 0);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://github.com/s3ntin3l8/mullion-session-manager/pull/1234");
    expect(links[0].text).not.toBe("https://github.com/s3ntin3l8/mullion-session");
  });

  it("reconstructs a URL wrapped inside an inset diff panel narrower than the terminal (corroboration path)", async () => {
    // Real, unmodified bytes captured from a live Mullion session
    // (`mullion session logs 792`) — Claude Code's diff-view panel wraps
    // prose at its OWN fixed inset width (50 columns), far short of the
    // terminal's actual 87. This is the case that falsified a plain
    // "row reaches term.cols" heuristic: the URL row alone never gets
    // anywhere near the right margin, so the join has to be justified by
    // the unrelated comment row two above it independently ending at the
    // exact same column (see the module header for the full replay).
    const wideTerm = new Terminal({ cols: 87, rows: 30, allowProposedApi: true });
    const data =
      "\x1b[38;2;36;138;61m\x1b[48;2;220;255;220m 36 +\x1b[38;2;51;51;51m  \x1b[38;2;167;29;93mconst\x1b[38;2;51;51;51m buttonRef = useRef<\x1b[38;2;0;0;0mHTMLButtonEle\r\x1b[6C\x1b[1B\x1b[38;2;36;138;61m \x1b[9G +\x1b[38;2;0;0;0mment\x1b[38;2;51;51;51m>(\x1b[38;2;0;134;179mnull\x1b[38;2;51;51;51m);      \x1b[30G                \x1b[47G \x1b[49G  \r\x1b[5C\x1b[1B\x1b[49m\x1b[2m 37 \x1b[22m \x1b[39m\x1b[K\r\x1b[6C\x1b[1B\x1b[38;2;51;51;51m\x1b[2m38 \x1b[22m   \x1b[38;2;150;152;150m// Adjusting state during render (Reac\r\x1b[6C\x1b[1B\x1b[38;2;51;51;51m\x1b[2m \x1b[9G \x1b[11G\x1b[22m\x1b[38;2;150;152;150mt's own documented pattern for this,\r\x1b[6C\x1b[1B\x1b[38;2;51;51;51m\x1b[2m39 \x1b[12G\x1b[22m \x1b[38;2;150;152;150m// https://react.dev/learn/you-might-n\r\x1b[5C\x1b[1B\x1b[38;2;51;51;51m\x1b[2m    \x1b[22m \x1b[38;2;150;152;150mot-need-an-effect#adjusting-some-state-w\r\x1b[1B\x1b[39m \x1b[3G   \x1b[38;2;51;51;51m\x1b[2m    \x1b[22m \x1b[38;2;150;152;150mhen-a-prop-changes)\x1b[39m\x1b[K";
    await write(wideTerm, data);

    const buf = asBufferSource(wideTerm);
    const line5 = buf.getLine(5)!; // "      39    // https://react.dev/learn/you-might-n"
    expect(line5.translateToString(true).length).toBe(50);
    expect(buf.cols - line5.translateToString(true).length).toBeGreaterThan(RIGHT_EDGE_SLACK);

    const links = computeLinksForRow(buf, 5);
    expect(links).toHaveLength(1);
    // Joins 2 of the 3 hard-wrapped rows, not all 3: the third row's own
    // contribution ("hen-a-prop-changes") contains only hyphens, no
    // structural URL character (STRUCTURAL_CHAR_RE — see that constant's
    // own comment for why the class is deliberately narrow), so the join
    // correctly stops one row short rather than risk a wider, weaker
    // structural check letting through ordinary English on some other,
    // unrelated row. A URL missing its final fragment segment still opens
    // the right page — this is the safe direction, not a regression.
    expect(links[0].text).toBe(
      "https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-w",
    );
    expect(links[0].rowCount).toBe(2);
  });

  it("still joins a genuine soft wrap (isWrapped rows) — must not regress", async () => {
    await write(
      term,
      "  soft https://github.com/s3ntin3l8/mullion-session-manager/pull/1234 end\r\n",
    );
    const buf = asBufferSource(term);
    const line1 = buf.getLine(1)!;
    expect(line1.isWrapped).toBe(true);

    const links = computeLinksForRow(buf, 0);
    expect(
      links.some(
        (l) => l.text === "https://github.com/s3ntin3l8/mullion-session-manager/pull/1234",
      ),
    ).toBe(true);
  });

  it("rejects the false-positive: two unrelated lines that both happen to sit near the edge", async () => {
    await write(term, "  See https://github.com/foo/bar\r\n  installed at /usr/lib\r\n");
    const buf = asBufferSource(term);
    const links = computeLinksForRow(buf, 0);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://github.com/foo/bar");
  });

  it("reconstructs a URL word-wrapped inside opencode's own bordered panel (mid-token-break guard)", async () => {
    // Shape captured from a live opencode Mullion session (`git remote -v`
    // output rendered inside opencode's `┃`-bordered panel, cols 78):
    // opencode word-wraps its own panel content, so the wrap column varies
    // per line rather than sitting at a fixed hard-wrap width — and the
    // continuation ("tracker.git") carries only `.`/`-`, which the
    // structural gate alone would reject were it not for the producer row
    // visibly ending mid-token ("pocket-"). Without this fix, row 0's own
    // fragment matches on its own and opens a truncated
    // `https://github.com/s3ntin3l8/pocket-` — a 404, not the repo.
    const wideTerm = new Terminal({ cols: 78, rows: 30, allowProposedApi: true });
    const lines = [
      "  ┃  $ git remote -v",
      "  ┃",
      "  ┃  origin  https://github.com/s3ntin3l8/pocket-",
      "  ┃  portfolio-tracker.git (fetch)",
      "  ┃  origin  https://github.com/s3ntin3l8/pocket-",
      "  ┃  portfolio-tracker.git (push)",
    ];
    await write(wideTerm, lines.join("\r\n") + "\r\n");

    const buf = asBufferSource(wideTerm);
    const line2 = buf.getLine(2)!;
    expect(line2.isWrapped).toBe(false); // confirms this is opencode's own wrap, not a terminal soft wrap

    const links = computeLinksForRow(buf, 2);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("https://github.com/s3ntin3l8/pocket-portfolio-tracker.git");
    expect(links[0].text).not.toBe("https://github.com/s3ntin3l8/pocket-");
    expect(links[0].rowCount).toBe(2);

    // The duplicated `origin ... (push)` line resolves identically — the
    // fix must not depend on which occurrence of the pattern is hovered.
    const links4 = computeLinksForRow(buf, 4);
    expect(links4).toHaveLength(1);
    expect(links4[0].text).toBe(links[0].text);
  });
});
