import { createHmac } from "crypto";
import { ethers } from "ethers";
import { logger } from "./logger";

const POLYGON_CHAIN_ID = 137;
const CTF_EXCHANGE_ADDRESS = "0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E";
const NEG_RISK_CTF_EXCHANGE_ADDRESS = "0xC5d563A36AE78145C45a50134d48A1215220f80a";

const ORDER_TYPES = {
  Order: [
    { name: "salt", type: "uint256" },
    { name: "maker", type: "address" },
    { name: "signer", type: "address" },
    { name: "taker", type: "address" },
    { name: "tokenId", type: "uint256" },
    { name: "makerAmount", type: "uint256" },
    { name: "takerAmount", type: "uint256" },
    { name: "expiration", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "feeRateBps", type: "uint256" },
    { name: "side", type: "uint8" },
    { name: "signatureType", type: "uint8" },
  ],
};

async function fetchTokenInfo(tokenId: string): Promise<{ tickSize: number; negRisk: boolean }> {
  try {
    const [tickRes, negRiskRes] = await Promise.all([
      fetch(`https://clob.polymarket.com/tick-size?token_id=${tokenId}`, { signal: AbortSignal.timeout(10000) }),
      fetch(`https://clob.polymarket.com/neg-risk?token_id=${tokenId}`, { signal: AbortSignal.timeout(10000) }),
    ]);
    const tickData = await tickRes.json() as any;
    const negRiskData = await negRiskRes.json() as any;
    const tickSize = parseFloat(tickData.minimum_tick_size ?? tickData.tick_size ?? "0.01");
    const negRisk = !!(negRiskData.neg_risk ?? negRiskData.negRisk ?? false);
    logger.info({ tokenId, tickSize, negRisk }, "Fetched token info from CLOB API");
    return { tickSize: isNaN(tickSize) ? 0.01 : tickSize, negRisk };
  } catch (err) {
    logger.warn({ err, tokenId }, "Failed to fetch token info, using defaults (tick=0.01, negRisk=false)");
    return { tickSize: 0.01, negRisk: false };
  }
}

function roundToTick(price: number, tickSize: number): number {
  const factor = Math.round(1 / tickSize);
  return Math.round(price * factor) / factor;
}

const GAMMA_API = "https://gamma-api.polymarket.com";
const POLYMARKET_WC_URL = "https://polymarket.com/sports/world-cup/games";
const POLYMARKET_SOCCER_URL = "https://polymarket.com/sports/soccer/games";

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

/** Fetch match slugs from any Polymarket sports page __NEXT_DATA__ */
async function fetchMatchSlugsByPage(
  pageUrl: string,
  slugPrefix: string
): Promise<string[]> {
  const res = await fetch(pageUrl, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
    },
    signal: AbortSignal.timeout(20000),
  });
  const html = await res.text();
  const m = html.match(
    /<script id="__NEXT_DATA__" type="application\/json"[^>]*>([\s\S]*?)<\/script>/
  );
  if (!m) throw new Error(`Could not find __NEXT_DATA__ in page: ${pageUrl}`);
  const data = JSON.parse(m[1]);
  const queries: any[] =
    data?.props?.pageProps?.dehydratedState?.queries || [];
  const parentMapQuery = queries.find(
    (q: any) => q?.queryKey?.[0] === "parentToChildEventIds"
  );
  const parentMap: Record<string, string[]> =
    parentMapQuery?.state?.data || {};
  return Object.keys(parentMap).filter((s) => s.startsWith(slugPrefix));
}

/** Parse a parent match event into a PolymarketMarket with 3 outcomes (Home/Draw/Away) */
function parseMatchEvent(event: any, category = "世界杯 2026"): PolymarketMarket | null {
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
      category,
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

/** Fetch and parse a list of slugs into PolymarketMarkets */
async function fetchAndParseEvents(
  slugs: string[],
  category: string
): Promise<PolymarketMarket[]> {
  if (slugs.length === 0) return [];
  const BATCH_SIZE = 20;
  const batches: string[][] = [];
  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    batches.push(slugs.slice(i, i + BATCH_SIZE));
  }
  const batchResults = await Promise.all(
    batches.map((batch) => fetchEventsBySlugs(batch))
  );
  const events = batchResults.flat();
  logger.debug({ eventCount: events.length, category }, "Fetched events from gamma-api");
  const markets: PolymarketMarket[] = [];
  for (const event of events) {
    const market = parseMatchEvent(event, category);
    if (market) markets.push(market);
  }
  return markets;
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
    logger.info("Fetching World Cup match slugs from Polymarket");
    const slugs = await fetchMatchSlugsByPage(POLYMARKET_WC_URL, "fifwc-");
    logger.info({ count: slugs.length }, "Found World Cup slugs");

    const markets = await fetchAndParseEvents(slugs, "世界杯 2026");
    logger.info({ count: markets.length }, "Parsed World Cup markets");

    if (search) {
      const q = search.toLowerCase();
      return markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    markets.sort((a, b) => {
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

    return markets;
  } catch (err) {
    logger.error({ err }, "Failed to fetch World Cup markets");
    return [];
  }
}

/** Fetch a set of markets by their Polymarket event slugs (used for pinned markets) */
export async function fetchMarketsBySlugs(
  slugs: string[],
  category = "友谊赛"
): Promise<PolymarketMarket[]> {
  if (slugs.length === 0) return [];
  return fetchAndParseEvents(slugs, category);
}

/** Fetch today's FIFA Friendlies markets from the Polymarket soccer page */
export async function fetchFIFAFriendliesMarkets(
  search?: string
): Promise<PolymarketMarket[]> {
  try {
    logger.info("Fetching FIFA Friendlies slugs from Polymarket soccer page");
    // fif-* = FIFA Friendlies; fifwc-* = World Cup (different prefix)
    const slugs = await fetchMatchSlugsByPage(POLYMARKET_SOCCER_URL, "fif-");
    logger.info({ count: slugs.length }, "Found FIFA Friendlies slugs");

    const markets = await fetchAndParseEvents(slugs, "友谊赛");
    logger.info({ count: markets.length }, "Parsed FIFA Friendlies markets");

    if (search) {
      const q = search.toLowerCase();
      return markets.filter((m) => m.title.toLowerCase().includes(q));
    }

    markets.sort((a, b) => {
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

    return markets;
  } catch (err) {
    logger.error({ err }, "Failed to fetch FIFA Friendlies markets");
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
    const normalized = params.secret.replace(/-/g, "+").replace(/_/g, "/");
    keyBuf = Buffer.from(normalized, "base64");
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
    // Derive L2 wallet from decoded secret (secret IS the L2 private key, base64-encoded)
    const normalized = params.secret.replace(/-/g, "+").replace(/_/g, "/");
    const l2KeyBytes = Buffer.from(normalized, "base64");
    const l2Wallet = new ethers.Wallet("0x" + l2KeyBytes.toString("hex"));

    // Fetch tick_size and neg_risk from Polymarket CLOB API
    const { tickSize, negRisk } = await fetchTokenInfo(params.tokenId);

    // Round price to nearest tick (INVALID_ORDER_MIN_TICK_SIZE if not rounded)
    const roundedPrice = roundToTick(params.price, tickSize);

    const makerAmount = BigInt(Math.round(params.sizeUsdc * 1e6));
    const takerAmount = BigInt(Math.round((params.sizeUsdc / roundedPrice) * 1e6));
    const salt = BigInt(Math.floor(Math.random() * 1e15));

    const domain = {
      name: "CTFExchange",
      version: "1.0",
      chainId: POLYGON_CHAIN_ID,
      verifyingContract: negRisk ? NEG_RISK_CTF_EXCHANGE_ADDRESS : CTF_EXCHANGE_ADDRESS,
    };

    const orderData = {
      salt,
      maker: params.walletAddress,   // funder / deposit address
      signer: l2Wallet.address,      // L2 signer derived from secret
      taker: "0x0000000000000000000000000000000000000000",
      tokenId: BigInt(params.tokenId),
      makerAmount,
      takerAmount,
      expiration: 0n,
      nonce: 0n,
      feeRateBps: 0n,
      side: 0,
      signatureType: 3,              // POLY_1271 — required for proxy wallet accounts
    };

    const orderSignature = await l2Wallet.signTypedData(domain, ORDER_TYPES, orderData);

    logger.info(
      { tokenId: params.tokenId, sizeUsdc: params.sizeUsdc, makerAmount: makerAmount.toString(), takerAmount: takerAmount.toString(), price: roundedPrice, negRisk, tickSize, l2Signer: l2Wallet.address },
      "Placing Polymarket order"
    );

    const bodyObj = {
      order: {
        salt: salt.toString(),
        maker: params.walletAddress,
        signer: l2Wallet.address,
        taker: "0x0000000000000000000000000000000000000000",
        tokenId: params.tokenId,
        makerAmount: makerAmount.toString(),
        takerAmount: takerAmount.toString(),
        expiration: "0",
        nonce: "0",
        feeRateBps: "0",
        side: "BUY",
        signatureType: 3,
        signature: orderSignature,
      },
      owner: params.walletAddress,
      orderType: "GTC",
    };
    const body = JSON.stringify(bodyObj);

    const timestamp = Math.floor(Date.now() / 1000).toString();
    const requestSig = buildPolymarketSignature({
      secret: params.secret,
      timestamp,
      method: "POST",
      path: "/order",
      body,
    });

    const res = await fetch("https://clob.polymarket.com/order", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "POLY_ADDRESS": params.walletAddress,
        "POLY_API_KEY": params.apiKey,
        "POLY_PASSPHRASE": params.passphrase,
        "POLY_SIGNATURE": requestSig,
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
    const orderId = data.orderID || data.orderId || data.order?.id || (data.success ? "placed" : null);
    if (!orderId) {
      logger.error({ data }, "Polymarket order response missing orderId");
      return null;
    }
    return { orderId: orderId.toString() };
  } catch (err) {
    logger.error({ err }, "Failed to place Polymarket order");
    return null;
  }
}
