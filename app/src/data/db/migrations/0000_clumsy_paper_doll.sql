CREATE TABLE IF NOT EXISTS `circles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`picture` blob,
	`sync_id` text DEFAULT '' NOT NULL,
	`created_at` integer NOT NULL,
	`left_at` integer,
	`meta_cursor` integer DEFAULT 0 NOT NULL,
	`content_cursor` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `circle_members` (
	`circle_id` text NOT NULL,
	`identity_public_key` text NOT NULL,
	`enc_public_key` text DEFAULT '' NOT NULL,
	`member_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`name` text NOT NULL,
	`picture` blob,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`circle_id`, `identity_public_key`),
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `circle_members_member_id` ON `circle_members` (`circle_id`,`member_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `device_profile` (
	`id` integer PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`picture` blob,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "device_profile_id_check" CHECK("device_profile"."id" = 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `posts` (
	`id` text PRIMARY KEY NOT NULL,
	`circle_id` text NOT NULL,
	`caption` text NOT NULL,
	`author_public_key` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `posts_circle_id` ON `posts` (`circle_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `attachments` (
	`circle_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`kind` text NOT NULL,
	`bytes` blob,
	`hash` text NOT NULL,
	`key_version` integer NOT NULL,
	`status` text NOT NULL,
	`fetch_attempts` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`circle_id`, `entry_id`),
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `attachments_circle_id` ON `attachments` (`circle_id`);
