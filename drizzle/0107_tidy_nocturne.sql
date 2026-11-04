ALTER TABLE `host_pairings` ADD `code_hash` text;--> statement-breakpoint
ALTER TABLE `host_pairings` DROP COLUMN `code_enc`;--> statement-breakpoint
ALTER TABLE `hosts` ADD `channel_first_connected_at` integer;
