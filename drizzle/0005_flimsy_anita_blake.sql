CREATE TABLE `groups` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`color` text,
	`collapsed` integer DEFAULT false NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `workspaces` ADD `group_id` integer REFERENCES groups(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `workspaces` ADD `position` integer DEFAULT 0 NOT NULL;