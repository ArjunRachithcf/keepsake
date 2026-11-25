CREATE TABLE `guest_link` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`person_id` text,
	`celebration_id` text,
	`label` text NOT NULL,
	`guest_name` text,
	`token_hash` text NOT NULL,
	`created_by` text,
	`approved_at` text,
	`created_at` text NOT NULL,
	`revoked_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`celebration_id`) REFERENCES `celebration`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "guest_link_kind" CHECK("guest_link"."kind" IN ('share', 'draw')),
	CONSTRAINT "guest_link_target" CHECK(("guest_link"."kind" = 'share' AND "guest_link"."person_id" IS NOT NULL AND "guest_link"."celebration_id" IS NULL) OR ("guest_link"."kind" = 'draw' AND "guest_link"."celebration_id" IS NOT NULL AND "guest_link"."person_id" IS NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `guest_link_token` ON `guest_link` (`token_hash`);--> statement-breakpoint
CREATE INDEX `guest_link_person` ON `guest_link` (`person_id`);--> statement-breakpoint
CREATE INDEX `guest_link_celebration` ON `guest_link` (`celebration_id`);--> statement-breakpoint
CREATE TABLE `guest_session` (
	`id` text PRIMARY KEY NOT NULL,
	`link_id` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	FOREIGN KEY (`link_id`) REFERENCES `guest_link`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `guest_session_link` ON `guest_session` (`link_id`);--> statement-breakpoint
CREATE TABLE `idea` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`author_id` text,
	`text` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`author_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idea_person` ON `idea` (`person_id`);--> statement-breakpoint
CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`asker_id` text,
	`asker_guest_id` text,
	`text` text NOT NULL,
	`asked_at` text NOT NULL,
	`deliver_at` text NOT NULL,
	`state` text NOT NULL,
	`answer` text,
	`answer_wish_id` text,
	`answered_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asker_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`asker_guest_id`) REFERENCES `guest_link`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`answer_wish_id`) REFERENCES `wish`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "question_state" CHECK("question"."state" IN ('open', 'answered', 'declined')),
	CONSTRAINT "question_one_asker" CHECK("question"."asker_id" IS NULL OR "question"."asker_guest_id" IS NULL)
);
--> statement-breakpoint
CREATE INDEX `question_person` ON `question` (`person_id`,`deliver_at`);--> statement-breakpoint
CREATE INDEX `question_asker` ON `question` (`asker_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	CONSTRAINT "audit_action" CHECK(action IN ('passkeys_reset', 'draw_created', 'draw_changed', 'drawn', 'redrawn', 'draw_refused', 'reveal_set', 'draw_removed', 'draw_moved', 'draw_cleared', 'question_removed', 'link_created', 'link_revoked', 'imported', 'reservation_released'))
);
--> statement-breakpoint
INSERT INTO `__new_audit`("id", "at", "actor_id", "action", "subject_id") SELECT "id", "at", "actor_id", "action", "subject_id" FROM `audit`;--> statement-breakpoint
DROP TABLE `audit`;--> statement-breakpoint
ALTER TABLE `__new_audit` RENAME TO `audit`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_subject` ON `audit` (`subject_id`);--> statement-breakpoint
ALTER TABLE `claim` ADD `guest_id` text REFERENCES `guest_link`(`id`) ON UPDATE no action ON DELETE set null;--> statement-breakpoint
ALTER TABLE `claim` ADD `imported` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `claim_wish_guest` ON `claim` (`wish_id`,`guest_id`);--> statement-breakpoint
ALTER TABLE `draw_participant` ADD `guest_id` text REFERENCES `guest_link`(`id`) ON UPDATE no action ON DELETE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX `draw_participant_guest` ON `draw_participant` (`draw_id`,`guest_id`);