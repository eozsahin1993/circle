ALTER TABLE `circle_members` RENAME COLUMN `public_key` TO `identity_public_key`;--> statement-breakpoint
ALTER TABLE `circle_members` RENAME COLUMN `x25519_public_key` TO `enc_public_key`;