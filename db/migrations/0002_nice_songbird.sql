PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_run` (
	`id` text PRIMARY KEY NOT NULL,
	`env_label` text NOT NULL,
	`status` text NOT NULL,
	`queued_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`triggered_by` text NOT NULL,
	`scope` text,
	`artifact_dir` text
);
--> statement-breakpoint
INSERT INTO `__new_run`("id", "env_label", "status", "queued_at", "started_at", "finished_at", "triggered_by", "scope", "artifact_dir") SELECT "id", "env_label", "status", "queued_at", "started_at", "finished_at", "triggered_by", "scope", "artifact_dir" FROM `run`;--> statement-breakpoint
DROP TABLE `run`;--> statement-breakpoint
ALTER TABLE `__new_run` RENAME TO `run`;--> statement-breakpoint
PRAGMA foreign_keys=ON;