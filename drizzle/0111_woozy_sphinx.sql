ALTER TABLE `tasks` ADD `rebase_spawn_head_sha` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rebase_aborted_attempts` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `suggestions_rapid_exits` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rapid_exit_retry_after` integer;--> statement-breakpoint
ALTER TABLE `tasks` ADD `suggestions_seed_prompt` text;
