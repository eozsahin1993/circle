CREATE TABLE IF NOT EXISTS `circle_members` (
	`circle_id` text NOT NULL,
	`public_key` text NOT NULL,
	`member_id` text NOT NULL,
	`name` text NOT NULL,
	`picture` blob,
	`joined_at` integer NOT NULL,
	PRIMARY KEY(`circle_id`, `public_key`),
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `circle_members_member_id` ON `circle_members` (`circle_id`,`member_id`);--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `circles` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
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
	`photo` blob NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`circle_id`) REFERENCES `circles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `posts_circle_id` ON `posts` (`circle_id`);