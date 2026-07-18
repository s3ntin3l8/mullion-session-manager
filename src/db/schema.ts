import { sqliteTable, text, integer, uniqueIndex } from "drizzle-orm/sqlite-core";

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

// A host a project's files (and therefore its sessions) live on — see issue
// #26. `id` is a stable slug ("local" is seeded by the migration and is the
// only host a `local`-role backend serves in-process; every other row is a
// remote agent reached over HTTP/WS via src/services/remote-host-client.ts).
// `baseUrl`/`authTokenEnc` are null for "local". The token is encrypted at
// rest via EncryptionService (same as `users.notes`) when DB_ENCRYPTION_KEY
// is set — see src/services/host-registry.ts.
export const hosts = sqliteTable("hosts", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  baseUrl: text("base_url"),
  authTokenEnc: text("auth_token_enc"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A project is just a folder new sessions get created in — now on a specific
// host (issue #26). Every session under a project inherits its host; a
// session has no hostId of its own since a project can't change host (cwd is
// host-specific) and denormalizing here would only add drift risk. Defaults
// to the seeded "local" host so every pre-#26 row backfills unambiguously —
// see the migration for why this FK isn't enforced at the SQLite level.
export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  cwd: text("cwd").notNull(),
  hostId: text("host_id")
    .notNull()
    .default("local")
    .references(() => hosts.id),
  // Where this project's dev server listens — issue #28. A bare port
  // ("5173") or a full "scheme://host:port" URL; the preview proxy
  // (src/plugins/preview-proxy.ts) parses this to find the upstream. For a
  // remote-hosted project only the port (+ path) is meaningful — the host is
  // always forced to that agent's own loopback, never caller-supplied (see
  // the plan's loopback-only two-hop boundary). Nullable: most projects have
  // no dev server, or haven't configured one yet.
  devServerUrl: text("dev_server_url"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A slug->target registry for the subdomain preview proxy (issue #28). Each
// row maps an opaque, random `slug` (the "preview-<slug>" subdomain label —
// never a decodable/encoded target, which would be an SSRF amplifier) to
// either a project's dev server or an arbitrary external URL. `kind:
// "project"` upserts one row per `projectId` (the unique index below
// enforces this — SQLite treats multiple NULL `projectId`s as distinct, so
// it only constrains the "project" rows, never "external" ones);
// `kind: "external"` gets one row per registered URL. See
// src/routes/previews.ts and src/plugins/preview-proxy.ts.
export const previews = sqliteTable(
  "previews",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    slug: text("slug").notNull().unique(),
    kind: text("kind", { enum: ["project", "external"] }).notNull(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "cascade" }),
    externalUrl: text("external_url"),
    createdAt: integer("created_at", { mode: "timestamp" })
      .notNull()
      .$defaultFn(() => new Date()),
  },
  (table) => [uniqueIndex("previews_project_id_unique").on(table.projectId)],
);

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

// A single-row table holding the whole Settings-modal preferences blob as
// opaque JSON (see src/services/settings.ts for the actual shape/defaults) —
// same "backend stores/replays an opaque value" philosophy as
// `workspaces.layout`. Singleton by convention (id is always 1); a settings
// row simply doesn't exist until the first PATCH, at which point
// src/routes/settings.ts upserts it.
export const settings = sqliteTable("settings", {
  id: integer("id").primaryKey(),
  data: text("data").notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
});

// A single credential per external provider (today: just "github") — issue
// #27. `provider` is the primary key rather than an autoincrement id since
// there's exactly one account connected at a time (device flow yields one
// user token; per-project tokens would need a different shape entirely).
// `authTokenEnc` is encrypted at rest via EncryptionService (same convention
// as `hosts.authTokenEnc`/`users.notes`) when DB_ENCRYPTION_KEY is set — see
// src/services/github-integration.ts. `login`/`scopes` are cached from the
// token-validation response purely for display (Settings -> Integrations);
// never treat them as authoritative for authorization decisions.
export const integrations = sqliteTable("integrations", {
  provider: text("provider").primaryKey(),
  authTokenEnc: text("auth_token_enc"),
  tokenType: text("token_type", { enum: ["pat", "oauth"] }),
  login: text("login"),
  scopes: text("scopes"),
  connectedAt: integer("connected_at", { mode: "timestamp" }),
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
