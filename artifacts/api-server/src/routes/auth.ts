import { Router, type IRouter } from "express";
import { createHash } from "crypto";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const router: IRouter = Router();

function appToken(): string | null {
  const pw = process.env.APP_PASSWORD;
  if (!pw) return null;
  return createHash("sha256").update(pw).digest("hex");
}

router.post("/auth/login", async (req, res): Promise<void> => {
  const token = appToken();
  if (!token) {
    res.json({ open: true, token: null });
    return;
  }
  const { password } = req.body ?? {};
  if (!password || password !== process.env.APP_PASSWORD) {
    res.status(401).json({ error: "密码错误" });
    return;
  }
  res.json({ open: false, token });
});

router.get("/auth/check", (_req, res): void => {
  res.json({ ok: true });
});

const CLOB_HOST = "https://clob.polymarket.com";

router.post("/auth/derive-key", async (req, res): Promise<void> => {
  const { walletAddress, signature, timestamp } = req.body ?? {};

  if (!walletAddress || !signature || !timestamp) {
    res.status(400).json({ error: "Missing walletAddress, signature, or timestamp" });
    return;
  }

  try {
    const polyRes = await fetch(`${CLOB_HOST}/auth/api-key`, {
      method: "POST",
      headers: {
        "POLY_ADDRESS":   walletAddress,
        "POLY_SIGNATURE": signature,
        "POLY_TIMESTAMP": String(timestamp),
      },
    });

    const body = await polyRes.json() as Record<string, unknown>;

    if (!polyRes.ok) {
      req.log.warn({ status: polyRes.status, body }, "Polymarket auth/api-key error");
      res.status(polyRes.status).json({ error: body?.error ?? "Polymarket request failed", detail: body });
      return;
    }

    const apiKey     = body.apiKey     as string | undefined;
    const secret     = body.secret     as string | undefined;
    const passphrase = body.passphrase as string | undefined;

    if (!apiKey || !secret || !passphrase) {
      req.log.warn({ body }, "Unexpected response shape from Polymarket");
      res.status(502).json({ error: "Unexpected response from Polymarket", raw: body });
      return;
    }

    res.json({ apiKey, secret, passphrase, walletAddress });
  } catch (err) {
    req.log.error({ err }, "Failed to proxy auth/api-key");
    res.status(502).json({ error: "Failed to reach Polymarket CLOB API" });
  }
});

router.post("/auth/save-key", async (req, res): Promise<void> => {
  const { walletAddress, apiKey, secret, passphrase } = req.body ?? {};

  if (!walletAddress || !apiKey || !secret || !passphrase) {
    res.status(400).json({ error: "Missing required fields" });
    return;
  }

  try {
    const [existing] = await db.select().from(settingsTable).limit(1);
    if (existing) {
      await db.update(settingsTable)
        .set({ walletAddress, polymarketApiKey: apiKey, polymarketSecret: secret, polymarketPassphrase: passphrase })
        .where(eq(settingsTable.id, existing.id));
    } else {
      await db.insert(settingsTable).values({
        simulationMode: false,
        walletAddress,
        polymarketApiKey: apiKey,
        polymarketSecret: secret,
        polymarketPassphrase: passphrase,
      });
    }
    res.json({ ok: true });
  } catch (err) {
    req.log.error({ err }, "Failed to save credentials");
    res.status(500).json({ error: "Failed to save credentials" });
  }
});

export default router;
