CREATE TABLE `setup_stamps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`host_id` text NOT NULL,
	`cwd` text NOT NULL,
	`lockfile_hash` text NOT NULL,
	`ran_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `setup_stamps_checkout_idx` ON `setup_stamps` (`project_id`,`host_id`,`cwd`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `setup_hint` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_output` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `last_exit_code` integer;