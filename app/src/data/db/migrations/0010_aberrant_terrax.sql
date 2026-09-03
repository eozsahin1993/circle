ALTER TABLE `circle_members` ADD `x25519_public_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `circles` ADD `sync_id` text NOT NULL;--> statement-breakpoint
ALTER TABLE `circles` ADD `meta_cursor` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `circles` ADD `content_cursor` integer DEFAULT 0 NOT NULL;