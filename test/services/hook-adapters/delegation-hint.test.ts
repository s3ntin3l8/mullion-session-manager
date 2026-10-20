import { describe, it, expect } from "vitest";
import { getAdapterDelegationHint } from "../../../src/services/hook-adapters/index.js";

// The CLI-specific delegation clause. The four adapters each name their own
// CLI's delegation primitive AND their own way of choosing the child's model,
// because those genuinely differ:
//
//   claude-code: the Task tool takes a `subagent_type`; the child's model
//                 comes from that subagent's own definition, not the call.
//   codex:        `spawn_agent` takes a per-child model + reasoning effort.
//   opencode:     subagents are `agents.<name>` entries, each with a model.
//   agy:          `invoke_subagent` takes a spec with a model and a modelTier.
//
// A single generic sentence would be wrong for three of the four — naming
// `spawn_agent` to a Claude Code worker, or telling a Claude Code worker to
// "pass a cheaper model" (it can't — the model comes from the subagent's
// definition), would both be actively misleading.
describe("getAdapterDelegationHint", () => {
  it("names Claude Code's Task tool and its subagent-definition model", () => {
    const hint = getAdapterDelegationHint("claude");
    expect(hint).toBeTruthy();
    expect(hint).toContain("Task tool");
    expect(hint).toContain("subagent");
    expect(hint).toContain("model:");
    // The load-bearing detail: Claude Code's model comes from the
    // subagent's own definition, so the clause must NOT tell the worker to
    // pass a model at the call site.
    expect(hint).toContain("definition");
  });

  it("names Codex's spawn_agent and its per-child model", () => {
    const hint = getAdapterDelegationHint("codex");
    expect(hint).toBeTruthy();
    expect(hint).toContain("spawn_agent");
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
      expect(hint).toContain("committed here");
    }
  });

  it("tells the worker to keep the judgement-heavy parts itself", () => {
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const hint = getAdapterDelegationHint(command)!;
      expect(hint).toContain("judgement");
    }
  });
});
