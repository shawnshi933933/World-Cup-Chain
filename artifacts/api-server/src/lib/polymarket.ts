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

function isSoccerMarket(question: string, events: any[]): boolean {
  const q = question.toLowerCase();
  const keywords = [
    "world cup", "fifa", "copa", "soccer", "football",
    "mls", "premier league", "champions league", "bundesliga",
    "la liga", "serie a", "ligue 1", "concacaf", "uefa",
    "euro 2026", "euro cup", "nations league",
  ];
  return keywords.some(kw => q.includes(kw));
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
    // Fetch a larger batch and filter by soccer keywords
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
      if (!isSoccerMarket(question, m.events || [])) continue;

      const market = parseMarket(m);
      if (market) markets.push(market);
    }

    // Apply search filter if provided
    if (search) {
      const q = search.toLowerCase();
      return markets.filter(m => m.title.toLowerCase().includes(q));
    }

    logger.info({ count: markets.length }, "Fetched football markets from Polymarket");
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

    // In a resolved market, winning outcome has price ~1.0
    const winning = market.outcomes.filter(o => o.price >= 0.95).map(o => o.name);
    return { resolved: true, winningOutcomes: winning };
  } catch (err) {
    logger.error({ err }, "Failed to check market resolution");
    return { resolved: false, winningOutcomes: [] };
  }
}

export async function placePolymarketOrder(params: {
  tokenId: string;
  amount: number;
  apiKey: string;
  walletAddress: string;
}): Promise<{ orderId: string } | null> {
  try {
    logger.info({ tokenId: params.tokenId, amount: params.amount }, "Placing Polymarket order");
    const res = await fetch("https://clob.polymarket.com/order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "POLY_ADDRESS": params.walletAddress,
        "POLY_API_KEY": params.apiKey,
        "POLY_PASSPHRASE": "",
        "POLY_SECRET": "",
      },
      body: JSON.stringify({
        orderType: "FOK",
        tokenID: params.tokenId,
        side: "BUY",
        size: params.amount.toString(),
        price: "0",
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      const text = await res.text();
      logger.error({ status: res.status, body: text }, "Polymarket order failed");
      return null;
    }

    const data = await res.json() as any;
    return { orderId: data.orderID || data.orderId || "unknown" };
  } catch (err) {
    logger.error({ err }, "Failed to place Polymarket order");
    return null;
  }
}
