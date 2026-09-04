CREATE TABLE IF NOT EXISTS `post_reactions` (
	`post_id` text NOT NULL,
	`author_public_key` text NOT NULL,
	`emoji` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`post_id`, `author_public_key`, `emoji`),
	FOREIGN KEY (`post_id`) REFERENCES `posts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `post_reactions_post_id` ON `post_reactions` (`post_id`);