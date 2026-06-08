import { pgTable, serial, integer, text, numeric, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { parlaysTable } from "./parlays";

export const parlayLegsTable = pgTable("parlay_legs", {
  id: serial("id").primaryKey(),
  parlayId: integer("parlay_id").notNull().references(() => parlaysTable.id, { onDelete: "cascade" }),
  legOrder: integer("leg_order").notNull(),
  marketId: text("market_id").notNull(),
  marketTitle: text("market_title").notNull(),
  // JSON array of { name, tokenId, odds, price, won }
  selectedOutcomes: jsonb("selected_outcomes").notNull().default([]),
  stakeAmount: numeric("stake_amount", { precision: 18, scale: 6 }),
  payoutAmount: numeric("payout_amount", { precision: 18, scale: 6 }),
  status: text("status").notNull().default("pending"), // pending | active | won | lost
  settledAt: timestamp("settled_at", { withTimezone: true }),
  polymarketOrderId: text("polymarket_order_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertParlayLegSchema = createInsertSchema(parlayLegsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertParlayLeg = z.infer<typeof insertParlayLegSchema>;
export type ParlayLeg = typeof parlayLegsTable.$inferSelect;
