import { describe, it, expect } from "vitest";
import {
  buildTaskMasterPreamble,
  buildWorkerPrompt,
  type TaskPromptTask,
} from "../../src/services/task-prompt.js";

const TASK: TaskPromptTask = {
  id: 42,
  issueNumber: 314,
  title: "fix: the widget explodes on Tuesdays",
  body: "## Context\n\nIt explodes.\n\n## Scope\n\n- [ ] Stop it exploding",
};

const BASE = {
  task: TASK,
  branchName: "mullion/task-42",
  worktreePath: "/srv/repo/.mullion-worktrees/mullion-task-42",
  budgetMinutes: 120,
};

// The CLI-aware delegation clause. `buildTaskMasterPreamble` is the single
// chokepoint every worker prompt renders through, and `buildReviewPrompt`
// (which has its own preamble array) is deliberately unaffected: a reviewer
// must not decompose the work it judges. The clause only appears when the
// install configured a Delegate model for the worker's CLI AND it is cheaper
// than the model the worker runs (hook-adapters/delegation.ts).
//
// The clause is soft-wrapped, so assertions run against a whitespace-
// normalized copy: a phrase that happens to straddle a line break is still
// present in the prompt, and asserting on the raw rendering would make the
// test fail on a reflow rather than on a behaviour change.
describe("buildTaskMasterPreamble — delegation clause", () => {
  const flatten = (text: string): string => text.replace(/\s+/g, " ");
  // A configured Delegate model; the worker's own model is unknown (the CLI's
  // default), so the clause shows whatever the tier comparison would say.
  const DELEGATION = { workerModel: null, delegateModel: "sonnet" };

  it("emits the CLI's own delegation sentence when the worker runs under a known agent", () => {
    const claude = flatten(
      buildTaskMasterPreamble({ ...BASE, agentCommand: "claude", delegation: DELEGATION }),
    );
    expect(claude).toContain("Task tool");

    const codex = flatten(
      buildTaskMasterPreamble({ ...BASE, agentCommand: "codex", delegation: DELEGATION }),
    );
    expect(codex).toContain("spawn_agent");

    const opencode = flatten(
      buildTaskMasterPreamble({ ...BASE, agentCommand: "opencode", delegation: DELEGATION }),
    );
    // v2's subagent tool: an `agent` (the subagent type) and, on 2.x, an
    // optional per-call `model` — not v1's `agents.<name>` config entries.
    // The row is hedged ("on 2.x", "where the tool offers one") because
    // Mullion only warns about a 1.x install rather than refusing it.
    expect(opencode).toContain("`agent`");
    expect(opencode).toContain("`model`");

    const agy = flatten(
      buildTaskMasterPreamble({ ...BASE, agentCommand: "agy", delegation: DELEGATION }),
    );
    expect(agy).toContain("invoke_subagent");
  });

  it("emits no delegation clause for a command with no agent adapter", () => {
    const out = buildTaskMasterPreamble({ ...BASE, agentCommand: "bash" });
    expect(out).not.toContain("delegate");
  });

  it("emits no delegation clause when no Delegate model is configured", () => {
    for (const delegation of [undefined, null, { workerModel: "opus", delegateModel: null }]) {
      const out = buildTaskMasterPreamble({ ...BASE, agentCommand: "claude", delegation });
      expect(out).not.toContain("delegate");
    }
  });

  it("emits no delegation clause when the delegate is not cheaper than the worker's model", () => {
    // opusplan is Sonnet at execution time, and a worker is never in plan mode.
    for (const workerModel of ["sonnet", "opusplan", "haiku"]) {
      const out = buildTaskMasterPreamble({
        ...BASE,
        agentCommand: "claude",
        delegation: { workerModel, delegateModel: "sonnet" },
      });
      expect(out).not.toContain("delegate");
    }
    const opus = buildTaskMasterPreamble({
      ...BASE,
      agentCommand: "claude",
      delegation: { workerModel: "opus", delegateModel: "sonnet" },
    });
    expect(flatten(opus)).toContain('model: "sonnet"');
  });

  it("emits no delegation clause when no command is supplied at all", () => {
    const out = buildTaskMasterPreamble(BASE);
    expect(out).not.toContain("delegate");
  });

  it("keeps the worker responsible for the final commit", () => {
    for (const agentCommand of ["claude", "codex", "opencode", "agy"]) {
      const out = flatten(
        buildTaskMasterPreamble({ ...BASE, agentCommand, delegation: DELEGATION }),
      );
      expect(out).toContain("responsible for the final commit");
    }
  });

  it("places the clause before the 'When you are done:' checklist", () => {
    const out = buildTaskMasterPreamble({
      ...BASE,
      agentCommand: "claude",
      delegation: DELEGATION,
    });
    expect(out.indexOf("delegate")).toBeLessThan(out.indexOf("When you are done:"));
  });

  it("wraps the clause rather than emitting one long line", () => {
    const out = buildTaskMasterPreamble({
      ...BASE,
      agentCommand: "claude",
      delegation: DELEGATION,
    });
    const lines = out.split("\n");
    const start = lines.findIndex((line) => line.includes("delegate"));
    const end = lines.findIndex((line) => line.includes("When you are done:"));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    // Every rendered line of the clause stays inside the wrap width — the
    // clause is one long sentence authored in the adapter, so without a wrap
    // it would read very differently from the hand-wrapped rest of the block.
    for (const line of lines.slice(start, end)) {
      expect(line.length).toBeLessThanOrEqual(78);
    }
  });
});

// The clause only exists if a spawn site threads `agentCommand` into the
// preamble. The two test files above exercise the builder and the lookup
// in isolation — a future call site that forgot the field would drop the
// clause silently, with the whole suite still green. So assert the WIRING:
// a real builder call, through the path a spawn actually takes.
describe("worker prompt wiring", () => {
  it("carries the clause through buildWorkerPrompt when a command is given", () => {
    const out = buildWorkerPrompt({
      ...BASE,
      mode: "claim",
      agentCommand: "claude",
      delegation: { workerModel: null, delegateModel: "sonnet" },
    });
    expect(out).toContain("Task tool");
  });

  it("omits the clause from a worker prompt with no command", () => {
    const out = buildWorkerPrompt({ ...BASE, mode: "claim" });
    expect(out).not.toContain("delegate");
  });
});

// Prompting-guide advice for unattended workers: finish the work, stay inside
// the issue's Scope, and run a real check (installing dependencies first).
describe("buildTaskMasterPreamble — unattended-worker guidance", () => {
  const flatten = (text: string): string => text.replace(/\s+/g, " ");

  it("tells the worker not to end its turn with work still owed", () => {
    const out = flatten(buildTaskMasterPreamble(BASE));
    expect(out).toContain("Ending your turn is final");
    expect(out).toContain("no offer to continue");
    expect(out).toContain("Ordinary obstacles");
    // A deliberate blocker is left alone and recorded, not worked past.
    expect(out).toContain("deliberately put there");
    // The existing rule against blocking on a question stays.
    expect(out).toContain("Never block on a question");
  });

  it("keeps the worker inside the issue's Scope", () => {
    const out = flatten(buildTaskMasterPreamble(BASE));
    expect(out).toContain("Do only what the issue's Scope");
    expect(out).toContain("(tests, a generated migration, a docs update) is part of the change");
  });

  it("asks for a real check, installing dependencies with the repo's own package manager", () => {
    const out = flatten(buildTaskMasterPreamble(BASE));
    expect(out).toContain("A fresh worktree has no installed dependencies");
    expect(out).toContain("never with sudo or the system package manager");
    expect(out).toContain("does not count as a check");
    expect(out).toContain("`Not run locally:`");
  });
});
