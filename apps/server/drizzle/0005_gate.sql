CREATE TABLE `passkey_reset` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`asked_by` text,
	`asked_at` text NOT NULL,
	`not_before` text,
	`done_at` text,
	`done_by` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`asked_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`done_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `passkey_reset_person` ON `passkey_reset` (`person_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	CONSTRAINT "audit_action" CHECK(action IN ('passkeys_reset', 'draw_created', 'draw_changed', 'drawn', 'redrawn', 'draw_refused', 'reveal_set', 'draw_removed', 'draw_moved', 'draw_cleared', 'question_removed', 'link_created', 'link_revoked', 'imported', 'reservation_released', 'link_opened', 'link_reissued', 'role_changed', 'invite_created', 'reset_asked', 'reset_cancelled', 'reset_confirmed'))
);
--> statement-breakpoint
INSERT INTO `__new_audit`("id", "at", "actor_id", "action", "subject_id") SELECT "id", "at", "actor_id", "action", "subject_id" FROM `audit`;--> statement-breakpoint
DROP TABLE `audit`;--> statement-breakpoint
ALTER TABLE `__new_audit` RENAME TO `audit`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_subject` ON `audit` (`subject_id`);--> statement-breakpoint
CREATE TABLE `__new_notice` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`about_id` text,
	`day` text NOT NULL,
	`read_at` text,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`about_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "notice_kind" CHECK("__new_notice"."kind" IN ('question', 'answered', 'draw', 'remind', 'reveal', 'say_thanks', 'thanked', 'reset_asked', 'signin_reset'))
);
--> statement-breakpoint
INSERT INTO `__new_notice`("id", "person_id", "kind", "subject_id", "about_id", "day", "read_at") SELECT "id", "person_id", "kind", "subject_id", "about_id", "day", "read_at" FROM `notice`;--> statement-breakpoint
DROP TABLE `notice`;--> statement-breakpoint
ALTER TABLE `__new_notice` RENAME TO `notice`;--> statement-breakpoint
CREATE INDEX `notice_person` ON `notice` (`person_id`,`day`);--> statement-breakpoint
ALTER TABLE `person` ADD `last_seen_at` text;--> statement-breakpoint
ALTER TABLE `person` ADD `admin_until` text;--> statement-breakpoint
ALTER TABLE `person` ADD `draws_sealed_at` text;