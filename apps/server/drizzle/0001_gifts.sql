CREATE TABLE `claim` (
	`id` text PRIMARY KEY NOT NULL,
	`wish_id` text NOT NULL,
	`giver_id` text,
	`quantity` integer NOT NULL,
	`state` text NOT NULL,
	`given_on` text,
	`occasion_on` text,
	`revealed_on` text,
	`named` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`wish_id`) REFERENCES `wish`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`giver_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "claim_state" CHECK("claim"."state" IN ('claimed', 'bought', 'given')),
	CONSTRAINT "claim_quantity" CHECK("claim"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "claim_named" CHECK("claim"."named" IN (0, 1)),
	CONSTRAINT "claim_given" CHECK(("claim"."state" = 'given') = ("claim"."given_on" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claim_wish_giver` ON `claim` (`wish_id`,`giver_id`);--> statement-breakpoint
CREATE INDEX `claim_giver` ON `claim` (`giver_id`);--> statement-breakpoint
CREATE TABLE `group_gift` (
	`wish_id` text PRIMARY KEY NOT NULL,
	`organizer_id` text,
	`target_minor` integer NOT NULL,
	`state` text NOT NULL,
	`given_on` text,
	`occasion_on` text,
	`revealed_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`wish_id`) REFERENCES `wish`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`organizer_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "group_gift_state" CHECK("group_gift"."state" IN ('open', 'bought', 'given')),
	CONSTRAINT "group_gift_target" CHECK("group_gift"."target_minor" BETWEEN 1 AND 100000000),
	CONSTRAINT "group_gift_given" CHECK(("group_gift"."state" = 'given') = ("group_gift"."given_on" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE `share` (
	`id` text PRIMARY KEY NOT NULL,
	`wish_id` text NOT NULL,
	`giver_id` text,
	`amount_minor` integer NOT NULL,
	`named` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`wish_id`) REFERENCES `group_gift`(`wish_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`giver_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "share_amount" CHECK("share"."amount_minor" BETWEEN 1 AND 100000000),
	CONSTRAINT "share_named" CHECK("share"."named" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `share_wish_giver` ON `share` (`wish_id`,`giver_id`);--> statement-breakpoint
CREATE INDEX `share_giver` ON `share` (`giver_id`);--> statement-breakpoint
ALTER TABLE `wish` ADD `was_for` text REFERENCES celebration(id) ON UPDATE no action ON DELETE set null;