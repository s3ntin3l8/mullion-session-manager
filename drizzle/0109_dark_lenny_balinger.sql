CREATE TABLE `pending_browser_closes` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`host_id` text NOT NULL,
	`checkout_root` text NOT NULL,
	`endpoint` text DEFAULT '' NOT NULL,
	`legacy` integer DEFAULT false NOT NULL,
	`forget` integer DEFAULT false NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`next_attempt_at` integer NOT NULL,
	`gave_up_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pending_browser_closes_target_unique` ON `pending_browser_closes` (`project_id`,`host_id`,`checkout_root`,`endpoint`);
