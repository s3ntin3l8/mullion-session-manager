ALTER TABLE `hosts` ADD `session_id_enc` text;--> statement-breakpoint
ALTER TABLE `hosts` ADD `session_secret_enc` text;--> statement-breakpoint
ALTER TABLE `hosts` ADD `session_expires_at` integer;--> statement-breakpoint
ALTER TABLE `hosts` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `hosts` ADD `agent_metadata` text;
