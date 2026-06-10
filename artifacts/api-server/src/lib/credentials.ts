import { db, settingsTable } from "@workspace/db";

export interface PolymarketCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
  privateKey: string;
}

/**
 * Resolve Polymarket credentials.
 * Environment variables take precedence over DB-stored settings.
 * Priority: env vars → DB settings table.
 * Requires: apiKey, secret, passphrase, walletAddress (funder/deposit), privateKey (L1 Polygon key).
 */
export async function resolvePolymarketCredentials(): Promise<PolymarketCredentials | null> {
  const envKey = process.env.POLYMARKET_API_KEY;
  const envSecret = process.env.POLYMARKET_SECRET;
  const envPassphrase = process.env.POLYMARKET_PASSPHRASE;
  const envWallet = process.env.POLYMARKET_WALLET;
  const envPrivateKey = process.env.POLYMARKET_PRIVATE_KEY;

  if (envKey && envSecret && envPassphrase && envWallet && envPrivateKey) {
    return { apiKey: envKey, secret: envSecret, passphrase: envPassphrase, walletAddress: envWallet, privateKey: envPrivateKey };
  }

  const [settings] = await db.select().from(settingsTable).limit(1);
  if (
    settings?.polymarketApiKey &&
    settings?.polymarketSecret &&
    settings?.polymarketPassphrase &&
    settings?.walletAddress &&
    settings?.polymarketPrivateKey
  ) {
    return {
      apiKey: settings.polymarketApiKey,
      secret: settings.polymarketSecret,
      passphrase: settings.polymarketPassphrase,
      walletAddress: settings.walletAddress,
      privateKey: settings.polymarketPrivateKey,
    };
  }

  return null;
}

export function envCredentialsConfigured(): boolean {
  return !!(
    process.env.POLYMARKET_API_KEY &&
    process.env.POLYMARKET_SECRET &&
    process.env.POLYMARKET_PASSPHRASE &&
    process.env.POLYMARKET_WALLET
  );
}
