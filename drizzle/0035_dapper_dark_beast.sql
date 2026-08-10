ALTER TABLE `tasks` ADD `review_findings` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `review_rounds` integer DEFAULT 0 NOT NULL;
