import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetStoredSettings = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

import { resolveOpenCodeModel } from "../../src/services/task-model-resolve.js";

function mockApp(): FastifyInstance {
  return {
    log: { warn: vi.fn() },
    db: {},
  } as unknown as FastifyInstance;
}

const OPENCODE_SETTINGS = { opencode: { defaultModel: "openrouter/minimax-m3" } };

describe("resolveOpenCodeModel", () => {
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue(OPENCODE_SETTINGS);
  });

  it("returns the task's own model when set and well-formed", () => {
    const result = resolveOpenCodeModel(mockApp(), {
      taskModel: "anthropic/claude-sonnet-4-5",
      issueBody: "Model: opencode-go/ignored",
    });
    expect(result).toBe("anthropic/claude-sonnet-4-5");
  });

  it("falls through to the issue-body Model: line when the task column is unset", () => {
    const result = resolveOpenCodeModel(mockApp(), {
      taskModel: null,
      issueBody: "Some prose.\nModel: opencode-go/deepseek-v4-pro\nMore prose.",
    });
    expect(result).toBe("opencode-go/deepseek-v4-pro");
  });

  it("matches the Model: line case-insensitively", () => {
    const result = resolveOpenCodeModel(mockApp(), {
      taskModel: null,
      issueBody: "model: opencode-go/foo",
    });
    expect(result).toBe("opencode-go/foo");
  });

  it("does NOT match a Model: mention that is not on its own line", () => {
    const result = resolveOpenCodeModel(mockApp(), {
      taskModel: null,
      issueBody: "Use the Model: anthropic/claude-sonnet-4-5 model for this task.",
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.defaultModel);
  });

  it("falls through to the install-wide default when neither task nor issue sets a model", () => {
    const result = resolveOpenCodeModel(mockApp(), {
      taskModel: null,
      issueBody: "No directive here.",
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.defaultModel);
  });

  it("returns null when nothing configures a model", () => {
    mockGetStoredSettings.mockReturnValue({ opencode: { defaultModel: null } });
    const result = resolveOpenCodeModel(mockApp(), { taskModel: null, issueBody: null });
    expect(result).toBeNull();
  });

  it("logs a warning and falls through when the task column is malformed", () => {
    const app = mockApp();
    const result = resolveOpenCodeModel(app, {
      taskModel: "no-slash",
      issueBody: null,
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.defaultModel);
    expect(app.log.warn).toHaveBeenCalledOnce();
  });

  it("logs a warning and falls through when the issue-body line is malformed", () => {
    const app = mockApp();
    const result = resolveOpenCodeModel(app, {
      taskModel: null,
      issueBody: "Model: also-no-slash",
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.defaultModel);
    expect(app.log.warn).toHaveBeenCalledOnce();
  });

  it("rejects a model string with embedded whitespace or extra slashes", () => {
    const app = mockApp();
    expect(
      resolveOpenCodeModel(app, { taskModel: "openrouter/foo bar", issueBody: null }),
    ).toBe(OPENCODE_SETTINGS.opencode.defaultModel);
    expect(
      resolveOpenCodeModel(app, { taskModel: "openrouter/foo/bar", issueBody: null }),
    ).toBe(OPENCODE_SETTINGS.opencode.defaultModel);
  });
});
