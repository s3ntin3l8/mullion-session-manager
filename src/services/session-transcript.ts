// Issue #2268 — a hosted session's conversation as plain text.
//
// `sessions.scrollback` returns the terminal's bytes, which for a full-screen
// agent TUI is every repaint of the spinner and the input box. The agent CLI
// writes its own transcript, though: Claude Code a JSONL file whose path every
// hook payload carries (`transcript_path`), Codex a rollout file. This reads
// that file and returns the ordered entries.
//
// THE PATH IS UNTRUSTED. It arrives over the hook channel, which hook-protocol.ts
// documents as forgeable by anything holding the hook token. Same rules as
// src/hooks/codex-rollout.mjs: the file must resolve inside the CLI's own
// directory, be a regular file (opening a FIFO for reading blocks forever), and
// be opened with O_NOFOLLOW and re-checked with fstat.
//
// CURSORS. A transcript is append-only, so a line's number is a stable identity.
// One line can hold several entries (a user turn with three tool results), so an
// entry's `seq` is `line * SEQ_LINE_STRIDE + index`. Callers treat it as an opaque
// increasing cursor: pass the last `seq` seen (or the response's `nextSeq`) as
// `afterSeq` to read what came after.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import path from "node:path";
import { getAdapterTranscriptFormat } from "./hook-adapters/index.js";

export type TranscriptFormat = "claude-code" | "codex";
export type TranscriptRole = "user" | "assistant" | "tool";

export interface TranscriptEntry {
  seq: number;
  role: TranscriptRole;
  text: string;
  ts: string | null;
  /** Set when `text` was cut at MAX_ENTRY_CHARS. */
  truncated?: true;
}

export interface TranscriptQuery {
  /** Return only entries after this cursor; 0 reads from the start. */
  afterSeq: number;
  limit: number;
  /** Include tool calls and results in full instead of a one-line summary. */
  fullTools: boolean;
}

export type TranscriptResult =
  | { ok: true; entries: TranscriptEntry[]; nextSeq: number; more: boolean }
  | { ok: false; status: 404 | 409 | 501; error: string };

/** What a session knows about where its CLI keeps the conversation. */
export interface TranscriptSource {
  format: TranscriptFormat;
  path: string;
  /** Directories the file must resolve inside. */
  roots: string[];
}

/** The slice of a live session this needs, so tests need no PtyManager. */
export interface TranscriptSession {
  command: string;
  getTranscriptSource(): TranscriptSource | null;
}

export const SEQ_LINE_STRIDE = 1000;
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 500;
/** Text bytes in one response. */
export const MAX_PAGE_BYTES = 256 * 1024;
/** Characters of one entry's text. */
export const MAX_ENTRY_CHARS = 16 * 1024;
/** A longer line is counted but not parsed (Claude writes whole API requests as lines). */
const MAX_LINE_BYTES = 8 * 1024 * 1024;
const READ_CHUNK_BYTES = 1024 * 1024;
const TOOL_SUMMARY_CHARS = 200;

interface ParsedItem {
  role: TranscriptRole;
  text: string;
  ts: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Whitespace collapsed and cut, for the one-line tool summaries. */
function oneLine(text: string, max = TOOL_SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** The text of a tool result's `content`, which is a string or a list of blocks. */
function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return stringify(content);
  return content
    .map((block) => (isRecord(block) && typeof block.text === "string" ? block.text : ""))
    .filter((text) => text.length > 0)
    .join("\n");
}

function parseClaudeLine(line: Record<string, unknown>, fullTools: boolean): ParsedItem[] {
  // A subagent's own messages and the harness's injected context are not the
  // conversation the parent had.
  if (line.isSidechain === true || line.isMeta === true) return [];
  const type = line.type;
  if (type !== "user" && type !== "assistant") return [];
  const message = line.message;
  if (!isRecord(message)) return [];
  const ts = typeof line.timestamp === "string" ? line.timestamp : null;
  const content = message.content;
  if (typeof content === "string") {
    return content.trim().length > 0 ? [{ role: type, text: content, ts }] : [];
  }
  if (!Array.isArray(content)) return [];

  const items: ParsedItem[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      if (block.text.trim().length > 0) items.push({ role: type, text: block.text, ts });
    } else if (block.type === "tool_use") {
      const name = typeof block.name === "string" ? block.name : "tool";
      const input = stringify(block.input);
      items.push({
        role: "tool",
        text: fullTools ? `${name} ${input}` : `${name} ${oneLine(input)}`,
        ts,
      });
    } else if (block.type === "tool_result") {
      const result = toolResultText(block.content);
      items.push({
        role: "tool",
        text: fullTools ? `result: ${result}` : `result: ${oneLine(result)}`,
        ts,
      });
    }
    // thinking, images and server-side blocks are not part of the readable conversation.
  }
  return items;
}

function parseCodexLine(line: Record<string, unknown>, fullTools: boolean): ParsedItem[] {
  const payload = line.payload;
  if (!isRecord(payload)) return [];
  const ts = typeof line.timestamp === "string" ? line.timestamp : null;
  // The conversation proper is the event_msg pair; the response_item messages
  // repeat it and add the developer/environment context.
  if (line.type === "event_msg") {
    if (payload.type === "user_message" && typeof payload.message === "string") {
      return payload.message.trim().length > 0 ? [{ role: "user", text: payload.message, ts }] : [];
    }
    if (payload.type === "agent_message" && typeof payload.message === "string") {
      return payload.message.trim().length > 0
        ? [{ role: "assistant", text: payload.message, ts }]
        : [];
    }
    return [];
  }
  if (line.type === "response_item") {
    if (payload.type === "function_call") {
      const name = typeof payload.name === "string" ? payload.name : "tool";
      const args = stringify(payload.arguments);
      return [
        { role: "tool", text: fullTools ? `${name} ${args}` : `${name} ${oneLine(args)}`, ts },
      ];
    }
    if (payload.type === "function_call_output") {
      const out = stringify(payload.output);
      return [{ role: "tool", text: fullTools ? `result: ${out}` : `result: ${oneLine(out)}`, ts }];
    }
  }
  return [];
}

export function parseTranscriptLine(
  format: TranscriptFormat,
  line: unknown,
  fullTools: boolean,
): ParsedItem[] {
  if (!isRecord(line)) return [];
  return format === "claude-code"
    ? parseClaudeLine(line, fullTools)
    : parseCodexLine(line, fullTools);
}

function capText(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_ENTRY_CHARS) return { text, truncated: false };
  return {
    text: `${text.slice(0, MAX_ENTRY_CHARS)}… [truncated ${text.length - MAX_ENTRY_CHARS} chars]`,
    truncated: true,
  };
}

/**
 * Opens `candidate` for reading only when it is a regular file that resolves
 * inside one of `roots`. Returns the descriptor, or null when any check fails.
 * Same checks as `isCodexRolloutPath` (src/hooks/codex-rollout.mjs): lstat (so a
 * symlink is rejected outright), the real path inside the real root, then
 * O_NOFOLLOW plus fstat so a swap between the check and the open is not followed.
 */
function openInsideRoots(candidate: string, roots: string[]): number | null {
  if (typeof candidate !== "string" || candidate.length === 0) return null;
  try {
    if (!lstatSync(candidate).isFile()) return null;
    const real = realpathSync(candidate);
    const inside = roots.some((root) => {
      try {
        const relative = path.relative(realpathSync(root), real);
        return (
          relative.length > 0 &&
          relative !== ".." &&
          !relative.startsWith(".." + path.sep) &&
          !path.isAbsolute(relative)
        );
      } catch {
        return false;
      }
    });
    if (!inside) return null;
    const fd = openSync(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    if (!fstatSync(fd).isFile()) {
      closeSync(fd);
      return null;
    }
    return fd;
  } catch {
    return null;
  }
}

/** Reads one page of a transcript file. */
export function readTranscriptFile(
  source: TranscriptSource,
  query: TranscriptQuery,
): TranscriptResult {
  const fd = openInsideRoots(source.path, source.roots);
  if (fd === null) {
    return { ok: false, status: 404, error: "the transcript file is not readable" };
  }
  const limit = Math.min(Math.max(1, Math.trunc(query.limit)), MAX_LIMIT);
  const afterSeq = Math.max(0, Math.trunc(query.afterSeq));
  const entries: TranscriptEntry[] = [];
  let pageBytes = 0;
  let lineNo = 0;
  let more = false;

  // Returns true to stop reading.
  const handleLine = (n: number, line: Buffer | null): boolean => {
    // Every entry of this line is at or before the cursor: skip without parsing.
    if (n * SEQ_LINE_STRIDE + (SEQ_LINE_STRIDE - 1) <= afterSeq) return false;
    if (line === null) return false;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line.toString("utf8"));
    } catch {
      return false;
    }
    const items = parseTranscriptLine(source.format, parsed, query.fullTools).slice(
      0,
      SEQ_LINE_STRIDE - 1,
    );
    for (let i = 0; i < items.length; i++) {
      const seq = n * SEQ_LINE_STRIDE + i;
      if (seq <= afterSeq) continue;
      const item = items[i]!;
      const capped = capText(item.text);
      const size = Buffer.byteLength(capped.text);
      if (entries.length >= limit || (entries.length > 0 && pageBytes + size > MAX_PAGE_BYTES)) {
        more = true;
        return true;
      }
      const entry: TranscriptEntry = { seq, role: item.role, text: capped.text, ts: item.ts };
      if (capped.truncated) entry.truncated = true;
      entries.push(entry);
      pageBytes += size;
    }
    return false;
  };

  try {
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    let position = 0;
    let pending: Buffer[] = [];
    let pendingBytes = 0;
    let oversized = false;
    let stop = false;
    while (!stop) {
      const read = readSync(fd, chunk, 0, READ_CHUNK_BYTES, position);
      if (read === 0) break;
      position += read;
      const view = chunk.subarray(0, read);
      let start = 0;
      while (start < read) {
        const newline = view.indexOf(0x0a, start);
        if (newline === -1) {
          // An unterminated tail: a line still being written, or a line to be
          // completed by the next chunk. Copy it, the chunk is reused.
          if (!oversized) {
            pending.push(Buffer.from(view.subarray(start)));
            pendingBytes += read - start;
            if (pendingBytes > MAX_LINE_BYTES) {
              oversized = true;
              pending = [];
              pendingBytes = 0;
            }
          }
          break;
        }
        const piece = view.subarray(start, newline);
        let line: Buffer | null = null;
        if (!oversized) {
          line = pending.length > 0 ? Buffer.concat([...pending, piece]) : piece;
          if (line.length > MAX_LINE_BYTES) line = null;
        }
        pending = [];
        pendingBytes = 0;
        oversized = false;
        lineNo++;
        if (handleLine(lineNo, line)) {
          stop = true;
          break;
        }
        start = newline + 1;
      }
    }
  } catch {
    return { ok: false, status: 404, error: "the transcript file is not readable" };
  } finally {
    try {
      closeSync(fd);
    } catch {
      // The read already produced its result.
    }
  }

  const last = entries.length > 0 ? entries[entries.length - 1]!.seq : afterSeq;
  // Stopped on a cap: resume right after the last entry returned. Reached the
  // end: skip past every complete line, so lines that held no entries are not
  // scanned again (a line still being written is not complete and not counted).
  const nextSeq = more ? last : Math.max(last, lineNo * SEQ_LINE_STRIDE + (SEQ_LINE_STRIDE - 1));
  return { ok: true, entries, nextSeq: Math.max(nextSeq, afterSeq), more };
}

/** Resolves a live session to its transcript and reads one page. */
export function readSessionTranscript(
  session: TranscriptSession | undefined,
  query: TranscriptQuery,
): TranscriptResult {
  if (!session) return { ok: false, status: 404, error: "the session is not running" };
  if (getAdapterTranscriptFormat(session.command) === null) {
    return {
      ok: false,
      status: 501,
      error: "this agent CLI does not expose a readable transcript (not-supported)",
    };
  }
  const source = session.getTranscriptSource();
  if (source === null) {
    return {
      ok: false,
      status: 409,
      error:
        "the session has not reported its transcript yet; it appears after the agent's first hook",
    };
  }
  return readTranscriptFile(source, query);
}
