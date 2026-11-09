ALTER TABLE `sessions` ADD `task_id` integer;--> statement-breakpoint
CREATE INDEX `sessions_task_id_idx` ON `sessions` (`task_id`);
