CREATE TABLE `browser_cookies` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`project_id` integer NOT NULL,
	`label` text NOT NULL,
	`browser` text NOT NULL,
	`cookies_enc` text NOT NULL,
	`cookie_count` integer DEFAULT 0 NOT NULL,
	`imported_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `browser_cookies_project_id_label_unique` ON `browser_cookies` (`project_id`,`label`);
