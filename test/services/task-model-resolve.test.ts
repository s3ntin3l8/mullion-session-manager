import { describe, it, expect, vi, beforeEach } from "vitest";
import type { FastifyInstance } from "fastify";

const mockGetStoredSettings = vi.hoisted(() => vi.fn());

vi.mock("../../src/services/settings.js", () => ({
  getStoredSettings: mockGetStoredSettings,
}));

import {
  explicitModelError,
  resolveCliModel,
  validateCliModel,
  validateModel,
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

describe("resolveCliModel", () => {
  const settings = {
    claudeCode: { defaultModel: "sonnet", reviewerModel: "opus" },
    codex: { defaultModel: null, reviewerModel: null },
    agy: { defaultModel: "gemini-3", reviewerModel: null },
  };
  beforeEach(() => {
    mockGetStoredSettings.mockReset();
    mockGetStoredSettings.mockReturnValue(settings);
  });

  it("prefers the task model, then the issue directive, then the install default", () => {
    const app = mockApp();
    expect(
      resolveCliModel(app, "claude-code", { taskModel: "opus", issueBody: "Model: haiku" }),
    ).toBe("opus");
    expect(resolveCliModel(app, "claude-code", { issueBody: "Model: haiku" })).toBe("haiku");
    expect(resolveCliModel(app, "claude-code", { issueBody: null })).toBe("sonnet");
    expect(resolveCliModel(app, "agy", { issueBody: null })).toBe("gemini-3");
  });

  it("returns null when nothing is configured", () => {
    expect(resolveCliModel(mockApp(), "codex", { issueBody: null })).toBeNull();
  });

  it("resolves the reviewer role: Reviewer-Model, Model, reviewerModel, then default", () => {
    const app = mockApp();
    const body = "Model: haiku\nReviewer-Model: fast";
    expect(resolveCliModel(app, "claude-code", { issueBody: body, role: "reviewer" })).toBe("fast");
    expect(
      resolveCliModel(app, "claude-code", { issueBody: "Model: haiku", role: "reviewer" }),
    ).toBe("haiku");
    expect(resolveCliModel(app, "claude-code", { issueBody: null, role: "reviewer" })).toBe("opus");
    // No reviewerModel set: reviewers share the implementer default.
    expect(resolveCliModel(app, "agy", { issueBody: null, role: "reviewer" })).toBe("gemini-3");
    // The implementer role ignores reviewer-only tiers.
    expect(resolveCliModel(app, "claude-code", { issueBody: body })).toBe("haiku");
    expect(resolveCliModel(app, "claude-code", { issueBody: null })).toBe("sonnet");
  });

  it("falls through an invalid value and logs it", () => {
    const app = mockApp();
    const result = resolveCliModel(app, "claude-code", {
      taskModel: "bad model; rm -rf /",
      issueBody: null,
    });
    expect(result).toBe("sonnet");
    expect(app.log.warn).toHaveBeenCalled();
  });
});

// Issue #1423 (CodeQL, PR #1448) — validateModel used to be a single regex
// (`/^\S+\/\S+$/`) vulnerable to catastrophic backtracking, since `\S` also
// matches "/" and gives the engine no unique split point between its two
// halves. Rewritten as a plain substring search; this both re-asserts the
// original semantics and guards against a regex regression, since a
// backtracking reintroduction wouldn't show up as a wrong boolean on a short
// input — only as this test hanging/timing out on a pathological one.
describe("validateModel", () => {
  it("requires a slash strictly between the first and last character, and no whitespace", () => {
    expect(validateModel("anthropic/claude-sonnet-4-5")).toBe(true);
    expect(validateModel("openrouter/anthropic/claude-sonnet-4-5")).toBe(true);
    expect(validateModel("a/b")).toBe(true);
    // A slash only at a boundary doesn't count on its own...
    expect(validateModel("/foo")).toBe(false);
    expect(validateModel("foo/")).toBe(false);
    // ...even combined with another slash at the other boundary, as long as
    // there's still an interior one somewhere.
    expect(validateModel("/foo/bar")).toBe(true);
    expect(validateModel("no-slash-at-all")).toBe(false);
    expect(validateModel("has a/space")).toBe(false);
    expect(validateModel("a/b\tc")).toBe(false);
    expect(validateModel("a")).toBe(false);
    expect(validateModel("")).toBe(false);
  });

  it("stays fast on the pathological input CodeQL flagged for the old backtracking regex", () => {
    // GitHub's own alert named "!/" repeated many times as the trigger for
    // the old `/^\S+\/\S+$/`. A match on that shape alone actually succeeds
    // fast (the engine's first, greedy split attempt already works) — the
    // worst case is a near-miss that FAILS only after every one of the
    // ~50,000 candidate split points has been tried and discarded, which a
    // trailing space (breaking \S+'s final segment) forces here. Verified
    // empirically: the old regex hung (>10s) on this exact input.
    const pathological = "!/".repeat(50_000) + " ";
    const start = performance.now();
    expect(validateModel(pathological)).toBe(false); // whitespace present — rejected outright
    expect(performance.now() - start).toBeLessThan(50);
  });
});

describe("validateCliModel", () => {
  it("accepts bare names and rejects shell-hostile or flag-like values", () => {
    expect(validateCliModel("claude-opus-4-5[1m]")).toBe(true);
    expect(validateCliModel("gpt-5")).toBe(true);
    expect(validateCliModel("--foo")).toBe(false);
    expect(validateCliModel("a b")).toBe(false);
    expect(validateCliModel("$(x)")).toBe(false);
    expect(validateCliModel("a'b")).toBe(false);
  });
});

// Issue #1423 — explicitModelError gates a caller-supplied model/smallModel
// on POST /api/sessions and /internal/sessions, where an invalid value has
// no "next precedence tier" to fall through to (unlike the resolvers above).
describe("explicitModelError", () => {
  it("validates a claude-code command's model against CLI_MODEL_RE", () => {
    expect(explicitModelError("claude", "model", "opusplan")).toBeNull();
    expect(explicitModelError("claude", "model", "claude-opus-4-5[1m]")).toBeNull();
    expect(explicitModelError("claude", "model", "--dangerously-skip-permissions")).not.toBeNull();
    expect(explicitModelError("claude", "model", "a b")).not.toBeNull();
    expect(explicitModelError("claude", "model", "$(x)")).not.toBeNull();
  });

  it("validates codex and agy commands the same way", () => {
    expect(explicitModelError("codex", "model", "gpt-6-sol")).toBeNull();
    expect(explicitModelError("codex", "model", "-m")).not.toBeNull();
    expect(explicitModelError("agy", "model", "gemini-3")).toBeNull();
    expect(explicitModelError("agy", "model", "'; rm -rf /'")).not.toBeNull();
  });

  it("never errors on smallModel for a claude-code/codex/agy command — it's meaningless there", () => {
    expect(explicitModelError("claude", "smallModel", "--anything at all")).toBeNull();
    expect(explicitModelError("codex", "smallModel", "$(x)")).toBeNull();
  });

  it("requires an opencode model/smallModel to be both provider/model-shaped and charset-safe", () => {
    expect(explicitModelError("opencode", "model", "anthropic/claude-sonnet-4-5")).toBeNull();
    expect(
      explicitModelError("opencode", "model", "openrouter/anthropic/claude-sonnet-4-5"),
    ).toBeNull();
    expect(explicitModelError("opencode", "smallModel", "opencode-go/cheap")).toBeNull();
    // No "/" at all — fails validateModel.
    expect(explicitModelError("opencode", "model", "sonnet")).not.toBeNull();
    // Has a "/", but a leading "-" and a "$()" are still a shell/argv hazard
    // once this lands in OPENCODE_CONFIG_CONTENT — validateModel alone
    // wouldn't catch it, so validateCliModel must run too.
    expect(explicitModelError("opencode", "model", "-x/$(y)")).not.toBeNull();
  });

  it("returns null for any value on a command with no model concept — the route drops it instead of erroring", () => {
    expect(explicitModelError("bash", "model", "anything, even garbage")).toBeNull();
    expect(explicitModelError("npm run build", "smallModel", "$(x)")).toBeNull();
  });
});
