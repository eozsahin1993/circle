ALTER TABLE `circles` ADD `last_viewed_at` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `posts` ADD `last_viewed_at` integer;--> statement-breakpoint
UPDATE `circles` SET `last_viewed_at` = (unixepoch() * 1000) WHERE `last_viewed_at` = 0;--> statement-breakpoint
UPDATE `posts` SET `last_viewed_at` = (unixepoch() * 1000) WHERE `last_viewed_at` IS NULL;