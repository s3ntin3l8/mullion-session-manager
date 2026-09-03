import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetStoredSettings = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

import {
  resolveOpenCodeModel,
  resolveOpenCodeSmallModel,
} from "../../src/services/task-model-resolve.js";

function mockApp(): FastifyInstance {
  return {
    log: { warn: vi.fn() },
    db: {},
  } as unknown as FastifyInstance;
}

const OPENCODE_SETTINGS = {
  opencode: {
    implementerModel: "openrouter/minimax-m3",
    reviewerModel: "anthropic/claude-haiku",
    defaultSmallModel: "opencode-go/cheap",
  },
};

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
    expect(result).toBe(OPENCODE_SETTINGS.opencode.implementerModel);
  });

  it("falls through to the install-wide default when neither task nor issue sets a model", () => {
    const result = resolveOpenCodeModel(mockApp(), {
      taskModel: null,
      issueBody: "No directive here.",
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.implementerModel);
  });

  it("returns null when nothing configures a model", () => {
    mockGetStoredSettings.mockReturnValue({
      opencode: { implementerModel: null, reviewerModel: null },
    });
    const result = resolveOpenCodeModel(mockApp(), { taskModel: null, issueBody: null });
    expect(result).toBeNull();
  });

  it("logs a warning and falls through when the task column is malformed", () => {
    const app = mockApp();
    const result = resolveOpenCodeModel(app, {
      taskModel: "no-slash",
      issueBody: null,
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.implementerModel);
    expect(app.log.warn).toHaveBeenCalledOnce();
  });

  it("logs a warning and falls through when the issue-body line is malformed", () => {
    const app = mockApp();
    const result = resolveOpenCodeModel(app, {
      taskModel: null,
      issueBody: "Model: also-no-slash",
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.implementerModel);
    expect(app.log.warn).toHaveBeenCalledOnce();
  });

  it("rejects a model string with embedded whitespace", () => {
    const app = mockApp();
    expect(resolveOpenCodeModel(app, { taskModel: "openrouter/foo bar", issueBody: null })).toBe(
      OPENCODE_SETTINGS.opencode.implementerModel,
    );
  });

  // Regression: MODEL_FORMAT_RE used to require EXACTLY one slash, rejecting
  // this shape and falling through to the install-wide default. Real
  // GET /api/opencode/models catalog entries (openrouter's own routing
  // prefix in front of the underlying provider/model pair) commonly have two
  // — e.g. "openrouter/anthropic/claude-sonnet-4-5" — so the old regex
  // rejected the majority of one real provider's catalog. Caught live
  // (curl against a running install's real catalog) once the settings-tier
  // deepMerge fix made this call site reachable for the first time.
  it("accepts a model string with more than one slash (e.g. a routing-prefixed openrouter id)", () => {
    const app = mockApp();
    expect(resolveOpenCodeModel(app, { taskModel: "openrouter/foo/bar", issueBody: null })).toBe(
      "openrouter/foo/bar",
    );
    expect(app.log.warn).not.toHaveBeenCalled();
  });

  describe("role-based resolution", () => {
    it("uses implementerModel setting when role is implementer", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: null,
        issueBody: null,
        role: "implementer",
      });
      expect(result).toBe("openrouter/minimax-m3");
    });

    it("uses reviewerModel setting when role is reviewer", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: null,
        issueBody: null,
        role: "reviewer",
      });
      expect(result).toBe("anthropic/claude-haiku");
    });

    it("defaults to implementer when role is omitted", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: null,
        issueBody: null,
      });
      expect(result).toBe("openrouter/minimax-m3");
    });

    it("prefers Reviewer-Model: over Model: when role is reviewer", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: null,
        issueBody: "Model: opencode-go/generic\nReviewer-Model: opencode-go/review-specific",
        role: "reviewer",
      });
      expect(result).toBe("opencode-go/review-specific");
    });

    it("falls back to Model: when Reviewer-Model: is absent and role is reviewer", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: null,
        issueBody: "Model: opencode-go/fallback",
        role: "reviewer",
      });
      expect(result).toBe("opencode-go/fallback");
    });

    it("ignores Reviewer-Model: when role is implementer", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: null,
        issueBody: "Reviewer-Model: opencode-go/ignored",
        role: "implementer",
      });
      expect(result).toBe(OPENCODE_SETTINGS.opencode.implementerModel);
    });

    it("taskModel overrides both roles regardless of directive", () => {
      const result = resolveOpenCodeModel(mockApp(), {
        taskModel: "anthropic/claude-opus",
        issueBody: "Model: opencode-go/impl\nReviewer-Model: opencode-go/review",
        role: "reviewer",
      });
      expect(result).toBe("anthropic/claude-opus");
    });
  });
});

describe("resolveOpenCodeSmallModel", () => {
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue(OPENCODE_SETTINGS);
  });

  it("returns the task's small_model when set and well-formed", () => {
    const result = resolveOpenCodeSmallModel(mockApp(), {
      taskSmallModel: "opencode-go/cheap",
      issueBody: "SmallModel: opencode-go/ignored",
    });
    expect(result).toBe("opencode-go/cheap");
  });

  it("falls through to the issue-body SmallModel: line when the task column is unset", () => {
    const result = resolveOpenCodeSmallModel(mockApp(), {
      taskSmallModel: null,
      issueBody: "SmallModel: opencode-go/dirt-cheap",
    });
    expect(result).toBe("opencode-go/dirt-cheap");
  });

  it("falls through to the install-wide default when neither task nor issue sets a value", () => {
    const result = resolveOpenCodeSmallModel(mockApp(), {
      taskSmallModel: null,
      issueBody: "No directive here.",
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.defaultSmallModel);
  });

  it("returns null when nothing configures a small_model", () => {
    mockGetStoredSettings.mockReturnValue({
      opencode: { ...OPENCODE_SETTINGS.opencode, defaultSmallModel: null },
    });
    const result = resolveOpenCodeSmallModel(mockApp(), {
      taskSmallModel: null,
      issueBody: null,
    });
    expect(result).toBeNull();
  });

  it("logs a warning and falls through when the task column is malformed", () => {
    const app = mockApp();
    const result = resolveOpenCodeSmallModel(app, {
      taskSmallModel: "no-slash",
      issueBody: null,
    });
    expect(result).toBe(OPENCODE_SETTINGS.opencode.defaultSmallModel);
    expect(app.log.warn).toHaveBeenCalledOnce();
  });
});
