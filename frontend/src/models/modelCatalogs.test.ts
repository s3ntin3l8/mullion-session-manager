// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from "vitest";
import { commandHasModelFlag, commandModelCli, MODEL_CATALOG_FETCHERS } from "./modelCatalogs.js";
import { jsonResponse } from "../test/jsonResponse.js";

describe("commandModelCli", () => {
  it("identifies the model-capable CLIs by their bare binary name", () => {
    expect(commandModelCli("claude")).toBe("claude-code");
    expect(commandModelCli("codex")).toBe("codex");
    expect(commandModelCli("agy")).toBe("agy");
    expect(commandModelCli("opencode")).toBe("opencode");
    // Issue #1784 — mcode (MiniMax Code) has its own model catalog.
    expect(commandModelCli("mcode")).toBe("mcode");
  });

  it("strips a leading path and trailing args, same as commandToBinary", () => {
    expect(commandModelCli("/usr/bin/codex -m x")).toBe("codex");
    expect(commandModelCli("claude --dangerously-skip-permissions")).toBe("claude-code");
    expect(commandModelCli("opencode run")).toBe("opencode");
    expect(commandModelCli("/usr/bin/mcode -m minimax/MiniMax-M3")).toBe("mcode");
  });

  it("returns null for a command with no known model-capable CLI", () => {
    expect(commandModelCli("bash")).toBeNull();
    expect(commandModelCli("npm run build")).toBeNull();
    expect(commandModelCli("gemini")).toBeNull();
  });
});

describe("commandHasModelFlag", () => {
  it("detects an existing --model flag for claude-code/agy/opencode", () => {
    expect(commandHasModelFlag("claude --model opus", "claude-code")).toBe(true);
    expect(commandHasModelFlag("claude --model=opus", "claude-code")).toBe(true);
    expect(commandHasModelFlag("agy --model gemini-3", "agy")).toBe(true);
    expect(commandHasModelFlag("claude", "claude-code")).toBe(false);
  });

  it("also detects codex's short -m flag", () => {
    expect(commandHasModelFlag("codex -m gpt-6-sol", "codex")).toBe(true);
    expect(commandHasModelFlag("codex --model gpt-6-sol", "codex")).toBe(true);
    expect(commandHasModelFlag("codex", "codex")).toBe(false);
    // -m is codex-specific — claude-code doesn't get a false positive on it.
    expect(commandHasModelFlag("claude -m", "claude-code")).toBe(false);
  });

  // Issue #1784 — mcode's adapter calls buildModelFlag with the "-m" short
  // flag, exactly like codex's, so a hand-typed `-m` also counts.
  it("also detects mcode's short -m flag", () => {
    expect(commandHasModelFlag("mcode -m minimax/MiniMax-M3", "mcode")).toBe(true);
    expect(commandHasModelFlag("mcode --model minimax/MiniMax-M3", "mcode")).toBe(true);
    expect(commandHasModelFlag("mcode", "mcode")).toBe(false);
  });

  it("is always false for opencode, which never reads --model out of the command line", () => {
    expect(commandHasModelFlag("opencode --model anthropic/claude-sonnet-4-5", "opencode")).toBe(
      false,
    );
  });
});

// The fetcher map replaced a chain of ternaries (Hermes review, PR #1828):
// a CLI added to `ModelCli` without a fetcher is now a COMPILE error rather
// than a silent fall-through to opencode's catalog.
describe("MODEL_CATALOG_FETCHERS", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const stubFetch = (calls: string[]) => {
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      calls.push(String(input));
      return Promise.resolve(jsonResponse(200, []));
    });
  };

  it("covers every fetched CLI exactly once", () => {
    expect(Object.keys(MODEL_CATALOG_FETCHERS).sort()).toEqual([
      "agy",
      "codex",
      "mcode",
      "opencode",
    ]);
  });

  it("sends each CLI to its own endpoint", async () => {
    const calls: string[] = [];
    stubFetch(calls);

    await MODEL_CATALOG_FETCHERS.mcode();
    await MODEL_CATALOG_FETCHERS.codex();
    await MODEL_CATALOG_FETCHERS.agy();
    await MODEL_CATALOG_FETCHERS.opencode();

    expect(calls).toEqual([
      "/api/mcode/models",
      "/api/codex/models",
      "/api/agy/models",
      "/api/opencode/models",
    ]);
  });
});
