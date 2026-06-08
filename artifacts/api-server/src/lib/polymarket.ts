import { createHmac } from "crypto";
import { logger } from "./logger";

const GAMMA_API = "https://gamma-api.polymarket.com";

export interface PolymarketOutcome {
  name: string;
  price: number;
  odds: number;
  tokenId: string;
}

export interface PolymarketMarket {
  id: string;
  slug: string;
  title: string;
  category: string;
  endDate: string | null;
  active: boolean;
  closed: boolean;
  resolved: boolean;
  outcomes: PolymarketOutcome[];
}

function priceToOdds(price: number): number {
  if (price <= 0 || price >= 1) return 1;
  return Math.round((1 / price) * 100) / 100;
}

function isWorldCupMarket(question: string): boolean {
  const q = question.toLowerCase();
  const worldCupKeywords = [
    "world cup",
    "fifa",
    "copa mundial",
    "world cup 2026",
    "2026 world cup",
    "concacaf",
    "wc 2026",
  ];
  return worldCupKeywords.some(kw => q.includes(kw));
}

function parseMarket(m: any): PolymarketMarket | null {
  try {
    const title: string = m.question || m.title || "";
    if (!title) return null;

    const outcomesRaw: string[] = m.outcomes ? JSON.parse(m.outcomes) : [];
    const pricesRaw: string[] = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
    const tokenIds: string[] = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];

    const outcomes: PolymarketOutcome[] = outcomesRaw.map((name, i) => {
      const price = parseFloat(pricesRaw[i] || "0");
      return {
        name,
        price,
        odds: priceToOdds(price),
        tokenId: tokenIds[i] || "",
      };
    });

    const events: any[] = m.events || [];
    const eventTitle = events[0]?.title || events[0]?.ticker || "";

    return {
      id: m.conditionId || m.id,
      slug: m.slug || "",
      title,
      category: eventTitle,
      endDate: m.endDate || null,
      active: m.active ?? true,
      closed: m.closed ?? false,
      resolved: m.resolved ?? false,
      outcomes,
    };
  } catch (err) {
    logger.warn({ err, id: m.id }, "Failed to parse market");
    return null;
  }
}

export async function fetchWorldCupMarkets(search?: string): Promise<PolymarketMarket[]> {
  try {
    const params = new URLSearchParams({
      limit: "200",
      active: "true",
    });

    const url = `${GAMMA_API}/markets?${params.toString()}`;
    logger.info({ url }, "Fetching Polymarket markets");

    const res = await fetch(url, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(20000),
    });

    if (!res.ok) {
      logger.warn({ status: res.status }, "Polymarket API returned non-OK");
      return [];
    }

    const data = await res.json() as any[];
    if (!Array.isArray(data)) return [];

    const markets: PolymarketMarket[] = [];

    for (const m of data) {
      const question: string = m.question || "";
      if (!isWorldCupMarket(question)) continue;

      const market = parseMarket(m);
      if (market) markets.push(market);
    }

    if (search) {
      const q = search.toLowerCase();
      return markets.filter(m => m.title.toLowerCase().includes(q));
    }

    logger.info({ count: markets.length }, "Fetched World Cup markets from Polymarket");
    return markets;
  } catch (err) {
    logger.error({ err }, "Failed to fetch Polymarket markets");
    return [];
  }
}

export async function fetchMarketById(conditionId: string): Promise<PolymarketMarket | null> {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${conditionId}`, {
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const m = await res.json() as any;
    return parseMarket(m);
  } catch (err) {
    logger.error({ err, conditionId }, "Failed to fetch single market");
    return null;
  }
}

export async function checkMarketResolution(conditionId: string): Promise<{ resolved: boolean; winningOutcomes: string[] }> {
  try {
    const market = await fetchMarketById(conditionId);
    if (!market) return { resolved: false, winningOutcomes: [] };
    if (!market.resolved) return { resolved: false, winningOutcomes: [] };

    const winning = market.outcomes.filter(o => o.price >= 0.95).map(o => o.name);
    return { resolved: true, winningOutcomes: winning };
  } catch (err) {
    logger.error({ err }, "Failed to check market resolution");
    return { resolved: false, winningOutcomes: [] };
  }
}

/**
 * Build the HMAC-SHA256 signature for Polymarket L2 CLOB authentication.
 * Polymarket signs: timestamp + method + path + body (concatenated), keyed with base64url-decoded secret.
 */
function buildPolymarketSignature(params: {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
}): string {
  const message = params.timestamp + params.method + params.path + params.body;
  // Polymarket uses the raw base64-decoded secret as the HMAC key
  let keyBuf: Buffer;
  try {
    keyBuf = Buffer.from(params.secret, "base64");
  } catch {
    // If secret isn't valid base64, use it as UTF-8 bytes
    keyBuf = Buffer.from(params.secret, "utf8");
  }
  return createHmac("sha256", keyBuf).update(message).digest("base64");
}

export async function placePolymarketOrder(params: {
  tokenId: string;
  /** Market price per share (0-1). Used to calculate token quantity from USDC amount. */
  price: number;
  /** Stake in USDC after gas deduction */
  sizeUsdc: number;
  apiKey: string | null | undefined;
  secret: string | null | undefined;
  passphrase: string | null | undefined;
  walletAddress: string | null | undefined;
}): Promise<{ orderId: string } | null> {
  if (!params.apiKey || !params.secret || !params.passphrase || !params.walletAddress) {
    logger.error("placePolymarketOrder called with incomplete credentials");
    return null;
  }
  if (params.price <= 0 || params.price >= 1) {
    logger.error({ price: params.price }, "Invalid market price for order");
    return null;
  }

  try {
    // Number of outcome tokens to buy = USDC amount / price per token
    const tokenSize = params.sizeUsdc / params.price;

    logger.info({ tokenId: params.tokenId, sizeUsdc: params.sizeUsdc, tokenSize, price: params.price }, "Placing Polymarket order");

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = "POST";
    const path = "/order";
    const bodyObj = {
      orderType: "GTC",       // Good Till Cancelled limit order at market price
      tokenID: params.tokenId,
      side: "BUY",
      size: tokenSize.toFixed(4),     // token quantity
      price: params.price.toFixed(4), // price per share (e.g. "0.1615")
    };
    const body = JSON.stringify(bodyObj);

    const signature = buildPolymarketSignature({
      secret: params.secret,
      timestamp,
      method,
      path,
      body,
    });

    const res = await fetch("https://clob.polymarket.com/order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "POLY_ADDRESS": params.walletAddress,
        "POLY_API_KEY": params.apiKey,
        "POLY_PASSPHRASE": params.passphrase,
        "POLY_SIGNATURE": signature,
        "POLY_TIMESTAMP": timestamp,
      },
      body,
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, body: text }, "Polymarket order failed");
      return null;
    }

    const data = await res.json() as any;
    const orderId = data.orderID || data.orderId || data.order?.id;
    if (!orderId) {
      logger.error({ data }, "Polymarket order response missing orderId");
      return null;
    }
    return { orderId };
  } catch (err) {
    logger.error({ err }, "Failed to place Polymarket order");
    return null;
  }
}
