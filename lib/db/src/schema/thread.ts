import { pgTable, text, integer, timestamp, uuid, doublePrecision, boolean, jsonb, uniqueIndex, index, bigserial } from "drizzle-orm/pg-core";

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "string" }).notNull().defaultNow();

// Publish must copy schema only. This row makes an accidental development-data
// clone detectable before the production server serves requests or starts AI.
export const environmentMarkers = pgTable("environment_markers", {
  scope: text("scope").primaryKey(),
  createdAt: at("created_at"),
});

// Shared across workers/instances. Keys are hashes, never raw IP addresses.
export const rateLimits = pgTable("rate_limits", {
  key: text("key").primaryKey(),
  count: integer("count").notNull(),
  expiresAt: at("expires_at"),
});

export const missions = pgTable("missions", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: text("owner").notNull(),
  title: text("title").notNull(),
  subject: text("subject").notNull(),
  goal: text("goal").notNull(),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
}, t => [index("missions_owner").on(t.owner)]);

export const drafts = pgTable("drafts", {
  missionId: uuid("mission_id").primaryKey().references(() => missions.id),
  notes: text("notes").notNull().default(""),
  understanding: text("understanding").notNull().default(""),
  questions: text("questions").notNull().default(""),
  reasoning: text("reasoning").notNull().default(""),
  nextAction: text("next_action").notNull().default(""),
  version: integer("version").notNull().default(0),
  savedAt: at("saved_at"),
});

export const workflows = pgTable("workflows", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: text("owner").notNull(),
  missionId: uuid("mission_id").references(() => missions.id),
  operation: text("operation").notNull(),
  status: text("status").notNull().default("running"),
  durationMs: doublePrecision("duration_ms").notNull().default(0),
  createdAt: at("created_at"),
}, t => [index("workflows_owner_created").on(t.owner, t.createdAt)]);

export const checkpoints = pgTable("checkpoints", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  notes: text("notes").notNull(),
  understanding: text("understanding").notNull(),
  questions: text("questions").notNull(),
  reasoning: text("reasoning").notNull(),
  nextAction: text("next_action").notNull(),
  recallQuestion: text("recall_question").notNull(),
  source: text("source").notNull().default("fallback"),
  createdAt: at("created_at"),
}, t => [index("checkpoints_mission_created").on(t.missionId, t.createdAt)]);

export const executionEvents = pgTable("execution_events", {
  id: uuid("id").primaryKey().defaultRandom(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  sequence: integer("sequence").notNull(),
  name: text("name").notNull(),
  component: text("component").notNull(),
  sourceComponent: text("source_component").notNull().default("unknown"),
  destinationComponent: text("destination_component").notNull().default("unknown"),
  outcome: text("outcome").notNull(),
  durationMs: doublePrecision("duration_ms").notNull(),
  details: text("details").notNull(),
  attempt: integer("attempt").notNull().default(1),
  fallback: boolean("fallback").notNull().default(false),
  createdAt: at("created_at"),
}, t => [uniqueIndex("events_workflow_sequence").on(t.workflowId, t.sequence)]);

export const resumptions = pgTable("resumptions", {
  id: uuid("id").primaryKey().defaultRandom(),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  checkpointId: uuid("checkpoint_id").notNull().references(() => checkpoints.id),
  obstacle: text("obstacle").notNull(),
  recallAnswer: text("recall_answer").notNull(),
  strategy: text("strategy").notNull(),
  startedAt: at("started_at"),
  firstActionMs: doublePrecision("first_action_ms"),
});

export const requestRecords = pgTable("request_records", {
  id: uuid("id").primaryKey().defaultRandom(),
  owner: text("owner").notNull(),
  operation: text("operation").notNull(),
  key: text("key").notNull(),
  hash: text("hash").notNull(),
  response: jsonb("response").notNull(),
  attemptCount: integer("attempt_count").notNull().default(1),
  createdAt: at("created_at"),
}, t => [uniqueIndex("requests_owner_operation_key").on(t.owner, t.operation, t.key)]);

// Durable SSE outbox. Per-owner transaction locking makes cursors commit-ordered.
export const executionUpdates = pgTable("execution_updates", {
  id: bigserial("id", { mode: "bigint" }).primaryKey(),
  owner: text("owner").notNull(),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  createdAt: at("created_at"),
}, t => [index("execution_updates_owner_cursor").on(t.owner, t.id)]);

export const aiJobs = pgTable("ai_jobs", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkpointId: uuid("checkpoint_id").notNull().references(() => checkpoints.id),
  owner: text("owner").notNull(),
  queue: text("queue").notNull().default("continuity"),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
  status: text("status").notNull().default("queued"),
  attempts: integer("attempts").notNull().default(0),
  maxAttempts: integer("max_attempts").notNull().default(3),
  availableAt: at("available_at"),
  leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "string" }),
  leaseToken: uuid("lease_token"),
  failureInjection: boolean("failure_injection").notNull().default(false),
  lastError: text("last_error"),
  result: jsonb("result"),
  source: text("source").notNull().default("fallback"),
  createdAt: at("created_at"),
  updatedAt: at("updated_at"),
}, t => [uniqueIndex("ai_jobs_checkpoint").on(t.checkpointId), index("ai_jobs_due").on(t.status, t.availableAt)]);

export const reviewSchedules = pgTable("review_schedules", {
  id: uuid("id").primaryKey().defaultRandom(),
  checkpointId: uuid("checkpoint_id").notNull().references(() => checkpoints.id),
  missionId: uuid("mission_id").notNull().references(() => missions.id),
  owner: text("owner").notNull(),
  dueAt: at("due_at"),
  intervalMinutes: integer("interval_minutes").notNull().default(1440),
  repetitions: integer("repetitions").notNull().default(0),
  lapses: integer("lapses").notNull().default(0),
  ease: doublePrecision("ease").notNull().default(2.5),
  version: integer("version").notNull().default(0),
  lastReviewedAt: timestamp("last_reviewed_at", { withTimezone: true, mode: "string" }),
  algorithmVersion: text("algorithm_version").notNull().default("thread-spacing-v1"),
  createdAt: at("created_at"),
}, t => [uniqueIndex("reviews_checkpoint").on(t.checkpointId), index("reviews_owner_due").on(t.owner, t.dueAt, t.id)]);

export const recallAttempts = pgTable("recall_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  reviewId: uuid("review_id").notNull().references(() => reviewSchedules.id),
  scheduleVersion: integer("schedule_version").notNull(),
  question: text("question").notNull(),
  questionSource: text("question_source").notNull(),
  reference: jsonb("reference").notNull(),
  answer: text("answer"),
  difficulty: text("difficulty"),
  startedAt: at("started_at"),
  answeredAt: timestamp("answered_at", { withTimezone: true, mode: "string" }),
  ratedAt: timestamp("rated_at", { withTimezone: true, mode: "string" }),
  nextDueAt: timestamp("next_due_at", { withTimezone: true, mode: "string" }),
  intervalMinutes: integer("interval_minutes"),
  algorithmVersion: text("algorithm_version").notNull().default("thread-spacing-v1"),
  workflowId: uuid("workflow_id").notNull().references(() => workflows.id),
}, t => [uniqueIndex("recall_review_version").on(t.reviewId, t.scheduleVersion), index("recall_history").on(t.reviewId, t.startedAt, t.id)]);
