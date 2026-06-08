import { pgTable, text, boolean, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const marketsCacheTable = pgTable("markets_cache", {
  id: text("id").primaryKey(), // Polymarket condition ID
  slug: text("slug"),
  title: text("title").notNull(),
  category: text("category"),
  endDate: timestamp("end_date", { withTimezone: true }),
  active: boolean("active").notNull().default(true),
  closed: boolean("closed").notNull().default(false),
  resolved: boolean("resolved").notNull().default(false),
  // JSON array of { name, price, odds, tokenId }
  outcomes: jsonb("outcomes").notNull().default([]),
  cachedAt: timestamp("cached_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertMarketCacheSchema = createInsertSchema(marketsCacheTable).omit({ cachedAt: true });
export type InsertMarketCache = z.infer<typeof insertMarketCacheSchema>;
export type MarketCache = typeof marketsCacheTable.$inferSelect;
