import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, doublePrecision, timestamp, jsonb, uniqueIndex, index } from "drizzle-orm/pg-core";

const at = (name: string) => timestamp(name, { withTimezone: true, mode: "string" }).notNull().defaultNow();
export const operationalAlerts = pgTable("operational_alerts", {
  id: uuid("id").primaryKey().defaultRandom(),
  scope: text("scope").notNull(),
  code: text("code").notNull(),
  severity: text("severity").notNull(),
  observed: doublePrecision("observed").notNull(),
  threshold: doublePrecision("threshold").notNull(),
  firstSeenAt: at("first_seen_at"),
  lastSeenAt: at("last_seen_at"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true, mode: "string" }),
}, t => [uniqueIndex("operations_one_open_incident").on(t.scope, t.code).where(sql`${t.resolvedAt} IS NULL`)]);

export const operationalDeliveries = pgTable("operational_deliveries", {
  id: uuid("id").primaryKey().defaultRandom(),
  alertId: uuid("alert_id").notNull().references(() => operationalAlerts.id, { onDelete: "cascade" }),
  payload: jsonb("payload").notNull(),
  state: text("state").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  availableAt: at("available_at"),
  leaseToken: uuid("lease_token"),
  leaseUntil: timestamp("lease_until", { withTimezone: true, mode: "string" }),
  providerId: text("provider_id"),
  lastError: text("last_error"),
  durationMs: doublePrecision("duration_ms"),
  createdAt: at("created_at"),
  acceptedAt: timestamp("accepted_at", { withTimezone: true, mode: "string" }),
}, t => [index("operations_delivery_due").on(t.state, t.availableAt)]);
