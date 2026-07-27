ALTER TABLE `integrations` ADD `webhook_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `integrations` ADD `webhook_secret_enc` text;
