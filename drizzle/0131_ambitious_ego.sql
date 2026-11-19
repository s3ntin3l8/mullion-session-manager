-- IF NOT EXISTS, by hand: this table first shipped on the feat-tasks-mode branch as
-- 0123_redundant_blizzard, which collided with main's 0123 and was renumbered when
-- main was merged in. A database that ran the branch before that already has the
-- table and its indexes, and must pass over this migration instead of failing on it.
CREATE TABLE IF NOT EXISTS `workspace_pending_opens` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`workspace_id` integer NOT NULL,
	`session_id` integer NOT NULL,
	`reference_session_id` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`reference_session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `workspace_pending_opens_workspace_session_unique` ON `workspace_pending_opens` (`workspace_id`,`session_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `workspace_pending_opens_session_idx` ON `workspace_pending_opens` (`session_id`);