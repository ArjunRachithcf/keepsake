CREATE TABLE `job_run` (
	`name` text NOT NULL,
	`day` text NOT NULL,
	`at` text NOT NULL,
	PRIMARY KEY(`name`, `day`)
);
--> statement-breakpoint
CREATE TABLE `notice` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`about_id` text,
	`day` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`about_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notice_kind" CHECK("notice"."kind" IN ('question', 'answered', 'draw', 'remind', 'reveal', 'say_thanks', 'thanked'))
);
--> statement-breakpoint
CREATE INDEX `notice_person` ON `notice` (`person_id`,`day`);--> statement-breakpoint
CREATE TABLE `pending_notice` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`day` text NOT NULL,
	`again` integer DEFAULT 0 NOT NULL,
	`people` text,
	`created_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`next_at` text
);
--> statement-breakpoint
CREATE TABLE `pending_push` (
	`person_id` text PRIMARY KEY NOT NULL,
	`since` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `push_subscription` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`session_id` text,
	`endpoint` text NOT NULL,
	`p256dh` text NOT NULL,
	`auth` text NOT NULL,
	`created_at` text NOT NULL,
	`confirmed_at` text NOT NULL,
	`failing_since` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`session_id`) REFERENCES `session`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `push_subscription_person` ON `push_subscription` (`person_id`);--> statement-breakpoint
CREATE TABLE `reminder` (
	`person_id` text NOT NULL,
	`about_id` text NOT NULL,
	`days` integer NOT NULL,
	PRIMARY KEY(`person_id`, `about_id`),
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`about_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "reminder_days" CHECK("reminder"."days" BETWEEN 1 AND 60),
	CONSTRAINT "reminder_not_self" CHECK("reminder"."person_id" <> "reminder"."about_id")
);
--> statement-breakpoint
CREATE TABLE `thank_you` (
	`id` text PRIMARY KEY NOT NULL,
	`wish_id` text NOT NULL,
	`written_by` text,
	`text` text NOT NULL,
	`day` text NOT NULL,
	FOREIGN KEY (`wish_id`) REFERENCES `wish`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`written_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `thank_you_wish` ON `thank_you` (`wish_id`);