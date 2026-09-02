import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listOpenCodeModels,
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
    expect(exec).toHaveBeenCalledWith("opencode", ["models"]);
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
});
