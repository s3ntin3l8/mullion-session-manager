CREATE TABLE `code_scanning_dismissals` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`task_id` integer NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`alert_number` integer NOT NULL,
	`rule_id` text NOT NULL,
	`path` text,
	`reason` text NOT NULL,
	`comment` text NOT NULL,
	`dismissed_by` text,
	`thread_resolved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `code_scanning_dismissals_task_idx` ON `code_scanning_dismissals` (`task_id`);--> statement-breakpoint
CREATE INDEX `code_scanning_dismissals_rule_idx` ON `code_scanning_dismissals` (`repo`,`rule_id`);
