import { describe, it, expect } from "vitest";
import {
  SESSION_ID_PATTERN,
  SESSION_ID_SCHEMA,
  SESSION_ID_PARAMS_SCHEMA,
  spawnSessionSchema,
  liveStatusSchema,
  livenessSchema,
  terminateSchema,
  reviewGateSchema,
  gitWorktreeCreateSchema,
  gitWorktreeRemoveSchema,
  gitWorktreeCheckoutSchema,
  gitWorktreeForceRemoveSchema,
  gitWorktreeSyncSchema,
  gitWorktreeClearOrphanSchema,
  gitWorktreePruneSchema,
  gitBranchDeleteSchema,
  gitWorktreeRemoveListedSchema,
  gitWorktreePruneMetadataSchema,
  gitPushSchema,
  gitWorktreeResumeSchema,
  promoteDecisionSchema,
  writeDockConfigBodySchema,
  agentRuleWriteBodySchema,
  toggleSkillBodySchema,
} from "../../src/routes/internal-schemas.js";

// Regression guard for PR 17 of the refactoring roadmap (extracting
// internal.ts's hand-written JSON Schema literals into a shared
// schemaFor({required, optional}) builder over internal-schemas.ts). Every
// object below is a byte-for-byte transcription of what internal.ts
// literally contained before the extraction — this test exists to prove the
// builder emits the EXACT same shape, not an equivalent-looking one.
//
// This matters more than usual here because of a documented, non-obvious
// interaction: Fastify's ajv defaults to `removeAdditional: true`, which
// SILENTLY STRIPS an unknown property under `additionalProperties: false`
// instead of rejecting the request (see internal.ts's own comment on
// POST /internal/sessions). A builder bug that widens `additionalProperties`
// or drops a `required` entry would not throw — it would just silently
// accept/strip more than before, and only a shape-level diff like this one
// would catch it.
describe("internal-schemas.ts — byte-identical output regression guard", () => {
  it("SESSION_ID_SCHEMA / SESSION_ID_PATTERN / SESSION_ID_PARAMS_SCHEMA", () => {
    expect(SESSION_ID_PATTERN.source).toBe("^[A-Za-z0-9_-]+$");
    expect(SESSION_ID_SCHEMA).toEqual({
      type: "string",
      minLength: 1,
      pattern: "^[A-Za-z0-9_-]+$",
    });
    expect(SESSION_ID_PARAMS_SCHEMA).toEqual({
      type: "object",
      required: ["id"],
      properties: { id: SESSION_ID_SCHEMA },
    });
  });

  it("spawnSessionSchema", () => {
    expect(spawnSessionSchema).toEqual({
      body: {
        type: "object",
        required: ["id", "cwd", "command", "cols", "rows"],
        additionalProperties: false,
        properties: {
          id: SESSION_ID_SCHEMA,
          cwd: { type: "string", minLength: 1 },
          command: { type: "string", minLength: 1 },
          cols: { type: "integer", minimum: 1 },
          rows: { type: "integer", minimum: 1 },
          skipPermissions: { type: "boolean" },
          initialPrompt: { type: "string" },
          seedPrompt: { type: "string" },
          projectId: { type: "integer" },
          env: {
            type: "object",
            maxProperties: 16,
            additionalProperties: { type: "string", maxLength: 256 },
          },
          briefingOverride: { type: "string", maxLength: 8192 },
          // Issue #937 — see CreateSessionOptions.workflowConventionsText's
          // own doc comment (pty-manager.ts).
          workflowConventionsText: { type: "string", maxLength: 8192 },
          // PR-5 — see CreateSessionOptions.projectSkill/projectReviewerAgent's
          // own doc comments (pty-manager.ts).
          projectSkill: { type: "string", maxLength: 8192 },
          projectReviewerAgent: { type: "string", maxLength: 8192 },
          // Issue #884 — see CreateSessionOptions.injectAgentGuide/
          // injectProjectBriefing's own doc comments (pty-manager.ts).
          injectAgentGuide: { type: "boolean" },
          injectProjectBriefing: { type: "boolean" },
          // Issue #1089 — see CreateSessionOptions.injectMullionBundle's
          // own doc comment (pty-manager.ts).
          injectMullionBundle: { type: "boolean" },
          // Hermes review, PR #966 — Task Master marker, see
          // CreateSessionOptions.taskId's own doc comment (pty-manager.ts).
          taskId: { type: "integer" },
        },
      },
    });
  });

  it("liveStatusSchema", () => {
    expect(liveStatusSchema).toEqual({
      body: {
        type: "object",
        required: ["ids", "idleThresholdMs"],
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: SESSION_ID_SCHEMA },
          idleThresholdMs: { type: "integer", minimum: 0 },
          sessionProjectIds: {
            type: "object",
            additionalProperties: { type: "integer" },
          },
        },
      },
    });
  });

  it("livenessSchema", () => {
    expect(livenessSchema).toEqual({
      body: {
        type: "object",
        required: ["ids"],
        additionalProperties: false,
        properties: {
          ids: { type: "array", items: SESSION_ID_SCHEMA },
        },
      },
    });
  });

  it("terminateSchema", () => {
    expect(terminateSchema).toEqual({
      params: {
        type: "object",
        required: ["id"],
        properties: { id: SESSION_ID_SCHEMA },
      },
    });
  });

  it("reviewGateSchema", () => {
    expect(reviewGateSchema).toEqual({
      params: {
        type: "object",
        required: ["id"],
        properties: { id: SESSION_ID_SCHEMA },
      },
      body: {
        type: "object",
        required: ["decision"],
        additionalProperties: false,
        properties: {
          decision: { type: "string", enum: ["approved", "denied"] },
          reason: { type: "string" },
          gateId: { type: "string" },
        },
      },
    });
  });

  it("gitWorktreeCreateSchema", () => {
    expect(gitWorktreeCreateSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "baseRef", "seed"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          baseRef: { type: "string", minLength: 1 },
          seed: { type: "string", minLength: 1 },
          branchName: { type: "string" },
        },
      },
    });
  });

  it("gitWorktreeRemoveSchema", () => {
    expect(gitWorktreeRemoveSchema).toEqual({
      body: {
        type: "object",
        required: ["worktreePath"],
        additionalProperties: false,
        properties: {
          worktreePath: { type: "string", minLength: 1 },
          parentCwd: { type: "string" },
        },
      },
    });
  });

  it("gitWorktreeCheckoutSchema", () => {
    expect(gitWorktreeCheckoutSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "branch"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          branch: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("gitWorktreeForceRemoveSchema", () => {
    expect(gitWorktreeForceRemoveSchema).toEqual({
      body: {
        type: "object",
        required: ["worktreePath"],
        additionalProperties: false,
        properties: {
          worktreePath: { type: "string", minLength: 1 },
          parentCwd: { type: "string" },
        },
      },
    });
  });

  it("gitWorktreeSyncSchema", () => {
    expect(gitWorktreeSyncSchema).toEqual({
      body: {
        type: "object",
        required: ["worktreePath", "branch"],
        additionalProperties: false,
        properties: {
          worktreePath: { type: "string", minLength: 1 },
          branch: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("gitWorktreeClearOrphanSchema", () => {
    expect(gitWorktreeClearOrphanSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "worktreePath", "branchName"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          worktreePath: { type: "string", minLength: 1 },
          branchName: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("gitWorktreePruneSchema", () => {
    expect(gitWorktreePruneSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "orphanPaths"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          orphanPaths: {
            type: "array",
            items: { type: "string", minLength: 1 },
            maxItems: 200,
          },
        },
      },
    });
  });

  it("gitBranchDeleteSchema", () => {
    expect(gitBranchDeleteSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "name"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          name: { type: "string", minLength: 1 },
          force: { type: "boolean" },
        },
      },
    });
  });

  it("gitWorktreeRemoveListedSchema", () => {
    expect(gitWorktreeRemoveListedSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "worktreePath"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          worktreePath: { type: "string", minLength: 1 },
          force: { type: "boolean" },
        },
      },
    });
  });

  it("gitWorktreePruneMetadataSchema", () => {
    expect(gitWorktreePruneMetadataSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("gitPushSchema", () => {
    expect(gitPushSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "branch", "token"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          branch: { type: "string", minLength: 1 },
          token: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("gitWorktreeResumeSchema", () => {
    expect(gitWorktreeResumeSchema).toEqual({
      body: {
        type: "object",
        required: ["cwd", "branchName"],
        additionalProperties: false,
        properties: {
          cwd: { type: "string", minLength: 1 },
          branchName: { type: "string", minLength: 1 },
        },
      },
    });
  });

  it("promoteDecisionSchema", () => {
    expect(promoteDecisionSchema).toEqual({
      type: "object",
      required: ["decision"],
      properties: {
        decision: { type: "string", enum: ["accepted", "declined"] },
        worktreePath: { type: "string" },
        newSessionId: { type: "integer" },
        reason: { type: "string" },
      },
    });
  });

  it("writeDockConfigBodySchema", () => {
    expect(writeDockConfigBodySchema).toEqual({
      body: {
        type: "object",
        required: ["controls"],
        additionalProperties: false,
        properties: {
          controls: { type: "array", items: { type: "object" } },
        },
      },
    });
  });

  it("agentRuleWriteBodySchema", () => {
    expect(agentRuleWriteBodySchema).toEqual({
      body: {
        type: "object",
        required: ["content"],
        additionalProperties: false,
        properties: {
          content: { type: "string" },
        },
      },
    });
  });

  it("toggleSkillBodySchema", () => {
    expect(toggleSkillBodySchema).toEqual({
      body: {
        type: "object",
        required: ["agent", "name", "enabled"],
        additionalProperties: false,
        properties: {
          agent: { type: "string", enum: ["claude-code", "codex", "opencode", "agy"] },
          name: { type: "string", minLength: 1 },
          enabled: { type: "boolean" },
        },
      },
    });
  });
});
