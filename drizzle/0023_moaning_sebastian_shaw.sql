PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`issue_number` integer,
	`title` text NOT NULL,
	`body` text,
	`html_url` text,
	`status` text DEFAULT 'backlog' NOT NULL,
	`board_order` integer DEFAULT 0 NOT NULL,
	`session_id` integer,
	`review_session_id` integer,
	`worktree_path` text,
	`branch_name` text,
	`agent_command` text,
	`pr_url` text,
	`assignee` text,
	`failure_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`claimed_at` integer,
	`started_at` integer,
	`reviewing_at` integer,
	`completed_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`review_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
-- Hand-edited (Phase 6, 6.9/#233) — drizzle-kit's generated INSERT...SELECT
-- named every column of the NEW table (including ones that don't exist on
-- the pre-migration `tasks` table: board_order, review_session_id,
-- worktree_path, branch_name, agent_command, pr_url, assignee,
-- failure_reason, updated_at, started_at, reviewing_at, completed_at) as
-- double-quoted identifiers in the SELECT list. SQLite's double-quoted
-- string fallback (an identifier that doesn't resolve to a column is
-- silently treated as a string LITERAL, not an error — verified
-- empirically against a pre-migration-shaped tasks table) means the
-- original generated statement would NOT have failed: it would have
-- silently written the literal string 'board_order' into every existing
-- row's board_order column, 'worktree_path' into worktree_path, etc.,
-- corrupting every task on any install that had already run Phase 2.5's
-- thin slice. Rewritten to select only the columns that actually exist on
-- the old table, remap the status vocabulary inline (see below), and
-- supply updated_at explicitly since it's NOT NULL with no SQL-level
-- DEFAULT — every other new column is nullable (or board_order, which has
-- an explicit `DEFAULT 0` in the CREATE TABLE above) and is correctly left
-- out of the column list so it gets NULL/its default rather than a value.
--
-- Phase 6 (6.2/#215) — 'pending' splits into 'backlog' | 'ready'. Existing
-- rows map to 'backlog', NOT 'ready': 'ready' is the auto-claim poll
-- target, so mapping to it would make an upgrade start autonomous work
-- with no human action. 'claimed' passes through unchanged.
INSERT INTO `__new_tasks` (
	`id`, `project_id`, `issue_number`, `title`, `body`, `html_url`,
	`status`, `session_id`, `created_at`, `updated_at`, `claimed_at`
)
SELECT
	`id`, `project_id`, `issue_number`, `title`, `body`, `html_url`,
	CASE `status` WHEN 'pending' THEN 'backlog' ELSE `status` END,
	`session_id`, `created_at`, `created_at`, `claimed_at`
FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_project_id_issue_number_unique` ON `tasks` (`project_id`,`issue_number`);--> statement-breakpoint
ALTER TABLE `projects` ADD `default_agent` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `default_review_agent` text;
