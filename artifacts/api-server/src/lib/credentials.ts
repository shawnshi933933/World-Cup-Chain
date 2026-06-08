import { db, settingsTable } from "@workspace/db";

export interface PolymarketCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
}

/**
 * Resolve Polymarket L2 credentials.
 * Environment variables take precedence over DB-stored settings.
 * Priority: env vars → DB settings table.
 */
export async function resolvePolymarketCredentials(): Promise<PolymarketCredentials | null> {
  const envKey = process.env.POLYMARKET_API_KEY;
  const envSecret = process.env.POLYMARKET_SECRET;
  const envPassphrase = process.env.POLYMARKET_PASSPHRASE;
  const envWallet = process.env.POLYMARKET_WALLET;

  if (envKey && envSecret && envPassphrase && envWallet) {
    return { apiKey: envKey, secret: envSecret, passphrase: envPassphrase, walletAddress: envWallet };
  }

  const [settings] = await db.select().from(settingsTable).limit(1);
  if (
    settings?.polymarketApiKey &&
    settings?.polymarketSecret &&
    settings?.polymarketPassphrase &&
    settings?.walletAddress
  ) {
    return {
      apiKey: settings.polymarketApiKey,
      secret: settings.polymarketSecret,
      passphrase: settings.polymarketPassphrase,
      walletAddress: settings.walletAddress,
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
