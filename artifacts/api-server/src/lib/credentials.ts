import { db, settingsTable } from "@workspace/db";

export interface PolymarketCredentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
  privateKey?: string;
  relayerApiKey?: string;
  relayerKeyAddress?: string;
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
  const envRelayerKey = process.env.POLYMARKET_RELAYER_KEY;
  const envRelayerKeyAddress = process.env.POLYMARKET_RELAYER_KEY_ADDRESS;

  if (envKey && envSecret && envPassphrase && envWallet) {
    return {
      apiKey: envKey,
      secret: envSecret,
      passphrase: envPassphrase,
      walletAddress: envWallet,
      privateKey: envPrivateKey || undefined,
      relayerApiKey: envRelayerKey || undefined,
      relayerKeyAddress: envRelayerKeyAddress || undefined,
    };
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
      privateKey: settings.polymarketPrivateKey ?? undefined,
      relayerApiKey: envRelayerKey || undefined,
      relayerKeyAddress: envRelayerKeyAddress || undefined,
    };
  }

  return null;
}

export async function resolveMinBetUsdc(): Promise<number> {
  const envVal = process.env.MIN_BET_USDC;
  if (envVal) return parseFloat(envVal) || 2;
  const [settings] = await db.select().from(settingsTable).limit(1);
  return parseFloat(settings?.minBetUsdc ?? "2") || 2;
}

export function envCredentialsConfigured(): boolean {
  return !!(
    process.env.POLYMARKET_API_KEY &&
    process.env.POLYMARKET_SECRET &&
    process.env.POLYMARKET_PASSPHRASE &&
    process.env.POLYMARKET_WALLET
  );
}
