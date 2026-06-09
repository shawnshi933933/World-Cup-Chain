import { pgTable, serial, boolean, text, timestamp } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const settingsTable = pgTable("settings", {
  id: serial("id").primaryKey(),
  simulationMode: boolean("simulation_mode").notNull().default(true),
  polymarketApiKey: text("polymarket_api_key"),
  polymarketSecret: text("polymarket_secret"),
  polymarketPassphrase: text("polymarket_passphrase"),
  walletAddress: text("wallet_address"),
  pinnedMarketSlugs: text("pinned_market_slugs").notNull().default("[]"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

export const insertSettingsSchema = createInsertSchema(settingsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSettings = z.infer<typeof insertSettingsSchema>;
export type Settings = typeof settingsTable.$inferSelect;
