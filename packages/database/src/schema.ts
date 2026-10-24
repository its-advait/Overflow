import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/** Scaffold placeholder table; replaced by the real schema in a later prompt. */
export const scaffold = pgTable("scaffold", {
  id: serial("id").primaryKey(),
  note: text("note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
