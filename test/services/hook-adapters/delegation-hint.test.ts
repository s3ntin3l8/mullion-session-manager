import { describe, it, expect } from "vitest";
import { getAdapterDelegationHint } from "../../../src/services/hook-adapters/index.js";

// The CLI-specific delegation clause. The four adapters each name their own
// CLI's delegation primitive AND their own way of choosing the child's model,
// because those genuinely differ:
//
//   claude-code: the Task tool takes a `subagent_type` and an optional
//                 per-call `model` (sonnet/opus/haiku/fable) that takes
//                 precedence over the subagent definition's own `model:`;
//                 ignored for `subagent_type: "fork"`.
//   codex:        `spawn_agent` takes a per-child model + reasoning effort
//                 where the install exposes them.
//   opencode:     subagents are `agents.<name>` entries, each with a model.
//   agy:          `invoke_subagent` takes a spec with a model and a modelTier.
//
// A single generic sentence would be wrong for three of the four — naming
// `spawn_agent` to a Claude Code worker, or telling a Codex worker to pass
// a `model` field its schema may not expose, would both be actively
// misleading.
describe("getAdapterDelegationHint", () => {
  it("names Claude Code's Task tool and its per-call model override", () => {
    const hint = getAdapterDelegationHint("claude");
    expect(hint).toBeTruthy();
    expect(hint).toContain("Task tool");
    expect(hint).toContain("subagent");
    // The load-bearing detail: Claude Code's Task tool takes an optional
    // `model` for the call ("sonnet"/"opus"/"haiku"/"fable") which takes
    // precedence over the subagent definition's own `model:` frontmatter.
    // Verified against the installed claude-code's Task-tool input schema.
    expect(hint).toContain("model");
    expect(hint).toContain("haiku");
    expect(hint).toMatch(/precedence over/i);
    // The one load-bearing fact with no assertion behind it until now: the
    // override is IGNORED for `subagent_type: "fork"` — a fork always
    // inherits the parent model. A worker delegating with a fork (the
    // natural choice when it wants the child to keep its context) would
    // otherwise be told to expect a cheaper model and get none.
    expect(hint).toMatch(/unless the child is a fork/i);
    // Same for a session that pins the subagent model:
    // CLAUDE_CODE_SUBAGENT_MODEL_FORCE drops the per-call `model`
    // entirely ("The model parameter is ignored on this session"), and
    // Mullion does not scrub it, so a host that sets it in the server env
    // would otherwise hand every worker advice that cannot take effect.
    expect(hint).toMatch(/pins the\s+subagent model/i);
  });

  it("names Codex's spawn_agent without assuming the model override is exposed", () => {
    const hint = getAdapterDelegationHint("codex");
    expect(hint).toBeTruthy();
    expect(hint).toContain("spawn_agent");
    // Codex's per-child model override sits behind
    // `multi_agent_v2.expose_spawn_agent_model_overrides`, so the clause
    // must not tell the worker to pass a field the tool may not expose —
    // "if the tool offers" keeps it true either way.
    expect(hint).toMatch(/if the tool offers/i);
    expect(hint).toContain("reasoning effort");
  });

  it("names opencode's agents.<name> entries and their model", () => {
    const hint = getAdapterDelegationHint("opencode");
    expect(hint).toBeTruthy();
    expect(hint).toContain("agents.<name>");
    expect(hint).toContain("explore");
    expect(hint).toContain("general");
  });

  it("names agy's invoke_subagent and its model/modelTier", () => {
    const hint = getAdapterDelegationHint("agy");
    expect(hint).toBeTruthy();
    expect(hint).toContain("invoke_subagent");
    expect(hint).toContain("modelTier");
  });

  it("returns null for a command no adapter matches", () => {
    expect(getAdapterDelegationHint("bash")).toBeNull();
    expect(getAdapterDelegationHint("zsh -lc 'ls'")).toBeNull();
    expect(getAdapterDelegationHint("")).toBeNull();
  });

  it("keeps the worker responsible for the final commit in every CLI's clause", () => {
    // The load-bearing invariant: a delegated implementation must not be
    // able to satisfy Task Master's "commits past base" gate on its own,
    // or the reviewer would judge a diff the worker never read.
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const hint = getAdapterDelegationHint(command)!;
      expect(hint).toContain("responsible for the final commit");
    }
  });

  it("requires the delegated work to land on this branch, in every CLI's clause", () => {
    // The mechanism that breaks the invariant above: a child can work in
    // its own workspace or fork (Claude Code's Task tool has
    // `isolation: "worktree"`; codex's spawn_agent forks the workspace).
    // Its edits then land elsewhere and are never merged back — so the
    // clause has to name the landing requirement, not just restate the
    // worker's general responsibility for committing.
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const hint = getAdapterDelegationHint(command)!;
      expect(hint).toContain("land on this branch");
      expect(hint).toContain("workspace or fork");
    }
  });

  it("tells the worker to keep the judgement-heavy parts itself", () => {
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const hint = getAdapterDelegationHint(command)!;
      expect(hint).toContain("judgement");
    }
  });
});
