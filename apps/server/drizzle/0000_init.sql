CREATE TABLE `audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	CONSTRAINT "audit_action" CHECK("audit"."action" IN ('passkeys_reset'))
);
--> statement-breakpoint
CREATE INDEX `audit_subject` ON `audit` (`subject_id`);--> statement-breakpoint
CREATE TABLE `celebration` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`date` text NOT NULL,
	`place` text,
	`poster` text NOT NULL,
	`recurrence` text NOT NULL,
	`host_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`host_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "celebration_poster" CHECK("celebration"."poster" IN ('pine', 'berry', 'night', 'gold')),
	CONSTRAINT "celebration_recurrence" CHECK("celebration"."recurrence" IN ('none', 'yearly'))
);
--> statement-breakpoint
CREATE TABLE `celebration_person` (
	`celebration_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`celebration_id`, `person_id`),
	FOREIGN KEY (`celebration_id`) REFERENCES `celebration`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `celebration_person_person` ON `celebration_person` (`person_id`);--> statement-breakpoint
CREATE TABLE `invite` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`person_id` text,
	`token_hash` text NOT NULL,
	`created_by` text,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`used_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "invite_kind" CHECK("invite"."kind" IN ('setup', 'admin', 'self', 'recovery'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_token` ON `invite` (`token_hash`);--> statement-breakpoint
CREATE TABLE `manager` (
	`kid_id` text NOT NULL,
	`manager_id` text NOT NULL,
	PRIMARY KEY(`kid_id`, `manager_id`),
	FOREIGN KEY (`kid_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`manager_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "manager_not_self" CHECK("manager"."kid_id" <> "manager"."manager_id")
);
--> statement-breakpoint
CREATE TABLE `passkey` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`public_key` blob NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports_json` text DEFAULT '[]' NOT NULL,
	`backed_up` integer DEFAULT 0 NOT NULL,
	`label` text NOT NULL,
	`created_at` text NOT NULL,
	`last_used_at` text,
	`invited_by` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`invited_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `passkey_person` ON `passkey` (`person_id`);--> statement-breakpoint
CREATE TABLE `person` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT "person_role" CHECK("person"."role" IN ('admin', 'adult', 'kid'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_external_id` ON `person` (`external_id`);--> statement-breakpoint
CREATE TABLE `profile` (
	`person_id` text PRIMARY KEY NOT NULL,
	`sizes_json` text DEFAULT '[]' NOT NULL,
	`sizes_updated_at` text,
	`likes_json` text DEFAULT '[]' NOT NULL,
	`likes_updated_at` text,
	`please_no_json` text DEFAULT '[]' NOT NULL,
	`please_no_updated_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`passkey_id` text,
	`created_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`passkey_id`) REFERENCES `passkey`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `session_person` ON `session` (`person_id`);--> statement-breakpoint
CREATE TABLE `setting` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wish` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`celebration_id` text,
	`name` text NOT NULL,
	`link` text,
	`price_minor` integer,
	`quantity` integer DEFAULT 1 NOT NULL,
	`note` text,
	`most_wanted` integer DEFAULT 0 NOT NULL,
	`position` integer NOT NULL,
	`state` text NOT NULL,
	`added_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`celebration_id`) REFERENCES `celebration`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`added_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "wish_state" CHECK("wish"."state" IN ('listed', 'awaiting_parent', 'suggested')),
	CONSTRAINT "wish_quantity" CHECK("wish"."quantity" BETWEEN 1 AND 99),
	CONSTRAINT "wish_price" CHECK("wish"."price_minor" IS NULL OR "wish"."price_minor" >= 0)
);
--> statement-breakpoint
CREATE INDEX `wish_person` ON `wish` (`person_id`,`position`);--> statement-breakpoint
CREATE INDEX `wish_celebration` ON `wish` (`celebration_id`);