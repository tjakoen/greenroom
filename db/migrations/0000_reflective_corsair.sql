CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`entity` text NOT NULL,
	`entity_id` text NOT NULL,
	`before` text,
	`after` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `credential` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`env_id` text,
	`team_id` text,
	`owner_id` text NOT NULL,
	`visibility` text DEFAULT 'company' NOT NULL,
	`username` text NOT NULL,
	`secret_enc` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `env_group` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`env_ids` text,
	`role_id` text,
	`owner_id` text NOT NULL,
	`team_id` text,
	`visibility` text DEFAULT 'company' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `environment` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`base_url` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`login_form` text,
	`owner_id` text NOT NULL,
	`team_id` text,
	`visibility` text DEFAULT 'company' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`env_scope` text,
	`owner_id` text NOT NULL,
	`team_id` text,
	`visibility` text DEFAULT 'company' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run` (
	`id` text PRIMARY KEY NOT NULL,
	`env_label` text NOT NULL,
	`status` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`triggered_by` text NOT NULL,
	`scope` text,
	`artifact_dir` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `run_result` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`test_id` text NOT NULL,
	`env` text NOT NULL,
	`status` text NOT NULL,
	`duration_ms` integer,
	FOREIGN KEY (`run_id`) REFERENCES `run`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `test` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text NOT NULL,
	`file_path` text NOT NULL,
	`tags` text,
	`group` text,
	`priority` text,
	`owner` text,
	`notes` text,
	`run_as_role` text,
	`owner_id` text NOT NULL,
	`team_id` text,
	`visibility` text DEFAULT 'company' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `test_version` (
	`id` text PRIMARY KEY NOT NULL,
	`test_id` text NOT NULL,
	`source` text NOT NULL,
	`author_id` text NOT NULL,
	`message` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`test_id`) REFERENCES `test`(`id`) ON UPDATE no action ON DELETE no action
);
