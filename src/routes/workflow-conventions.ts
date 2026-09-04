import type { FastifyInstance } from "fastify";
import {
  buildWorkflowConventionsText,
  WORKFLOW_CONVENTION_QUESTIONS,
} from "../services/workflow-conventions.js";

// Issue #937 — two small, read-only endpoints backing the Settings ->
// Sessions wizard. Deliberately NOT reusing routes/project-setup.ts's
// preview/apply worktree-diff machinery (computeScaffold's own preview
// route) — that infrastructure exists to diff a scaffold's generated FILES
// against a real repo's working tree, a materially different problem from
// this: buildWorkflowConventionsText is a pure in-memory string function
// with no filesystem/git involved at all, so a full preview-record +
// scratch-worktree + git-diff round trip would be pure overhead for it.
// Both endpoints are also intentionally side-effect-free with respect to
// settings: neither reads nor writes settings.sessions.workflowConventionsText
// itself (the existing PATCH /api/settings already owns that) — the
// wizard's "Generate" action is client-driven: call preview, show the
// result, then (on confirm) PATCH /api/settings with the returned text.
const previewSchema = {
  body: {
    type: "object",
    additionalProperties: false,
    properties: {
      answers: {
        type: "object",
        additionalProperties: { type: "string" },
      },
    },
  },
};

export async function workflowConventionsRoute(app: FastifyInstance) {
  // The fixed question/option set the wizard renders — kept server-side
  // (rather than duplicated into a frontend TS constant) so the frontend
  // never has to hand-copy WORKFLOW_CONVENTION_QUESTIONS and risk it
  // drifting from the actual assembly table buildWorkflowConventionsText
  // reads.
  app.get("/api/workflow-conventions/questions", async (_request, reply) => {
    reply.type("application/json");
    return { questions: WORKFLOW_CONVENTION_QUESTIONS };
  });

  // Pure computation, no I/O — `answers` is a scratch, client-held object
  // that never gets persisted here (unlike routes/project-setup.ts's
  // preview, there is no server-side preview record to expire/reuse: the
  // caller passes the same answers back next call if they want the same
  // text again).
  app.post<{ Body: { answers?: Record<string, string> } }>(
    "/api/workflow-conventions/preview",
    { schema: previewSchema },
    async (request, reply) => {
      reply.type("application/json");
      return { text: buildWorkflowConventionsText(request.body.answers ?? {}) };
    },
  );
}
