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
  status: text("status", { enum: ["active", "killed"] })
    .notNull()
    .default("active"),
  createdAt: integer("created_at", { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date()),
  lastAttachedAt: integer("last_attached_at", { mode: "timestamp" }),
});