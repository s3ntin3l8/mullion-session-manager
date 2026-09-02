import { describe, it, expect, vi, beforeEach } from "vitest";
import { listOpenCodeModels, resetOpenCodeModelsCache } from "../../src/services/opencode-models.js";

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
});
