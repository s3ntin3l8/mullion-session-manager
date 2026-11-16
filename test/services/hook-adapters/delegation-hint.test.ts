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
//   opencode:     the subagent tool takes an `agent` (the subagent type)
//                 and an optional per-call `model`, written as
//                 "providerID/modelID" or "providerID/modelID#variant".
//   agy:          `invoke_subagent` takes a spec with a model and a modelTier.
//
// A single generic sentence would be wrong for three of the four — naming
// `spawn_agent` to a Claude Code worker, or telling a Codex worker to pass
// a `model` field its schema may not expose, would both be actively
// misleading.
// A worker whose own model is unknown (the CLI's default) is always shown the
// clause for a configured delegate, so these tests exercise the wording; the
// tier comparison itself is in delegation.test.ts.
const ctx = (delegateModel: string) => ({ workerModel: null, delegateModel });

describe("getAdapterDelegationHint", () => {
  it("names Claude Code's Task tool and its per-call model override", () => {
    const hint = getAdapterDelegationHint("claude", ctx("sonnet"));
    expect(hint).toBeTruthy();
    expect(hint).toContain("Task tool");
    expect(hint).toContain("subagent");
    // The load-bearing detail: Claude Code's Task tool takes an optional
    // `model` for the call ("sonnet"/"opus"/"haiku"/"fable") which takes
    // precedence over the subagent definition's own `model:` frontmatter.
    // Verified against the installed claude-code's Task-tool input schema.
    expect(hint).toContain("model");
    // The configured Delegate model is named, not "a cheaper model".
    expect(hint).toContain('`model: "sonnet"`');
    expect(hint).toMatch(/precedence over/i);
    // The one load-bearing fact with no assertion behind it until now: the
    // override is IGNORED for `subagent_type: "fork"` — a fork always
    // inherits the parent model. A worker delegating with a fork (the
    // natural choice when it wants the child to keep its context) would
    // otherwise be told to expect a cheaper model and get none.
    expect(hint).toMatch(/unless the child is a fork/i);
    // And the other way the override can be unavailable: a session that
    // pins the subagent model drops the per-call `model` entirely ("The
    // model parameter is ignored on this session. Do not set it."), and
    // Mullion does not scrub the variable that does it. The clause must not
    // contradict that runtime message — and must not try to detect an env
    // var the worker cannot see, so it defers to what the tool reports.
    expect(hint).toMatch(/the tool reports that the model parameter is ignored/i);
  });

  it("names Codex's spawn_agent without assuming the model override is exposed", () => {
    const hint = getAdapterDelegationHint("codex", ctx("gpt-6-luna"));
    expect(hint).toBeTruthy();
    expect(hint).toContain("spawn_agent");
    // Codex's per-child model override sits behind
    // `multi_agent_v2.expose_spawn_agent_model_overrides`, so the clause
    // must not tell the worker to pass a field the tool may not expose —
    // "if the tool offers" keeps it true either way.
    expect(hint).toMatch(/if the tool offers/i);
    expect(hint).toContain("reasoning effort");
  });

  it("names opencode's subagent tool and its per-call model", () => {
    const hint = getAdapterDelegationHint("opencode", ctx("anthropic/claude-sonnet-5-5"));
    expect(hint).toBeTruthy();
    // Verified against the installed opencode v2.1.3's subagent-tool input
    // schema: `agent` (the subagent type), `description`, `prompt`, `model`
    // ("providerID/modelID" or "providerID/modelID#variant") and `sessionID`.
    // Those are 2.x's names — 1.x calls the first one `subagent_type` and
    // has no per-call model at all — and Mullion only WARNS about an old
    // install rather than refusing it, so the row is hedged to the version
    // that has the lever.
    expect(hint).toContain("`agent`");
    expect(hint).toContain("`model`");
    expect(hint).toContain("providerID/modelID");
    // The id must not be guessed: the tool's own parameter description says
    // to look it up with the `models` tool, filtered to the worker's own
    // provider. A row that told the worker to pass a cheaper model without
    // saying where to find one would be advice it cannot follow.
    expect(hint).toContain('`model: "anthropic/claude-sonnet-5-5"`');
    // And the built-in subagents are NOT the cheap option. `general` and
    // `explore` ship with opencode, but their v2 definitions set only
    // name/description/mode/permissions and carry no model of their own — so
    // "prefer a subagent configured with a cheaper model" has to point at
    // the per-call `model`, not at them. Asserted against the REMOVED
    // preference clause rather than the whole hint, so an unrelated future
    // phrasing ("in general", "the general case") cannot fail a test that
    // is not about those two agents.
    expect(hint).not.toContain("agents.<name>");
    expect(hint).not.toMatch(/ship built in/i);
    expect(hint).not.toMatch(/configured with a cheaper model/i);
    // The v1 tool has no per-call model, and Mullion only warns about a 1.x
    // install rather than refusing it — so the row has to be true on both
    // versions, and the hint must not claim the parameter is always there.
    expect(hint).toMatch(/on 2\.x/);
    expect(hint).toMatch(/where the tool offers it/i);
    // The tool's own note tells the model not to set `model` unasked. The
    // row has to resolve that, or a worker that reads the tool's schema
    // will skip the one argument the whole row depends on.
    expect(hint).toMatch(/this task is that ask/i);
  });

  it("names agy's invoke_subagent and its model/modelTier", () => {
    const hint = getAdapterDelegationHint("agy", ctx("gemini-flash"));
    expect(hint).toBeTruthy();
    expect(hint).toContain("invoke_subagent");
    expect(hint).toContain("modelTier");
    expect(hint).toContain('`model: "gemini-flash"`');
  });

  it("passes the Task tool one of its four model aliases, whatever was stored", () => {
    for (const [stored, alias] of [
      ["sonnet[1m]", "sonnet"],
      ["claude-haiku-5-5", "haiku"],
      ["opusplan", "sonnet"],
    ]) {
      const hint = getAdapterDelegationHint("claude", {
        workerModel: "fable",
        delegateModel: stored,
      });
      expect(hint).toContain(`\`model: "${alias}"\``);
    }
  });

  it("names no clause for a Claude delegate outside the Task tool's model enum", () => {
    expect(
      getAdapterDelegationHint("claude", {
        workerModel: "fable",
        delegateModel: "my-custom-model",
      }),
    ).toBeNull();
  });

  it("names Codex's delegate model and a reasoning effort", () => {
    expect(getAdapterDelegationHint("codex", ctx("gpt-6-luna"))).toContain('`model: "gpt-6-luna"`');
  });

  it("returns null when no Delegate model is configured", () => {
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      expect(getAdapterDelegationHint(command, { workerModel: null, delegateModel: null })).toBe(
        null,
      );
    }
  });

  it("returns null when the delegate is not cheaper than the worker's model", () => {
    // opusplan is Opus only while planning; a Task Master worker is never in
    // plan mode, so it already runs Sonnet.
    for (const workerModel of ["opusplan", "sonnet", "sonnet[1m]", "claude-sonnet-5-5", "haiku"]) {
      expect(
        getAdapterDelegationHint("claude", { workerModel, delegateModel: "sonnet" }),
      ).toBeNull();
    }
    expect(
      getAdapterDelegationHint("claude", { workerModel: "opus", delegateModel: "sonnet" }),
    ).toContain('`model: "sonnet"`');
    expect(
      getAdapterDelegationHint("claude", { workerModel: "fable[1m]", delegateModel: "sonnet" }),
    ).toBeTruthy();
    expect(
      getAdapterDelegationHint("codex", {
        workerModel: "gpt-6.1-sol",
        delegateModel: "gpt-6-luna",
      }),
    ).toBeTruthy();
    expect(
      getAdapterDelegationHint("codex", { workerModel: "gpt-6-luna", delegateModel: "gpt-6-luna" }),
    ).toBeNull();
  });

  it("returns null for a command no adapter matches", () => {
    expect(getAdapterDelegationHint("bash", ctx("sonnet"))).toBeNull();
    expect(getAdapterDelegationHint("zsh -lc 'ls'", ctx("sonnet"))).toBeNull();
    expect(getAdapterDelegationHint("", ctx("sonnet"))).toBeNull();
  });

  it("keeps the worker responsible for the final commit in every CLI's clause", () => {
    // The load-bearing invariant: a delegated implementation must not be
    // able to satisfy Task Master's "commits past base" gate on its own,
    // or the reviewer would judge a diff the worker never read.
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const hint = getAdapterDelegationHint(
        command,
        ctx(command === "claude" ? "sonnet" : "some-model"),
      )!;
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
      const hint = getAdapterDelegationHint(
        command,
        ctx(command === "claude" ? "sonnet" : "some-model"),
      )!;
      expect(hint).toContain("land on this branch");
      expect(hint).toContain("workspace or fork");
    }
  });

  it("tells the worker to keep the judgement-heavy parts itself", () => {
    for (const command of ["claude", "codex", "opencode", "agy"]) {
      const hint = getAdapterDelegationHint(
        command,
        ctx(command === "claude" ? "sonnet" : "some-model"),
      )!;
      expect(hint).toContain("judgement");
    }
  });
});
