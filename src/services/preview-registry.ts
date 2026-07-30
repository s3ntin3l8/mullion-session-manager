import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { previews, projects } from "../db/schema.js";
import type { getDb } from "../db/client.js";

// Never a decodable/encoded target (see schema.ts) — an opaque random slug,
// used verbatim as the "preview-<slug>" DNS label. crypto.randomUUID()'s
// 36-char hex+hyphen form fits well inside the 63-char DNS-label limit and
// never starts/ends with a hyphen, so it's always a valid label as-is —
// same generator host-registry.ts already uses for host ids.
function newSlug(): string {
  return crypto.randomUUID();
}

export interface PreviewSummary {
  slug: string;
  kind: "project" | "external";
  projectId: number | null;
  externalUrl: string | null;
  createdAt: Date;
}

type PreviewRow = typeof previews.$inferSelect;

function toSummary(row: PreviewRow): PreviewSummary {
  return {
    slug: row.slug,
    kind: row.kind,
    projectId: row.projectId,
    externalUrl: row.externalUrl,
    createdAt: row.createdAt,
  };
}

export class UnknownProjectError extends Error {
  constructor(projectId: number) {
    super(`Unknown project ${projectId}`);
    this.name = "UnknownProjectError";
  }
}

/**
 * Idempotent by projectId: a project has at most one "project"-kind preview
 * row (the `previews_project_id_unique` index in schema.ts enforces this),
 * so re-opening the same project's browser pane reuses its existing slug —
 * and therefore its existing "preview-<slug>" subdomain — rather than
 * minting a fresh one on every open.
 */
export function getOrCreateProjectPreview(app: FastifyInstance, projectId: number): PreviewSummary {
  const [project] = app.db.select().from(projects).where(eq(projects.id, projectId)).all();
  if (!project) throw new UnknownProjectError(projectId);

  // An upsert, not select-then-insert: two concurrent opens of the same
  // brand-new project's browser pane must not race the
  // previews_project_id_unique index — select-then-insert lets both sides
  // miss the not-yet-existing row and then have the loser's insert throw
  // (PR #43 review). onConflictDoNothing makes the losing insert a no-op
  // instead, so the select below always finds a row afterward regardless of
  // which side actually created it.
  app.db
    .insert(previews)
    .values({ slug: newSlug(), kind: "project", projectId })
    .onConflictDoNothing({ target: previews.projectId })
    .run();

  const [row] = app.db
    .select()
    .from(previews)
    .where(and(eq(previews.kind, "project"), eq(previews.projectId, projectId)))
    .all();
  return toSummary(row);
}

// One row per registered URL (see schema.ts) — unlike the project case above,
// re-submitting the same URL isn't deduplicated, since there's no natural
// unique key for "external" rows to upsert against (the same URL could
// legitimately back two independent panes with independent lifecycles).
export function createExternalPreview(app: FastifyInstance, url: string): PreviewSummary {
  const [created] = app.db
    .insert(previews)
    .values({ slug: newSlug(), kind: "external", externalUrl: url })
    .returning()
    .all();
  return toSummary(created);
}

export function getPreviewBySlug(app: FastifyInstance, slug: string): PreviewSummary | undefined {
  const [row] = app.db.select().from(previews).where(eq(previews.slug, slug)).all();
  return row ? toSummary(row) : undefined;
}

export function deletePreviewBySlug(app: FastifyInstance, slug: string): boolean {
  const deleted = app.db.delete(previews).where(eq(previews.slug, slug)).returning().all();
  return deleted.length > 0;
}

// Previews are host-global (no session/user scoping column exists on the
// table — see schema.ts), so this lists every preview registered on the
// host, newest first.
export function listPreviews(db: ReturnType<typeof getDb>): PreviewSummary[] {
  const rows = db.select().from(previews).orderBy(desc(previews.createdAt)).all();
  return rows.map(toSummary);
}
