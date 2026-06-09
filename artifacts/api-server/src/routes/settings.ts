import { Router, type IRouter } from "express";
import { db, settingsTable } from "@workspace/db";
import { UpdateSettingsBody } from "@workspace/api-zod";
import { envCredentialsConfigured } from "../lib/credentials";

const router: IRouter = Router();

async function getOrCreateSettings() {
  const [existing] = await db.select().from(settingsTable).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(settingsTable).values({ simulationMode: true }).returning();
  return created;
}

function formatSettings(s: any) {
  const envCreds = envCredentialsConfigured();
  return {
    simulationMode: s.simulationMode,
    hasApiKey: envCreds || !!s.polymarketApiKey,
    hasSecret: envCreds || !!s.polymarketSecret,
    hasPassphrase: envCreds || !!s.polymarketPassphrase,
    hasPrivateKey: !!(process.env.POLYMARKET_PRIVATE_KEY || s.polymarketPrivateKey),
    credentialsFromEnv: envCreds,
    polymarketApiKey: envCreds
      ? "env:POLYMARKET_API_KEY"
      : s.polymarketApiKey
        ? `****${s.polymarketApiKey.slice(-4)}`
        : null,
    walletAddress: envCreds
      ? process.env.POLYMARKET_WALLET ?? null
      : s.walletAddress ?? null,
  };
}

router.get("/settings", async (req, res): Promise<void> => {
  try {
    const settings = await getOrCreateSettings();
    res.json(formatSettings(settings));
  } catch (err) {
    req.log.error({ err }, "Failed to get settings");
    res.status(500).json({ error: "Failed to fetch settings" });
  }
});

router.put("/settings", async (req, res): Promise<void> => {
  const parsed = UpdateSettingsBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const settings = await getOrCreateSettings();
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (parsed.data.simulationMode !== undefined) {
      updates.simulationMode = parsed.data.simulationMode;
    }
    // Only update DB credentials when env vars are not set (env vars take precedence)
    if (!envCredentialsConfigured()) {
      if (parsed.data.polymarketApiKey !== undefined) {
        updates.polymarketApiKey = parsed.data.polymarketApiKey;
      }
      if (parsed.data.polymarketSecret !== undefined) {
        updates.polymarketSecret = parsed.data.polymarketSecret;
      }
      if (parsed.data.polymarketPassphrase !== undefined) {
        updates.polymarketPassphrase = parsed.data.polymarketPassphrase;
      }
      if (parsed.data.walletAddress !== undefined) {
        updates.walletAddress = parsed.data.walletAddress;
      }
      if (parsed.data.polymarketPrivateKey !== undefined) {
        updates.polymarketPrivateKey = parsed.data.polymarketPrivateKey;
      }
    }

    const { eq } = await import("drizzle-orm");
    const [updated] = await db
      .update(settingsTable)
      .set(updates)
      .where(eq(settingsTable.id, settings.id))
      .returning();

    res.json(formatSettings(updated));
  } catch (err) {
    req.log.error({ err }, "Failed to update settings");
    res.status(500).json({ error: "Failed to update settings" });
  }
});

export default router;
