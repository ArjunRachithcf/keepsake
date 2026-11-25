CREATE TABLE `draw` (
	`id` text PRIMARY KEY NOT NULL,
	`celebration_id` text NOT NULL,
	`year` integer NOT NULL,
	`rules_version` integer NOT NULL,
	`budget_minor` integer,
	`kids_draw` integer DEFAULT 0 NOT NULL,
	`not_last_year` integer DEFAULT 0 NOT NULL,
	`draw_together_at` text,
	`reveal_on` text,
	`drawn_at` text,
	`redrawn_at` text,
	`created_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`celebration_id`) REFERENCES `celebration`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE set null,
	CONSTRAINT "draw_budget" CHECK("draw"."budget_minor" IS NULL OR "draw"."budget_minor" BETWEEN 1 AND 100000000),
	CONSTRAINT "draw_flags" CHECK("draw"."kids_draw" IN (0, 1) AND "draw"."not_last_year" IN (0, 1))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_celebration_year` ON `draw` (`celebration_id`,`year`);--> statement-breakpoint
CREATE TABLE `draw_assignment` (
	`draw_id` text NOT NULL,
	`giver_id` text NOT NULL,
	`sealed` blob NOT NULL,
	`key_id` text NOT NULL,
	PRIMARY KEY(`draw_id`, `giver_id`),
	FOREIGN KEY (`draw_id`) REFERENCES `draw`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`giver_id`) REFERENCES `draw_participant`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `draw_exclusion` (
	`draw_id` text NOT NULL,
	`a` text NOT NULL,
	`b` text NOT NULL,
	PRIMARY KEY(`draw_id`, `a`, `b`),
	FOREIGN KEY (`draw_id`) REFERENCES `draw`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`a`) REFERENCES `draw_participant`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`b`) REFERENCES `draw_participant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "draw_exclusion_order" CHECK("draw_exclusion"."a" < "draw_exclusion"."b")
);
--> statement-breakpoint
CREATE TABLE `draw_participant` (
	`id` text PRIMARY KEY NOT NULL,
	`draw_id` text NOT NULL,
	`kind` text NOT NULL,
	`person_id` text,
	`opened_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`draw_id`) REFERENCES `draw`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `person`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "draw_participant_kind" CHECK("draw_participant"."kind" IN ('person', 'guest')),
	CONSTRAINT "draw_participant_has_person" CHECK("draw_participant"."kind" <> 'person' OR "draw_participant"."person_id" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `draw_participant_person` ON `draw_participant` (`draw_id`,`person_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`subject_id` text NOT NULL,
	CONSTRAINT "audit_action" CHECK(action IN ('passkeys_reset', 'draw_created', 'draw_changed', 'drawn', 'redrawn', 'draw_refused', 'reveal_set', 'draw_removed'))
);
--> statement-breakpoint
INSERT INTO `__new_audit`("id", "at", "actor_id", "action", "subject_id") SELECT "id", "at", "actor_id", "action", "subject_id" FROM `audit`;--> statement-breakpoint
DROP TABLE `audit`;--> statement-breakpoint
ALTER TABLE `__new_audit` RENAME TO `audit`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `audit_subject` ON `audit` (`subject_id`);