import { createHmac } from "crypto";
import { logger } from "./logger";

const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_SPORTS_URL = "https://polymarket.com/sports/world-cup/games";

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

/** Fetch the list of match slugs from Polymarket's sports page __NEXT_DATA__ */
async function fetchMatchSlugs(): Promise<string[]> {
  const res = await fetch(POLYMARKET_SPORTS_URL, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) throw new Error("Could not find __NEXT_DATA__ in Polymarket page");
  const data = JSON.parse(m[1]);
  const queries: any[] =
    data?.props?.pageProps?.dehydratedState?.queries || [];
  const parentMapQuery = queries.find(
    (q: any) => q?.queryKey?.[0] === "parentToChildEventIds"
  );
  const parentMap: Record<string, string[]> =
    parentMapQuery?.state?.data || {};
  return Object.keys(parentMap).filter((s) => s.startsWith("fifwc-"));
}

/** Parse a parent match event into a PolymarketMarket with 3 outcomes (Home/Draw/Away) */
function parseMatchEvent(event: any): PolymarketMarket | null {
  try {
    const title: string = event.title || "";
    if (!title.includes(" vs. ") && !title.includes(" vs ")) return null;

    const [homeTeam, awayTeam] = title.split(/ vs\.? /);
    if (!homeTeam || !awayTeam) return null;

    const markets: any[] = event.markets || [];
    if (markets.length < 2) return null;

    const outcomes: PolymarketOutcome[] = [];

    for (const m of markets) {
      const question: string = m.question || "";
      const qLower = question.toLowerCase();
      const pricesRaw: string[] = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
      const tokenIds: string[] = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];

      // YES outcome is always index 0 (the outcome we bet on)
      const yesPrice = parseFloat(pricesRaw[0] || "0");
      const yesTokenId = tokenIds[0] || "";

      let outcomeName: string;
      if (qLower.includes("draw")) {
        outcomeName = "平局";
      } else if (
        qLower.includes(homeTeam.toLowerCase()) ||
        qLower.includes("home")
      ) {
        outcomeName = `${homeTeam} 胜`;
      } else {
        outcomeName = `${awayTeam} 胜`;
      }

      outcomes.push({
        name: outcomeName,
        price: yesPrice,
        odds: priceToOdds(yesPrice),
        tokenId: yesTokenId,
      });
    }

    if (outcomes.length < 3) return null;

    // Ensure order: home win, draw, away win
    const sorted: PolymarketOutcome[] = [
      outcomes.find((o) => o.name.includes("胜") && o.name.startsWith(homeTeam.substring(0, 3))) ||
        outcomes[0],
      outcomes.find((o) => o.name === "平局") || outcomes[1],
      outcomes.find(
        (o) => o.name.includes("胜") && o.name.startsWith(awayTeam.substring(0, 3))
      ) || outcomes[2],
    ];

    return {
      id: event.id?.toString() || event.slug,
      slug: event.slug || "",
      title,
      category: "世界杯 2026",
      endDate: event.endDate || null,
      active: event.active ?? true,
      closed: event.closed ?? false,
      resolved: event.resolved ?? false,
      outcomes: sorted,
    };
  } catch (err) {
    logger.warn({ err, slug: event?.slug }, "Failed to parse match event");
    return null;
  }
}

/** Fetch a batch of events by slug from gamma-api */
async function fetchEventsBySlugs(slugs: string[]): Promise<any[]> {
  if (slugs.length === 0) return [];
  const params = new URLSearchParams({ limit: "50" });
  slugs.forEach((s) => params.append("slug", s));
  const url = `${GAMMA_API}/events?${params.toString()}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) return [];
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

export async function fetchWorldCupMarkets(
  search?: string
): Promise<PolymarketMarket[]> {
  try {
    logger.info("Fetching World Cup match slugs from Polymarket sports page");
    const slugs = await fetchMatchSlugs();
    logger.info({ count: slugs.length }, "Found match slugs");

    // Batch into groups of 20 and fetch in parallel
    const BATCH_SIZE = 20;
    const batches: string[][] = [];
    for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
      batches.push(slugs.slice(i, i + BATCH_SIZE));
    }

    const batchResults = await Promise.all(
      batches.map((batch) => fetchEventsBySlugs(batch))
    );
    const events = batchResults.flat();
    logger.info({ eventCount: events.length }, "Fetched match events from Polymarket");

    const markets: PolymarketMarket[] = [];
    for (const event of events) {
      const market = parseMatchEvent(event);
      if (market) markets.push(market);
    }

    logger.info({ count: markets.length }, "Parsed match markets");

    if (search) {
      const q = search.toLowerCase();
      return markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    // Sort by endDate ascending (upcoming matches first)
    markets.sort((a, b) => {
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

    return markets;
  } catch (err) {
    logger.error({ err }, "Failed to fetch Polymarket match markets");
    return [];
  }
}

export async function fetchMarketById(
  conditionId: string
): Promise<PolymarketMarket | null> {
  try {
    const res = await fetch(`${GAMMA_API}/markets/${conditionId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const m = await res.json() as any;

    // Legacy single-market parse (for settlement checks)
    const outcomesRaw: string[] = m.outcomes ? JSON.parse(m.outcomes) : [];
    const pricesRaw: string[] = m.outcomePrices ? JSON.parse(m.outcomePrices) : [];
    const tokenIds: string[] = m.clobTokenIds ? JSON.parse(m.clobTokenIds) : [];
    const outcomes: PolymarketOutcome[] = outcomesRaw.map((name, i) => ({
      name,
      price: parseFloat(pricesRaw[i] || "0"),
      odds: priceToOdds(parseFloat(pricesRaw[i] || "0")),
      tokenId: tokenIds[i] || "",
    }));

    return {
      id: m.conditionId || m.id,
      slug: m.slug || "",
      title: m.question || m.title || "",
      category: "",
      endDate: m.endDate || null,
      active: m.active ?? true,
      closed: m.closed ?? false,
      resolved: m.resolved ?? false,
      outcomes,
    };
  } catch (err) {
    logger.error({ err, conditionId }, "Failed to fetch single market");
    return null;
  }
}

export async function checkMarketResolution(
  conditionId: string
): Promise<{ resolved: boolean; winningOutcomes: string[] }> {
  try {
    const market = await fetchMarketById(conditionId);
    if (!market) return { resolved: false, winningOutcomes: [] };
    if (!market.resolved) return { resolved: false, winningOutcomes: [] };
    const winning = market.outcomes.filter((o) => o.price >= 0.95).map((o) => o.name);
    return { resolved: true, winningOutcomes: winning };
  } catch (err) {
    logger.error({ err }, "Failed to check market resolution");
    return { resolved: false, winningOutcomes: [] };
  }
}

function buildPolymarketSignature(params: {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
}): string {
  const message = params.timestamp + params.method + params.path + params.body;
  let keyBuf: Buffer;
  try {
    keyBuf = Buffer.from(params.secret, "base64");
  } catch {
    keyBuf = Buffer.from(params.secret, "utf8");
  }
  return createHmac("sha256", keyBuf).update(message).digest("base64");
}

export async function placePolymarketOrder(params: {
  tokenId: string;
  price: number;
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
    const tokenSize = params.sizeUsdc / params.price;
    logger.info(
      { tokenId: params.tokenId, sizeUsdc: params.sizeUsdc, tokenSize, price: params.price },
      "Placing Polymarket order"
    );

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const method = "POST";
    const path = "/order";
    const bodyObj = {
      orderType: "GTC",
      tokenID: params.tokenId,
      side: "BUY",
      size: tokenSize.toFixed(4),
      price: params.price.toFixed(4),
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
