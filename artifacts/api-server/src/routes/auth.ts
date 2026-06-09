import { Router, type IRouter } from "express";
import { createHash } from "crypto";
import { db, settingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { ethers } from "ethers";

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
    // --- Local verification so we can confirm our signature is correct ---
    let recoveredAddress = "(error)";
    let localVerifyOk = false;
    try {
      recoveredAddress = ethers.verifyMessage(String(timestamp), signature);
      localVerifyOk = recoveredAddress.toLowerCase() === walletAddress.toLowerCase();
    } catch (e) {
      req.log.warn({ err: e }, "Local ethers.verifyMessage threw");
    }

    // Recovery id from the last byte of the signature (v - 27)
    const sigHex = signature.replace(/^0x/, "");
    const v = parseInt(sigHex.slice(-2), 16);
    const nonce = v >= 27 ? v - 27 : v;
    // Strip 0x to match py-clob-client format
    const sigStripped = sigHex;

    req.log.info({
      walletAddress,
      recoveredAddress,
      localVerifyOk,
      timestamp: String(timestamp),
      sigLength: sigStripped.length,
      nonce,
    }, "Forwarding to Polymarket /auth/api-key");

    // If local verify failed, the signing account differs from the connected account.
    // Use the recovered (actual signer) address for POLY_ADDRESS so Polymarket can verify.
    const effectiveAddress = localVerifyOk ? walletAddress : recoveredAddress;

    if (!localVerifyOk) {
      req.log.warn(
        { walletAddress, recoveredAddress, effectiveAddress },
        "Signing account differs from connected account – using recovered address for Polymarket"
      );
    }

    const polyRes = await fetch(`${CLOB_HOST}/auth/api-key`, {
      method: "POST",
      headers: {
        "POLY_ADDRESS":   effectiveAddress,
        "POLY_SIGNATURE": sigStripped,
        "POLY_TIMESTAMP": String(timestamp),
        "POLY_NONCE":     "0",
        "Origin":         "https://polymarket.com",
        "Referer":        "https://polymarket.com/",
        "Content-Type":   "application/json",
      },
    });

    const body = await polyRes.json() as Record<string, unknown>;

    if (!polyRes.ok) {
      req.log.warn({ status: polyRes.status, body, walletAddress, sigLength: sigStripped.length }, "Polymarket auth/api-key error");
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

    res.json({ apiKey, secret, passphrase, walletAddress: effectiveAddress });
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
