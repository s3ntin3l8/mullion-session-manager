import { describe, it, expect } from "vitest";
import {
  CLI_MODEL_ROLE_RESOLVERS,
  buildCliModelPairs,
  resolveCliModelRoles,
  resolveInstalledRoleModels,
  resolveOpencodeModelRoles,
} from "./modelRoles.js";
import { AGENT_OPTIONS } from "./settings/agentOptions.js";

// The DOM-free mirror of the backend's install-wide model-role fallback
// (src/services/task-model-resolve.ts). The two families genuinely differ
// in what an UNSET reviewer model means, and the difference is the whole
// reason this module exists:
//
//   - claude-code / codex / agy: resolveCliModel's candidate order ends
//     "... → install-wide reviewer model → install-wide DEFAULT model", so
//     an unset reviewer model means the reviewer runs on the implementer's
//     model.
//   - opencode: resolveOpenCodeModel's install-wide default is role-split
//     (reviewerModel for the reviewer, implementerModel for the
//     implementer) and an unset value resolves to null — no override at
//     all, so opencode's own default applies. The roles do NOT cross-fall
//     back.

describe("resolveCliModelRoles", () => {
  it("resolves the reviewer onto the implementer when the reviewer model is unset", () => {
    // The case that motivated the warning: an unset reviewer model means the
    // reviewer runs on exactly the implementer's model.
    const roles = resolveCliModelRoles("opusplan", null);
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
  });

  it("resolves both roles to nothing when both are unset", () => {
    const roles = resolveCliModelRoles(null, null);
    expect(roles.implementer).toBeNull();
    expect(roles.reviewer).toBeNull();
  });

  it("reports the roles as distinct when the reviewer names a different model", () => {
    const roles = resolveCliModelRoles("opusplan", "haiku");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("haiku");
  });

  it("resolves both roles to the same model when both name it", () => {
    const roles = resolveCliModelRoles("opusplan", "opusplan");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
  });

  it("treats undefined and null the same", () => {
    expect(resolveCliModelRoles(undefined, undefined)).toEqual(resolveCliModelRoles(null, null));
  });

  it("treats an empty string as unset, like the backend's own candidate loop", () => {
    // resolveCliModel skips any FALSY value (`if (!value) continue`), so
    // an empty string is "unset" on the backend. `??` would report the two
    // roles as distinct where the backend collapses them onto the
    // implementer's model.
    const roles = resolveCliModelRoles("opusplan", "");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
  });

  it("treats a stored-but-invalid reviewer model as unset, like the backend", () => {
    // The backend skips a candidate that fails validation and falls through
    // to the next tier, so an invalid `reviewerModel` collapses onto the
    // implementer's model — a REAL collapse the backend performs. Reporting
    // the two as distinct would hide it.
    const roles = resolveCliModelRoles("opusplan", "not a valid model!");
    expect(roles.implementer).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
  });

  it("treats a stored-but-invalid implementer model as no model at all", () => {
    // The same fall-through, the other direction: an invalid `defaultModel`
    // leaves the implementer with NO model, so the backend applies no model
    // to either role. Keeping the bad name would make the note name a
    // model that will never be applied.
    const roles = resolveCliModelRoles("not a valid model!", null);
    expect(roles.implementer).toBeNull();
    expect(roles.reviewer).toBeNull();
  });
});

describe("resolveOpencodeModelRoles", () => {
  it("does NOT fall back to the implementer model when the reviewer is unset", () => {
    // The distinction from resolveCliModelRoles: opencode's roles have
    // separate settings and neither inherits the other, so an unset
    // reviewer model means "no override" (opencode's own default), not
    // "the implementer's model".
    const roles = resolveOpencodeModelRoles("opencode-go/minimax-m3.1-flash-free", null);
    expect(roles.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(roles.reviewer).toBeNull();
  });

  it("resolves both roles to the same model when both name it", () => {
    const roles = resolveOpencodeModelRoles(
      "opencode-go/minimax-m3.1-flash-free",
      "opencode-go/minimax-m3.1-flash-free",
    );
    expect(roles.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(roles.reviewer).toBe("opencode-go/minimax-m3.1-flash-free");
  });

  it("resolves both roles to nothing when both are unset", () => {
    // Both unset → both fall to opencode's own default → the same model.
    const roles = resolveOpencodeModelRoles(null, null);
    expect(roles.implementer).toBeNull();
    expect(roles.reviewer).toBeNull();
  });

  it("reports the roles as distinct when the reviewer names a different model", () => {
    const roles = resolveOpencodeModelRoles(
      "opencode-go/minimax-m3.1-flash-free",
      "opencode-go/claude-haiku-5-5",
    );
    expect(roles.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(roles.reviewer).toBe("opencode-go/claude-haiku-5-5");
  });

  it("treats a stored-but-invalid opencode model as unset, like the backend", () => {
    // opencode's `validateModel` requires a `provider/model` shape, so a
    // bare name is skipped and the role ends up with no override at all.
    const roles = resolveOpencodeModelRoles("opencode-go/minimax-m3.1-flash-free", "haiku");
    expect(roles.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(roles.reviewer).toBeNull();
  });
});

describe("resolveInstalledRoleModels", () => {
  // The worker agent and the review agent are chosen independently, so they
  // can be DIFFERENT CLIs — and then each side's model comes from that
  // CLI's own settings. Comparing one CLI's two roles against each other
  // compares two models that never met.
  const pairs = {
    claude: resolveCliModelRoles("opusplan", null),
    codex: resolveCliModelRoles("gpt-5", null),
    agy: resolveCliModelRoles("gemini-3.8-flash-medium", null),
    opencode: resolveOpencodeModelRoles("opencode-go/minimax-m3.1-flash-free", null),
  };

  it("compares the worker's model against the REVIEWER's, across CLIs", () => {
    // worker = claude-code (opusplan), review agent = codex (gpt-5). The two
    // are different models, so there IS a second opinion — even though
    // codex's own two roles are identical.
    const roles = resolveInstalledRoleModels({
      workerCli: "claude",
      reviewCli: "codex",
      pairs,
    });
    expect(roles.worker).toBe("opusplan");
    expect(roles.reviewer).toBe("gpt-5");
    expect(roles.reviewCli).toBe("codex");
  });

  it("reports a collapse when the two roles land on the same model", () => {
    const roles = resolveInstalledRoleModels({
      workerCli: "claude",
      reviewCli: "claude",
      pairs,
    });
    expect(roles.worker).toBe("opusplan");
    expect(roles.reviewer).toBe("opusplan");
  });

  it("reports a collapse across different CLIs that name the same model", () => {
    const same: Record<string, ReturnType<typeof resolveCliModelRoles>> = {
      claude: resolveCliModelRoles("gpt-5", null),
      codex: resolveCliModelRoles("gpt-5", null),
    };
    const roles = resolveInstalledRoleModels({
      workerCli: "claude",
      reviewCli: "codex",
      pairs: same,
    });
    expect(roles.shared).toBe(true);
  });

  it("does not compare when either side has no model settings of its own", () => {
    // A reviewer or worker on a CLI with no model settings runs whatever
    // that CLI defaults to, which the panel cannot know — so it is skipped
    // rather than guessed.
    const roles = resolveInstalledRoleModels({
      workerCli: "claude",
      reviewCli: "gemini",
      pairs,
    });
    expect(roles.reviewer).toBeNull();
  });

  it("does not compare when there is no review agent at all", () => {
    const roles = resolveInstalledRoleModels({
      workerCli: "claude",
      reviewCli: "none",
      pairs,
    });
    expect(roles.reviewer).toBeNull();
  });
});

describe("buildCliModelPairs", () => {
  it("covers every model-capable agent option", () => {
    // The key set is DERIVED from AGENT_OPTIONS, so this holds structurally
    // — a new agent option cannot be missing from the comparison.
    const pairs = buildCliModelPairs({});
    for (const option of AGENT_OPTIONS) {
      expect(pairs).toHaveProperty(option.value);
    }
  });

  it("has a resolver for every agent option", () => {
    // Deriving the key set means an option with no resolver would be handed
    // null roles and quietly skipped — the comparison would report nothing
    // for a CLI it cannot read, which is the silent gap the hand-written key
    // list used to turn into a CI failure. This is the assertion that keeps
    // the derivation honest: a model-injecting CLI added to AGENT_OPTIONS
    // without a resolver fails HERE.
    for (const option of AGENT_OPTIONS) {
      expect(CLI_MODEL_ROLE_RESOLVERS[option.value]).toBeTypeOf("function");
    }
  });

  it("has no resolver for an option that no longer exists", () => {
    // The other direction: a resolver left behind for a CLI that is no
    // longer offered would keep a stale entry in the map.
    const optionValues = new Set(AGENT_OPTIONS.map((option) => option.value));
    for (const key of Object.keys(CLI_MODEL_ROLE_RESOLVERS)) {
      expect(optionValues.has(key)).toBe(true);
    }
  });

  it("resolves each CLI's own two roles", () => {
    const pairs = buildCliModelPairs({
      claudeCode: { defaultModel: "opusplan", reviewerModel: null },
      codex: { defaultModel: "gpt-5", reviewerModel: "gpt-6" },
      agy: { defaultModel: "gemini-3.8-flash-medium", reviewerModel: null },
      opencode: {
        implementerModel: "opencode-go/minimax-m3.1-flash-free",
        reviewerModel: null,
      },
    });
    expect(pairs.claude.implementer).toBe("opusplan");
    expect(pairs.claude.reviewer).toBe("opusplan");
    expect(pairs.codex.implementer).toBe("gpt-5");
    expect(pairs.codex.reviewer).toBe("gpt-6");
    expect(pairs.agy.implementer).toBe("gemini-3.8-flash-medium");
    expect(pairs.agy.reviewer).toBe("gemini-3.8-flash-medium");
    expect(pairs.opencode.implementer).toBe("opencode-go/minimax-m3.1-flash-free");
    expect(pairs.opencode.reviewer).toBeNull();
  });
});
