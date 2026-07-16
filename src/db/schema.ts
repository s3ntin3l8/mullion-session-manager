import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  // Stored encrypted at rest via EncryptionService when DB_ENCRYPTION_KEY is set.
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A project is just a folder new sessions get created in.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  cwd: text("cwd").notNull(),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// One row per terminal session. `status` records user intent (has this been
// explicitly killed?), not live process state — whether a session's dtach
// attach-client is actually running right now is only known by PtyManager,
// in-memory, in whichever Node process currently holds it; routes merge the
// two rather than trusting this column alone for "is it alive."
export const sessions = sqliteTable("sessions", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  projectId: integer("project_id")
    .notNull()
    .references(() => projects.id, { onDelete: "cascade" }),
  // Cosmetic label the user can rename; falls back to `command` when unset.
  name: text("name"),
  // Shell command line to run, e.g. "claude", "codex", "bash" — see the
  // plan's CLI-agnostic design; PtyManager treats this as an opaque string.
  command: text("command").notNull(),
  // Optional override of the parent project's cwd — lets a launcher/action
  // (src/services/project-config.ts) or dock control target a subdirectory
  // (e.g. a monorepo package) without needing its own project row. Falls
  // back to the parent project's cwd when unset (see sessions.ts).
  cwd: text("cwd"),
  // "dock" sessions are spawned from a project's dock controls (persistent
  // monitors — dev server, git status, logs; see project-config.ts's
  // resolveProjectDock) rather than a one-shot launcher/manual "+ Session."
  // Kept in the same table (same PtyManager lifecycle either way) but
  // discriminated so the redesign can render them in a separate dock region
  // instead of the normal per-project session inventory.
  kind: text("kind", { enum: ["terminal", "dock"] })
    .notNull()
    .default("terminal"),
  // "exited" (distinct from the user-initiated "killed") means the program
  // ended on its own — user typed `exit`, the process crashed — and was
  // caught by the reconciler in session-reconciler.ts rather than an
  // explicit DELETE /api/sessions/:id. Fixes the M2-era gap where such a
  // session left a stale dtach socket with status still "active" forever,
  // so the next getOrCreate() would silently bootstrap a fresh program
  // under the same id.
  status: text("status", { enum: ["active", "killed", "exited"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastAttachedAt: integer("last_attached_at", { mode: "timestamp" }),
});

// A collapsible named sidebar section that workspaces can optionally belong
// to — vision item #4 (cmux workspace groups). Deliberately simpler than
// cmux's own model: no "anchor workspace" owning the group header, just a
// plain container a workspace references by id. Orthogonal to `projects`
// (which group *sessions* by folder) — see the plan for why these two
// grouping axes are intentionally separate.
export const groups = sqliteTable("groups", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  icon: text("icon"),
  color: text("color"),
  collapsed: integer("collapsed", { mode: "boolean" }).notNull().default(false),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A workspace is a named, saved dockview layout — the cmux-style "tab" that
// groups a whole split arrangement of terminals, not a single terminal. The
// backend treats `layout` as an opaque JSON blob (dockview's own
// api.toJSON()/fromJSON() shape, including each panel's params.sessionId) —
// same philosophy as `sessions.command` being an opaque string. Nullable
// because a freshly created workspace has no layout yet (empty dockview grid).
export const workspaces = sqliteTable("workspaces", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  layout: text("layout"),
  // Nullable: an ungrouped workspace is the common case. `set null` on
  // delete so removing a group leaves its former members ungrouped rather
  // than deleting them — a group is pure view metadata, same philosophy as
  // this table's own hard-delete (see workspaces.ts).
  groupId: integer("group_id").references(() => groups.id, { onDelete: "set null" }),
  position: integer("position").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});
