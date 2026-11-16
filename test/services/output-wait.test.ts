import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as scrollbackRender from "../../src/services/scrollback-render.js";
import {
  compileOutputMatcher,
  waitForOutput,
  MAX_MATCH_LENGTH,
  type OutputMatcher,
} from "../../src/services/output-wait.js";

function matcher(match: string, regex?: boolean) {
  const m = compileOutputMatcher(match, regex);
  if (!m.ok) throw new Error(m.error);
  return m;
}

describe("compileOutputMatcher", () => {
  it("matches a literal substring by default, treating regex metacharacters literally", () => {
    const m = matcher("a.b(c)") as Extract<OutputMatcher, { ok: true }>;
    expect(m.find("xx a.b(c) yy")).toEqual({ text: "a.b(c)", index: 3 });
    expect(m.find("aXb(c)")).toBeNull();
  });

  it("compiles an opt-in regex", () => {
    const m = matcher("Tests: \\d+ passed", true) as Extract<OutputMatcher, { ok: true }>;
    expect(m.find("Tests: 42 passed")).toEqual({ text: "Tests: 42 passed", index: 0 });
    expect(m.find("Tests: x passed")).toBeNull();
  });

  it.each([
    ["empty", ""],
    ["non-string", 5],
    ["too long", "x".repeat(MAX_MATCH_LENGTH + 1)],
  ])("rejects a %s match", (_n, value) => {
    expect(compileOutputMatcher(value, false).ok).toBe(false);
  });

  it("rejects a non-boolean regex flag", () => {
    expect(compileOutputMatcher("x", "yes").ok).toBe(false);
  });

  it.each([
    "(a+)+$",
    "(.*)*x",
    "(a*)*b",
    "(a)\\1",
    "(?<n>a)\\k<n>",
    "(?=a)b",
    "(?!a)b",
    "(?<=a)b",
    "(",
    "x?",
    "^",
    "\\d*",
    "(foo)?",
  ])("rejects the unsafe/invalid regex %s", (pattern) => {
    expect(compileOutputMatcher(pattern, true).ok).toBe(false);
  });
});

describe("waitForOutput", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function deps(
    opts: { seed?: Buffer; alive?: () => boolean; signal?: AbortSignal; warn?: () => void } = {},
  ) {
    const listeners = new Set<(chunk: Buffer) => void>();
    return {
      listeners,
      emit: (text: string) => listeners.forEach((l) => l(Buffer.from(text))),
      deps: {
        onData: (l: (chunk: Buffer) => void) => {
          listeners.add(l);
          return () => listeners.delete(l);
        },
        alive: opts.alive ?? (() => true),
        size: { cols: 80, rows: 24 },
        ...(opts.warn ? { warn: opts.warn } : {}),
        ...(opts.seed ? { seed: opts.seed } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
    };
  }

  it("resolves on a match, stripping ANSI and returning the whole line", async () => {
    const d = deps();
    const p = waitForOutput(matcher("passed"), 10_000, d.deps);
    d.emit("\u001b[1mrunning\u001b[0m\r\n\u001b[32m5 passed\u001b[0m in 1s\r\n");
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toEqual({ matched: true, text: "passed", line: "5 passed in 1s" });
    expect(d.listeners.size).toBe(0);
  });

  it("matches text split across two chunks", async () => {
    const d = deps();
    const p = waitForOutput(matcher("ALL GREEN"), 10_000, d.deps);
    d.emit("ALL GR");
    await vi.advanceTimersByTimeAsync(150);
    d.emit("EEN\n");
    await vi.advanceTimersByTimeAsync(150);
    await expect(p).resolves.toMatchObject({ matched: true });
  });

  it("matches output that was already printed (the seed)", async () => {
    const d = deps({ seed: Buffer.from("done: OK\n") });
    const p = waitForOutput(matcher("OK"), 10_000, d.deps);
    await vi.advanceTimersByTimeAsync(300);
    await expect(p).resolves.toMatchObject({ matched: true });
  });

  it("times out", async () => {
    const d = deps();
    const p = waitForOutput(matcher("never"), 500, d.deps);
    await vi.advanceTimersByTimeAsync(600);
    await expect(p).resolves.toEqual({ matched: false, timedOut: true });
    expect(d.listeners.size).toBe(0);
  });

  it("reports gone when the child exits, after one last look at the buffer", async () => {
    let alive = true;
    const d = deps({ alive: () => alive });
    const p = waitForOutput(matcher("bye"), 60_000, d.deps);
    d.emit("no match here");
    alive = false;
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(p).resolves.toEqual({ matched: false, gone: true });
  });

  it("an exit that lands together with the final bytes still matches", async () => {
    let alive = true;
    const d = deps({ alive: () => alive });
    const p = waitForOutput(matcher("bye"), 60_000, d.deps);
    d.emit("bye\n");
    alive = false;
    await vi.advanceTimersByTimeAsync(1_100);
    await expect(p).resolves.toMatchObject({ matched: true });
  });

  it("aborts (signal) without leaving a listener or timer behind", async () => {
    const controller = new AbortController();
    const d = deps({ signal: controller.signal });
    const p = waitForOutput(matcher("x"), 60_000, d.deps);
    controller.abort();
    await expect(p).resolves.toEqual({ aborted: true });
    expect(d.listeners.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("an already-aborted signal resolves immediately", async () => {
    const controller = new AbortController();
    controller.abort();
    const d = deps({ signal: controller.signal });
    await expect(waitForOutput(matcher("x"), 60_000, d.deps)).resolves.toEqual({ aborted: true });
  });

  it("only the trailing window is searched, so old output is bounded away", async () => {
    const d = deps();
    const p = waitForOutput(matcher("NEEDLE"), 1_000, d.deps);
    d.emit("NEEDLE" + "x".repeat(100_000)); // pushes NEEDLE out of the raw window
    await vi.advanceTimersByTimeAsync(1_200);
    await expect(p).resolves.toEqual({ matched: false, timedOut: true });
  });

  describe("rendered view", () => {
    afterEach(() => vi.restoreAllMocks());

    it("resolves a partially repainted line to its full clean text and line", async () => {
      const d = deps();
      const p = waitForOutput(matcher("Re-print ONLY items 1-4 as a single"), 10_000, d.deps);
      // A TUI wrote the line, then repainted only the changed cells, skipping
      // the unchanged ones with cursor-forward escapes.
      d.emit("Re-print ONLY items 1-4 as a singlx");
      d.emit("\r\u001b[34Ce\r\n");
      await vi.advanceTimersByTimeAsync(300);
      const r = await p;
      expect(r).toMatchObject({ matched: true });
      expect((r as { line: string }).line).toBe("Re-print ONLY items 1-4 as a single");
    });

    it("a line repainted five times yields one clean match, and the wait settles once", async () => {
      const d = deps();
      const p = waitForOutput(matcher("DONE", false), 10_000, d.deps);
      for (let i = 0; i < 5; i++) d.emit("\u001b[2K\rbuild DONE ok");
      await vi.advanceTimersByTimeAsync(300);
      await expect(p).resolves.toEqual({ matched: true, text: "DONE", line: "build DONE ok" });
      expect(d.listeners.size).toBe(0);
    });

    it("matches a marker printed on the alternate screen", async () => {
      const d = deps();
      const p = waitForOutput(matcher("ALT-MARKER"), 10_000, d.deps);
      d.emit("shell$ vim\r\n\u001b[?1049h\u001b[2J\u001b[HALT-MARKER here");
      await vi.advanceTimersByTimeAsync(300);
      await expect(p).resolves.toMatchObject({ matched: true, line: "ALT-MARKER here" });
    });

    it("falls back to ANSI-stripped matching, with a warning, when rendering fails", async () => {
      vi.spyOn(scrollbackRender, "renderScrollback").mockRejectedValue(new Error("boom"));
      const warn = vi.fn();
      const d = deps({ warn });
      const p = waitForOutput(matcher("passed"), 10_000, d.deps);
      d.emit("\u001b[32m5 passed\u001b[0m\r\n");
      await vi.advanceTimersByTimeAsync(300);
      await expect(p).resolves.toEqual({ matched: true, text: "passed", line: "5 passed" });
      expect(warn).toHaveBeenCalledTimes(1);
    });

    it("renders at most once per debounce window and only when new bytes arrived", async () => {
      const spy = vi.spyOn(scrollbackRender, "renderScrollback");
      const d = deps();
      const p = waitForOutput(matcher("never"), 5_000, d.deps);
      for (let i = 0; i < 20; i++) d.emit(`chunk ${i}\r\n`);
      await vi.advanceTimersByTimeAsync(150);
      expect(spy).toHaveBeenCalledTimes(1);
      // No new bytes: no further render however long we wait.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(spy).toHaveBeenCalledTimes(1);
      d.emit("more\r\n");
      await vi.advanceTimersByTimeAsync(150);
      expect(spy).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      await p;
    });
  });
});
