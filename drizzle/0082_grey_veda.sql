ALTER TABLE `sessions` ADD `worktree_branch` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `worktree_repo_cwd` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `worktree_reclaimed_at` integer;--> statement-breakpoint
ALTER TABLE `sessions` ADD `worktree_kept_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `worktree_last_attempt_at` integer;
