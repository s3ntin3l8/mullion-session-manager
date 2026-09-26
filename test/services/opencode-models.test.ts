import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listAgyModels,
  listCodexModels,
  resetCodexModelsCache,
  listOpenCodeModels,
  resetAgyModelsCache,
  resetOpenCodeModelsCache,
} from "../../src/services/opencode-models.js";

const REAL_OUTPUT = `opencode-go/deepseek-v4-pro
opencode-go/minimax-m3
anthropic/claude-sonnet-4-5
`;

describe("listOpenCodeModels", () => {
  beforeEach(() => {
    resetOpenCodeModelsCache();
  });

  it("parses the output of `opencode models` into a sorted, de-duplicated string array", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    const result = await listOpenCodeModels({ exec });
    expect(exec).toHaveBeenCalledWith(
      "opencode",
      ["models"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual([
      "anthropic/claude-sonnet-4-5",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/minimax-m3",
    ]);
  });

  it("returns an empty array if opencode is not installed", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ENOENT"));
    const result = await listOpenCodeModels({ exec });
    expect(result).toEqual([]);
  });

  it("returns the cached result on the second call within the TTL window", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    await listOpenCodeModels({ exec });
    await listOpenCodeModels({ exec });
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("re-runs the shell-out after the cache is reset", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    await listOpenCodeModels({ exec });
    resetOpenCodeModelsCache();
    await listOpenCodeModels({ exec });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("deduplicates concurrent cold-cache calls", async () => {
    let resolve!: (v: { stdout: string; stderr: string }) => void;
    const exec = vi
      .fn()
      .mockImplementation(
        () => new Promise<{ stdout: string; stderr: string }>((r) => (resolve = r)),
      );
    const p1 = listOpenCodeModels({ exec });
    const p2 = listOpenCodeModels({ exec });
    resolve({ stdout: REAL_OUTPUT, stderr: "" });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1).toEqual(r2);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("returns cached models when TTL has not elapsed", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    let tick = 1000;
    await listOpenCodeModels({ exec, now: () => tick });
    tick += 60 * 60 * 1000 - 1; // just under 1h
    const result = await listOpenCodeModels({ exec, now: () => tick });
    expect(result).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when TTL has elapsed", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    let tick = 1000;
    await listOpenCodeModels({ exec, now: () => tick });
    tick += 60 * 60 * 1000 + 1; // just over 1h
    await listOpenCodeModels({ exec, now: () => tick });
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("handles blank lines in output", async () => {
    const exec = vi
      .fn()
      .mockResolvedValue({ stdout: "\n\nmodel-a/b\n\nmodel-c/d\n\n", stderr: "" });
    const result = await listOpenCodeModels({ exec });
    expect(result).toEqual(["model-a/b", "model-c/d"]);
  });

  it("passes an AbortController signal to the exec call", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    await listOpenCodeModels({ exec });
    expect(exec).toHaveBeenCalledWith(
      "opencode",
      ["models"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("rejects with a timeout error and does NOT cache the empty result", async () => {
    let tick = 1000;
    const exec = vi.fn().mockImplementation(
      () =>
        new Promise<{ stdout: string; stderr: string }>(() => {
          // never resolves — simulates a hung provider
        }),
    );
    // The first call hits the timeout and resolves to [].
    const first = await listOpenCodeModels({ exec, now: () => tick });
    expect(first).toEqual([]);
    // The next call must NOT reuse the cached "[]" — it should retry the
    // exec. We resolve the second call promptly so it can succeed.
    exec.mockResolvedValueOnce({ stdout: REAL_OUTPUT, stderr: "" });
    tick += 60 * 60 * 1000 + 1; // well past the TTL
    const second = await listOpenCodeModels({ exec, now: () => tick });
    expect(second).toEqual([
      "anthropic/claude-sonnet-4-5",
      "opencode-go/deepseek-v4-pro",
      "opencode-go/minimax-m3",
    ]);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

const AGY_OUTPUT = `
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
gemini-3.1-pro-low\tGemini 3.1 Pro (Low)
-bad-flag\tLooks like an option
bad;slug\tShell metacharacter
`;

describe("listAgyModels", () => {
  beforeEach(() => {
    resetAgyModelsCache();
    resetOpenCodeModelsCache();
  });

  it("parses `agy models` rows, skipping invalid slugs, in CLI order", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: AGY_OUTPUT, stderr: "" });
    const result = await listAgyModels({ exec });
    expect(exec).toHaveBeenCalledWith(
      "agy",
      ["models"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result).toEqual(["gemini-3.8-flash-high", "gemini-3.1-pro-low", "claude-sonnet-4-6"]);
  });

  it("returns [] when agy is missing, and does not cache the failure", async () => {
    const exec = vi
      .fn()
      .mockRejectedValueOnce(new Error("ENOENT"))
      .mockResolvedValueOnce({ stdout: AGY_OUTPUT, stderr: "" });
    expect(await listAgyModels({ exec })).toEqual([]);
    expect(await listAgyModels({ exec })).toHaveLength(3);
    expect(exec).toHaveBeenCalledTimes(2);
  });

  it("caches independently of the opencode catalog", async () => {
    const agyExec = vi.fn().mockResolvedValue({ stdout: AGY_OUTPUT, stderr: "" });
    const ocExec = vi.fn().mockResolvedValue({ stdout: REAL_OUTPUT, stderr: "" });
    await listAgyModels({ exec: agyExec });
    await listOpenCodeModels({ exec: ocExec });
    await listAgyModels({ exec: agyExec });
    expect(agyExec).toHaveBeenCalledTimes(1);
    expect(ocExec).toHaveBeenCalledTimes(1);
  });
});

describe("listAgyModels (format drift)", () => {
  beforeEach(() => resetAgyModelsCache());

  it("still parses space-separated rows, and does not cache an empty parse", async () => {
    const exec = vi.fn().mockResolvedValueOnce({ stdout: "", stderr: "" }).mockResolvedValueOnce({
      stdout: "gemini-3.1-pro-high  Gemini 3.1 Pro (High)\nclaude-sonnet-4-6 Claude Sonnet\r\n",
      stderr: "",
    });
    expect(await listAgyModels({ exec })).toEqual([]);
    expect(await listAgyModels({ exec })).toEqual(["gemini-3.1-pro-high", "claude-sonnet-4-6"]);
    expect(exec).toHaveBeenCalledTimes(2);
  });
});

const CODEX_OUTPUT = JSON.stringify({
  models: [
    { slug: "gpt-5.5", visibility: "list", priority: 12 },
    { slug: "codex-auto-review", visibility: "hide", priority: 43 },
    { slug: "gpt-6-astra", visibility: "list", priority: 1 },
    { slug: "gpt-6-sol", visibility: "list", priority: 2 },
    { slug: "gpt-6-sol", visibility: "list", priority: 2 },
    { slug: "bad slug;rm", visibility: "list", priority: 3 },
    { visibility: "list", priority: 4 },
    "junk",
  ],
});

describe("listCodexModels", () => {
  beforeEach(() => resetCodexModelsCache());

  it("keeps only listed, valid slugs, ordered by priority and de-duplicated", async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: CODEX_OUTPUT, stderr: "" });
    expect(await listCodexModels({ exec })).toEqual(["gpt-6-astra", "gpt-6-sol", "gpt-5.5"]);
    expect(exec).toHaveBeenCalledWith(
      "codex",
      ["debug", "models"],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each([["not json"], ["{}"], ['{"models":"x"}'], ["null"]])(
    "returns [] for unusable output %j, uncached",
    async (stdout) => {
      const exec = vi.fn().mockResolvedValue({ stdout, stderr: "" });
      expect(await listCodexModels({ exec })).toEqual([]);
      expect(await listCodexModels({ exec })).toEqual([]);
      expect(exec).toHaveBeenCalledTimes(2);
    },
  );

  it("returns [] when codex is missing", async () => {
    const exec = vi.fn().mockRejectedValue(new Error("ENOENT"));
    expect(await listCodexModels({ exec })).toEqual([]);
  });
});
