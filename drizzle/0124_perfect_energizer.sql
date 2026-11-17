ALTER TABLE `hosts` ADD `last_seen_at` integer;
--> statement-breakpoint
UPDATE `hosts` SET `last_seen_at` = unixepoch() WHERE `id` <> 'local' AND `last_seen_at` IS NULL;
