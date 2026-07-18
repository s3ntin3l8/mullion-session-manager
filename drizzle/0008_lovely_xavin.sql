CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text,
	`auth_token_enc` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
-- Seed the "local" host every pre-#26 project backfills onto below. Hand-added:
-- drizzle-kit only emits schema DDL, never data. created_at is unix seconds
-- (this repo's `mode: "timestamp"` columns store seconds, not ms — see
-- SQLiteTimestamp.mapToDriverValue in drizzle-orm).
INSERT INTO `hosts` (`id`, `name`, `base_url`, `auth_token_enc`, `created_at`) VALUES ('local', 'Local', NULL, NULL, unixepoch());
--> statement-breakpoint
-- Hand-edited from drizzle-kit's generated output: SQLite refuses an
-- ALTER TABLE ... ADD COLUMN that combines a non-NULL DEFAULT with an inline
-- REFERENCES clause once `PRAGMA foreign_keys = ON` (src/db/client.ts sets
-- this on the same connection migrate() runs on) — "Cannot add a REFERENCES
-- column with non-NULL default value". The `hosts` FK relation stays declared
-- in src/db/schema.ts for typing/documentation; it just isn't enforced at the
-- SQLite level for this column, which is an acceptable trade-off since
-- host_id is always server-set (never user input) and "local" is guaranteed
-- to exist by the INSERT above.
ALTER TABLE `projects` ADD `host_id` text DEFAULT 'local' NOT NULL;
