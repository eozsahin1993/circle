ALTER TABLE `circle_members` ADD `authority_public_key` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `circle_members` ADD `authority_registered` integer DEFAULT false NOT NULL;