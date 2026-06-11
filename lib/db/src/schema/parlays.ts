import { pgTable, serial, text, numeric, integer, boolean, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const parlaysTable = pgTable("parlays", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  initialAmount: numeric("initial_amount", { precision: 18, scale: 6 }).notNull(),
  currentAmount: numeric("current_amount", { precision: 18, scale: 6 }).notNull(),
  status: text("status").notNull().default("draft"), // draft | active | won | lost
  simulationMode: boolean("simulation_mode").notNull().default(true),
  totalOdds: numeric("total_odds", { precision: 18, scale: 6 }).notNull().default("1"),
  totalOddsWorstCase: numeric("total_odds_worst_case", { precision: 18, scale: 6 }).notNull().default("1"),
  potentialPayout: numeric("potential_payout", { precision: 18, scale: 6 }).notNull().default("0"),
  currentLegIndex: integer("current_leg_index").notNull().default(0),
  totalLegs: integer("total_legs").notNull().default(0),
  balanceSnapshotUsdc: text("balance_snapshot_usdc"),
  payoutWaitSince: timestamp("payout_wait_since", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertParlaySchema = createInsertSchema(parlaysTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertParlay = z.infer<typeof insertParlaySchema>;
export type Parlay = typeof parlaysTable.$inferSelect;
