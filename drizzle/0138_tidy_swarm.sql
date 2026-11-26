ALTER TABLE `hosts` ADD `approved_at` integer;
--> statement-breakpoint
UPDATE `hosts` SET `approved_at` = `created_at` WHERE `approved_at` IS NULL;
