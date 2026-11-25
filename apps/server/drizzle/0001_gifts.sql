CREATE TABLE `claim` (
	`id` text PRIMARY KEY NOT NULL,
	`wish_id` text NOT NULL,
	`giver_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`state` text NOT NULL,
	`celebration_id` text,
	`for_date` text,
	`given_on` text,
	`named` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`wish_id`) REFERENCES `wish`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`giver_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`celebration_id`) REFERENCES `celebration`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "claim_state" CHECK("claim"."state" IN ('claimed', 'bought', 'given')),
	CONSTRAINT "claim_quantity" CHECK("claim"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "claim_named" CHECK("claim"."named" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_wish_giver` ON `claim` (`wish_id`,`giver_id`);--> statement-breakpoint
CREATE INDEX `claim_giver` ON `claim` (`giver_id`);--> statement-breakpoint
CREATE TABLE `group_gift` (
	`wish_id` text PRIMARY KEY NOT NULL,
	`organizer_id` text,
	`target_minor` integer NOT NULL,
	`state` text NOT NULL,
	`celebration_id` text,
	`for_date` text,
	`given_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`wish_id`) REFERENCES `wish`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organizer_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`celebration_id`) REFERENCES `celebration`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "group_gift_state" CHECK("group_gift"."state" IN ('open', 'bought', 'given')),
	CONSTRAINT "group_gift_target" CHECK("group_gift"."target_minor" > 0)
);
--> statement-breakpoint
CREATE TABLE `share` (
	`wish_id` text NOT NULL,
	`giver_id` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`named` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`wish_id`, `giver_id`),
	FOREIGN KEY (`wish_id`) REFERENCES `group_gift`(`wish_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`giver_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "share_amount" CHECK("share"."amount_minor" > 0),
	CONSTRAINT "share_named" CHECK("share"."named" IN (0, 1))
);
--> statement-breakpoint
CREATE INDEX `share_giver` ON `share` (`giver_id`);