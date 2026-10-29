import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MAX_ENTRY_CHARS,
  claudeProjectDirNames,
  SEQ_LINE_STRIDE,
  parseTranscriptLine,
  readSessionTranscript,
  readTranscriptFile,
  type TranscriptSource,
} from "../../src/services/session-transcript.js";

let dir: string;
let root: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mullion-transcript-"));
  root = path.join(dir, "projects");
  fs.mkdirSync(root, { recursive: true });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const jsonl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

function claudeSource(file: string): TranscriptSource {
  return { format: "claude-code", path: file, roots: [root] };
}

// A trimmed recording of the shapes Claude Code writes: housekeeping lines
// (mode, attachment), a plain-string user turn, an assistant text block, a tool
// call, its result, and a sidechain line that is not part of the conversation.
const CLAUDE_LINES = [
  { type: "mode", mode: "normal" },
  {
    type: "user",
    timestamp: "2026-10-29T10:00:00Z",
    message: { role: "user", content: "run the tests" },
  },
  {
    type: "assistant",
    timestamp: "2026-10-29T10:00:05Z",
    message: { role: "assistant", content: [{ type: "thinking", thinking: "hm" }] },
  },
  {
    type: "assistant",
    timestamp: "2026-10-29T10:00:06Z",
    message: { role: "assistant", content: [{ type: "text", text: "Running them now." }] },
  },
  {
    type: "assistant",
    timestamp: "2026-10-29T10:00:07Z",
    message: {
      role: "assistant",
      content: [{ type: "tool_use", name: "Bash", input: { command: "npm test" } }],
    },
  },
  {
    type: "user",
    timestamp: "2026-10-29T10:00:30Z",
    message: {
      role: "user",
      content: [
        { type: "tool_result", content: [{ type: "text", text: "Tests  12 passed\n(12)" }] },
        { type: "tool_result", content: "second   result" },
      ],
    },
  },
  { type: "user", isSidechain: true, message: { role: "user", content: "subagent noise" } },
  { type: "user", isMeta: true, message: { role: "user", content: "harness context" } },
  {
    type: "assistant",
    timestamp: "2026-10-29T10:00:31Z",
    message: { role: "assistant", content: [{ type: "text", text: "All 12 pass." }] },
  },
];

describe("parseTranscriptLine", () => {
  it("claude: keeps text and tool blocks, drops thinking, sidechains and housekeeping", async () => {
    const items = CLAUDE_LINES.flatMap((l) => parseTranscriptLine("claude-code", l, false));
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ["user", "run the tests"],
      ["assistant", "Running them now."],
      ["tool", 'Bash {"command":"npm test"}'],
      ["tool", "result: Tests 12 passed (12)"],
      ["tool", "result: second result"],
      ["assistant", "All 12 pass."],
    ]);
  });

  it("claude: tools in full keep the whole input and result", async () => {
    const [result] = parseTranscriptLine("claude-code", CLAUDE_LINES[5], true);
    expect(result?.text).toBe("result: Tests  12 passed\n(12)");
  });

  it("claude: a long tool summary is cut to one short line", async () => {
    const [item] = parseTranscriptLine(
      "claude-code",
      {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Write", input: { text: "x".repeat(900) } }],
        },
      },
      false,
    );
    expect(item?.text.length).toBeLessThan(230);
    expect(item?.text.endsWith("…")).toBe(true);
  });

  it("codex: reads the event_msg pair, not the repeated response_item messages", async () => {
    const lines = [
      { type: "session_meta", payload: { id: "x" } },
      { type: "response_item", payload: { type: "message", role: "developer", content: [] } },
      { timestamp: "t1", type: "event_msg", payload: { type: "user_message", message: "hi" } },
      { timestamp: "t2", type: "event_msg", payload: { type: "agent_message", message: "hello" } },
      { type: "response_item", payload: { type: "message", role: "assistant", content: [] } },
      {
        type: "response_item",
        payload: { type: "function_call", name: "shell", arguments: '{"cmd":"ls"}' },
      },
      { type: "response_item", payload: { type: "function_call_output", output: "a\nb" } },
      { type: "event_msg", payload: { type: "token_count" } },
    ];
    const items = lines.flatMap((l) => parseTranscriptLine("codex", l, false));
    expect(items.map((i) => [i.role, i.text])).toEqual([
      ["user", "hi"],
      ["assistant", "hello"],
      ["tool", 'shell {"cmd":"ls"}'],
      ["tool", "result: a b"],
    ]);
  });

  it("ignores a non-object line", async () => {
    expect(parseTranscriptLine("claude-code", "nope", false)).toEqual([]);
    expect(parseTranscriptLine("codex", null, false)).toEqual([]);
  });
});

describe("readTranscriptFile", () => {
  function writeClaude(lines: unknown[] = CLAUDE_LINES): string {
    const file = path.join(root, "s.jsonl");
    fs.writeFileSync(file, jsonl(...lines));
    return file;
  }

  it("returns the ordered conversation with timestamps and a resume cursor", async () => {
    const result = await readTranscriptFile(claudeSource(writeClaude()), {
      afterSeq: 0,
      limit: 50,
      fullTools: false,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.entries.map((e) => e.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "tool",
      "tool",
      "assistant",
    ]);
    expect(result.entries[0]).toMatchObject({
      seq: 2 * SEQ_LINE_STRIDE,
      ts: "2026-10-29T10:00:00Z",
    });
    // A line with two tool results gives two entries with distinct, increasing seqs.
    expect(result.entries[3]!.seq).toBe(6 * SEQ_LINE_STRIDE);
    expect(result.entries[4]!.seq).toBe(6 * SEQ_LINE_STRIDE + 1);
    expect(result.more).toBe(false);
    // The cursor sits past every complete line, so nothing is rescanned.
    expect(result.nextSeq).toBe(CLAUDE_LINES.length * SEQ_LINE_STRIDE + (SEQ_LINE_STRIDE - 1));
  });

  it("pages with limit and resumes exactly where it stopped", async () => {
    const source = claudeSource(writeClaude());
    const seen: string[] = [];
    let afterSeq = 0;
    for (let page = 0; page < 10; page++) {
      const result = await readTranscriptFile(source, { afterSeq, limit: 2, fullTools: false });
      if (!result.ok) throw new Error(result.error);
      seen.push(...result.entries.map((e) => e.text));
      afterSeq = result.nextSeq;
      if (!result.more) break;
    }
    expect(seen).toHaveLength(6);
    expect(seen[0]).toBe("run the tests");
    expect(seen[5]).toBe("All 12 pass.");
  });

  it("returns only what was appended after a cursor", async () => {
    const file = writeClaude();
    const source = claudeSource(file);
    const first = await readTranscriptFile(source, { afterSeq: 0, limit: 50, fullTools: false });
    if (!first.ok) throw new Error(first.error);
    fs.appendFileSync(
      file,
      jsonl({
        type: "assistant",
        message: { content: [{ type: "text", text: "one more thing" }] },
      }),
    );
    const next = await readTranscriptFile(source, {
      afterSeq: first.nextSeq,
      limit: 50,
      fullTools: false,
    });
    if (!next.ok) throw new Error(next.error);
    expect(next.entries.map((e) => e.text)).toEqual(["one more thing"]);
  });

  it("does not consume a line still being written", async () => {
    const file = writeClaude([CLAUDE_LINES[1]]);
    fs.appendFileSync(file, '{"type":"assistant","message":{"content":[{"type":"te');
    const source = claudeSource(file);
    const partial = await readTranscriptFile(source, { afterSeq: 0, limit: 50, fullTools: false });
    if (!partial.ok) throw new Error(partial.error);
    expect(partial.entries).toHaveLength(1);
    fs.appendFileSync(file, 'xt","text":"done"}]}}\n');
    const done = await readTranscriptFile(source, {
      afterSeq: partial.nextSeq,
      limit: 50,
      fullTools: false,
    });
    if (!done.ok) throw new Error(done.error);
    expect(done.entries.map((e) => e.text)).toEqual(["done"]);
  });

  it("truncates a very long entry and marks it", async () => {
    const file = writeClaude([
      { type: "user", message: { content: "y".repeat(MAX_ENTRY_CHARS + 500) } },
    ]);
    const result = await readTranscriptFile(claudeSource(file), {
      afterSeq: 0,
      limit: 5,
      fullTools: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.entries[0]!.truncated).toBe(true);
    expect(result.entries[0]!.text).toContain("[truncated 500 chars]");
  });

  it("ends a page at the byte cap and reports more", async () => {
    const big = "z".repeat(MAX_ENTRY_CHARS - 10);
    const lines = Array.from({ length: 30 }, () => ({ type: "user", message: { content: big } }));
    const result = await readTranscriptFile(claudeSource(writeClaude(lines)), {
      afterSeq: 0,
      limit: 500,
      fullTools: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.entries.length).toBeLessThan(30);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(result.more).toBe(true);
  });

  it("counts but does not parse a line over the size limit", async () => {
    const file = path.join(root, "huge.jsonl");
    fs.writeFileSync(
      file,
      jsonl({ type: "user", message: { content: "first" } }) +
        JSON.stringify({ type: "api-request-blob", pad: "p".repeat(9 * 1024 * 1024) }) +
        "\n" +
        jsonl({ type: "user", message: { content: "after the blob" } }),
    );
    const result = await readTranscriptFile(claudeSource(file), {
      afterSeq: 0,
      limit: 50,
      fullTools: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.entries.map((e) => [e.seq, e.text])).toEqual([
      [1 * SEQ_LINE_STRIDE, "first"],
      [3 * SEQ_LINE_STRIDE, "after the blob"],
    ]);
  });

  it("refuses a path outside the roots", async () => {
    const outside = path.join(dir, "elsewhere.jsonl");
    fs.writeFileSync(outside, jsonl(CLAUDE_LINES[1]));
    const result = await readTranscriptFile(claudeSource(outside), {
      afterSeq: 0,
      limit: 5,
      fullTools: false,
    });
    expect(result).toMatchObject({ ok: false, status: 404 });
  });

  it("refuses a `..` traversal and a symlink that leaves the roots", async () => {
    const real = writeClaude();
    const outside = path.join(dir, "secret.jsonl");
    fs.writeFileSync(outside, jsonl(CLAUDE_LINES[1]));
    const q = { afterSeq: 0, limit: 5, fullTools: false };

    const escape = path.join(root, "escape.jsonl");
    fs.symlinkSync(outside, escape);
    expect(await readTranscriptFile(claudeSource(escape), q)).toMatchObject({ ok: false });
    expect(
      await readTranscriptFile(claudeSource(path.join(root, "..", "secret.jsonl")), q),
    ).toMatchObject({ ok: false });

    // A symlink or `..` that still lands on a file inside the root is the same file.
    const link = path.join(root, "link.jsonl");
    fs.symlinkSync(real, link);
    expect((await readTranscriptFile(claudeSource(link), q)).ok).toBe(true);
    const sneaky = path.join(root, "..", "projects", "s.jsonl");
    expect((await readTranscriptFile(claudeSource(sneaky), q)).ok).toBe(true);
  });

  it("refuses a directory and a missing file", async () => {
    expect(
      (await readTranscriptFile(claudeSource(root), { afterSeq: 0, limit: 5, fullTools: false }))
        .ok,
    ).toBe(false);
    expect(
      (
        await readTranscriptFile(claudeSource(path.join(root, "gone.jsonl")), {
          afterSeq: 0,
          limit: 5,
          fullTools: false,
        })
      ).ok,
    ).toBe(false);
  });

  it("refuses a FIFO without blocking, and reports the file's identity on a page", async () => {
    const fifo = path.join(root, "pipe.jsonl");
    execFileSync("mkfifo", [fifo]);
    expect(
      await readTranscriptFile(claudeSource(fifo), { afterSeq: 0, limit: 5, fullTools: false }),
    ).toMatchObject({ ok: false, status: 404 });

    const a = path.join(root, "a.jsonl");
    const b = path.join(root, "b.jsonl");
    fs.writeFileSync(a, jsonl(CLAUDE_LINES[1]));
    fs.writeFileSync(b, jsonl(CLAUDE_LINES[1]));
    const q = { afterSeq: 0, limit: 5, fullTools: false };
    const pageA = await readTranscriptFile(claudeSource(a), q);
    const pageA2 = await readTranscriptFile(claudeSource(a), q);
    const pageB = await readTranscriptFile(claudeSource(b), q);
    if (!pageA.ok || !pageA2.ok || !pageB.ok) throw new Error("expected pages");
    expect(pageA.file).toBe(pageA2.file);
    expect(pageA.file).not.toBe(pageB.file);
  });

  it("does not split a surrogate pair when it truncates an entry", async () => {
    const file = path.join(root, "emoji.jsonl");
    fs.writeFileSync(
      file,
      jsonl({
        type: "user",
        message: { content: "a".repeat(MAX_ENTRY_CHARS - 1) + "😀" + "tail" },
      }),
    );
    const result = await readTranscriptFile(claudeSource(file), {
      afterSeq: 0,
      limit: 5,
      fullTools: false,
    });
    if (!result.ok) throw new Error(result.error);
    expect(result.entries[0]!.text).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
  });

  it("names the Claude project directories a cwd is filed under", () => {
    expect(claudeProjectDirNames("/nonexistent/.wt/x y")).toEqual(["-nonexistent--wt-x-y"]);
    // A name Claude would hash is not reproduced: no name, so no root.
    expect(claudeProjectDirNames("/" + "d".repeat(250))).toEqual([]);
  });

  it("reads a Codex rollout", async () => {
    const file = path.join(root, "rollout.jsonl");
    fs.writeFileSync(
      file,
      jsonl(
        { type: "session_meta", payload: {} },
        { timestamp: "t", type: "event_msg", payload: { type: "user_message", message: "hi" } },
        { timestamp: "t", type: "event_msg", payload: { type: "agent_message", message: "yo" } },
      ),
    );
    const result = await readTranscriptFile(
      { format: "codex", path: file, roots: [root] },
      { afterSeq: 0, limit: 5, fullTools: false },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.entries.map((e) => e.text)).toEqual(["hi", "yo"]);
  });
});

describe("readSessionTranscript", () => {
  const query = { afterSeq: 0, limit: 5, fullTools: false };

  it("404s a session that is not running", async () => {
    expect(await readSessionTranscript(undefined, query)).toMatchObject({ ok: false, status: 404 });
  });

  it("answers not-supported for a CLI with no transcript format", async () => {
    const result = await readSessionTranscript(
      { command: "bash", getTranscriptSource: () => null },
      query,
    );
    expect(result).toMatchObject({ ok: false, status: 501 });
    expect(result.ok === false && result.error).toContain("not-supported");
  });

  it("409s a supported CLI that has not reported a path yet", async () => {
    const result = await readSessionTranscript(
      { command: "claude", getTranscriptSource: () => null },
      query,
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses a source whose format is not the one this agent writes", async () => {
    const file = path.join(root, "s.jsonl");
    fs.writeFileSync(file, jsonl(CLAUDE_LINES[1]));
    const result = await readSessionTranscript(
      { command: "codex", getTranscriptSource: () => claudeSource(file) },
      query,
    );
    expect(result).toMatchObject({ ok: false, status: 409 });
  });

  it("reads once the session has a source", async () => {
    const file = path.join(root, "s.jsonl");
    fs.writeFileSync(file, jsonl(CLAUDE_LINES[1]));
    const result = await readSessionTranscript(
      { command: "claude", getTranscriptSource: () => claudeSource(file) },
      query,
    );
    expect(result.ok && result.entries[0]?.text).toBe("run the tests");
  });
});
