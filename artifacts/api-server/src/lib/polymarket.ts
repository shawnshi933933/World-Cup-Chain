import { logger } from "./logger";
import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import {
  AssetType,
  ClobClient,
  OrderType,
  Side,
  SignatureTypeV2,
} from "@polymarket/clob-client-v2";

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

/** Fetch the current best ask price from the CLOB orderbook for a token. */
async function getBestAskPrice(tokenId: string, fallbackPrice: number): Promise<number> {
  try {
    const res = await fetch(
      `https://clob.polymarket.com/book?token_id=${tokenId}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!res.ok) return fallbackPrice;
    const book = await res.json() as any;
    const asks: Array<{ price: string; size: string }> = book.asks ?? [];
    if (asks.length === 0) {
      logger.warn({ tokenId }, "No asks in orderbook — using fallback price");
      return fallbackPrice;
    }
    // Polymarket CLOB returns asks sorted descending (highest first) — find the minimum
    const bestAsk = Math.min(...asks.map(a => parseFloat(a.price)).filter(p => p > 0 && p < 1));
    if (isNaN(bestAsk) || bestAsk <= 0 || bestAsk >= 1) return fallbackPrice;
    logger.debug({ tokenId, bestAsk }, "Fetched best ask from CLOB orderbook");
    return bestAsk;
  } catch (err) {
    logger.warn({ err, tokenId }, "Failed to fetch orderbook best ask — using fallback price");
    return fallbackPrice;
  }
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

/** Fetch a single market by its numeric event ID using the events endpoint. */
export async function fetchMarketById(
  eventId: string
): Promise<PolymarketMarket | null> {
  try {
    const res = await fetch(`${GAMMA_API}/events/${eventId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const event = await res.json() as any;
    return parseMatchEvent(event);
  } catch (err) {
    logger.error({ err, eventId }, "Failed to fetch market by event ID");
    return null;
  }
}

/**
 * Check if any of our selected token outcomes have settled.
 * Uses the parent event endpoint (/events/{eventId}) — works with the numeric
 * event ID stored in leg.marketId (the /markets/{id} endpoint returns 404).
 *
 * Settlement is triggered by price threshold (default 0.98) so we don't have
 * to wait for the formal `resolved` flag. Returns the conditionId of the
 * settled child market so the relayer call gets the correct value.
 */
export async function checkMarketResolution(
  eventId: string,
  selectedTokenIds: string[],
  priceThreshold = 0.98
): Promise<{
  resolved: boolean;
  won: boolean;
  winningTokenIds: string[];
  conditionId?: string;
}> {
  const empty = { resolved: false, won: false, winningTokenIds: [], conditionId: undefined };
  try {
    const res = await fetch(`${GAMMA_API}/events/${eventId}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      logger.warn({ eventId, status: res.status }, "Event endpoint non-OK — skipping settlement check");
      return empty;
    }
    const event = await res.json() as any;
    const markets: any[] = event.markets || [];

    let anyWon = false;
    let anyLost = false;
    const winningTokenIds: string[] = [];
    let conditionId: string | undefined;

    for (const market of markets) {
      const tokenIds: string[] = market.clobTokenIds ? JSON.parse(market.clobTokenIds) : [];
      const prices: string[] = market.outcomePrices ? JSON.parse(market.outcomePrices) : [];

      for (let i = 0; i < tokenIds.length; i++) {
        if (!selectedTokenIds.includes(tokenIds[i])) continue;

        const price = parseFloat(prices[i] || "0");

        if (price >= priceThreshold) {
          anyWon = true;
          winningTokenIds.push(tokenIds[i]);
          conditionId = market.conditionId;
        } else if (price <= 1 - priceThreshold) {
          // Our token near zero — check if an opposing token in this market crossed the threshold
          const opposingWon = prices.some(
            (p, j) => !selectedTokenIds.includes(tokenIds[j]) && parseFloat(p) >= priceThreshold
          );
          if (opposingWon) anyLost = true;
        }
      }
    }

    if (anyWon) {
      logger.info({ eventId, winningTokenIds: winningTokenIds.map(t => t.slice(0, 16)), conditionId }, "Settlement check: WON (price >= threshold)");
      return { resolved: true, won: true, winningTokenIds, conditionId };
    }
    if (anyLost) {
      logger.info({ eventId }, "Settlement check: LOST (opposing outcome price >= threshold)");
      return { resolved: true, won: false, winningTokenIds: [], conditionId };
    }

    logger.debug({ eventId }, "Settlement check: not yet resolved");
    return empty;
  } catch (err) {
    logger.error({ err, eventId }, "Failed to check market resolution via event endpoint");
    return empty;
  }
}

export async function placePolymarketOrder(params: {
  tokenId: string;
  price: number;
  sizeUsdc: number;
  apiKey: string | null | undefined;
  secret: string | null | undefined;
  passphrase: string | null | undefined;
  walletAddress: string | null | undefined;
  privateKey?: string | null | undefined;
}): Promise<{ orderId: string } | null> {
  if (!params.apiKey || !params.secret || !params.passphrase || !params.walletAddress) {
    logger.error("placePolymarketOrder: incomplete credentials");
    return null;
  }
  if (!params.privateKey || params.privateKey.startsWith("••••")) {
    logger.error("placePolymarketOrder: EOA private key required for POLY_1271 deposit wallet orders");
    return null;
  }
  if (params.price <= 0 || params.price >= 1) {
    logger.error({ price: params.price }, "Invalid price for order");
    return null;
  }

  try {
    const pk = (params.privateKey.trim().startsWith("0x")
      ? params.privateKey.trim()
      : `0x${params.privateKey.trim()}`) as Hex;

    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({
      account,
      chain: polygon,
      transport: http(),
    });

    const creds = {
      key: params.apiKey,
      secret: params.secret,
      passphrase: params.passphrase,
    };

    const clob = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer: walletClient as any,
      creds,
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: params.walletAddress,
    });

    let tickSize = 0.01;
    let negRisk = false;
    try {
      const [tickData, negRiskData] = await Promise.all([
        clob.getTickSize(params.tokenId) as Promise<any>,
        clob.getNegRisk(params.tokenId) as Promise<any>,
      ]);
      tickSize = parseFloat(tickData?.minimum_tick_size ?? tickData?.tick_size ?? tickData ?? "0.01");
      negRisk = typeof negRiskData === "boolean" ? negRiskData : !!(negRiskData?.neg_risk ?? negRiskData?.negRisk ?? false);
      if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01;
    } catch {
      const fallback = await fetchTokenInfo(params.tokenId);
      tickSize = fallback.tickSize;
      negRisk = fallback.negRisk;
    }

    const roundedPrice = roundToTick(params.price, tickSize);
    const sizeTokens = params.sizeUsdc / roundedPrice;

    logger.info(
      { tokenId: params.tokenId, sizeUsdc: params.sizeUsdc, sizeTokens, price: roundedPrice, negRisk, tickSize, signer: account.address, funder: params.walletAddress },
      "Placing Polymarket GTC order via SDK (POLY_1271)"
    );

    const result = await clob.createAndPostOrder(
      { tokenID: params.tokenId, price: roundedPrice, size: sizeTokens, side: Side.BUY },
      { tickSize: tickSize.toString(), negRisk },
      OrderType.GTC,
    ) as any;

    const orderId = result?.orderID || result?.orderId || result?.order?.id || (result?.success ? "placed" : null);
    if (!orderId) {
      logger.error({ result }, "Polymarket SDK order: missing orderId in response");
      return null;
    }
    logger.info({ orderId, status: result?.status }, "Polymarket GTC order placed successfully");
    return { orderId: orderId.toString() };
  } catch (err) {
    logger.error({ err }, "Failed to place Polymarket order via SDK");
    return null;
  }
}

/**
 * Fetch the Polymarket CLOB USDC balance (cash available for trading).
 * Uses authenticated CLOB API — NOT on-chain ERC20 balance, which is always 0
 * because Polymarket holds funds inside their exchange contract.
 */
export async function getWalletBalanceUsdc(params: {
  apiKey: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
  privateKey?: string;
}): Promise<number> {
  try {
    if (!params.privateKey) {
      logger.warn({ walletAddress: params.walletAddress }, "No private key — cannot authenticate with CLOB to fetch balance");
      return 0;
    }
    const pk = (params.privateKey.trim().startsWith("0x")
      ? params.privateKey.trim()
      : `0x${params.privateKey.trim()}`) as Hex;

    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

    const clob = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer: walletClient as any,
      creds: { key: params.apiKey, secret: params.secret, passphrase: params.passphrase },
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: params.walletAddress,
    });

    const result = await clob.getBalanceAllowance({ asset_type: AssetType.COLLATERAL }) as any;
    // CLOB API returns balance in micro-USDC (6 decimal places), e.g. 27922481 = $27.92
    const raw = parseFloat(result?.balance ?? result?.allowance ?? "0");
    const balance = isNaN(raw) ? 0 : raw / 1_000_000;
    logger.debug({ walletAddress: params.walletAddress, balance, raw: result }, "Fetched CLOB USDC balance");
    return balance;
  } catch (err) {
    logger.warn({ err, walletAddress: params.walletAddress }, "Failed to fetch CLOB USDC balance");
    return 0;
  }
}

/**
 * Place IOC (Immediate-Or-Cancel) orders, retrying top-up orders for any unfilled remainder.
 * Each attempt: fetches current best ask from CLOB orderbook, places IOC at that price,
 * reads fill amount directly from the response (no waiting needed).
 * Returns null on total failure, or { orderIds, totalFilledUsdc } on any partial/full fill.
 */
export async function placePolymarketOrderWithRetry(params: {
  tokenId: string;
  price: number;       // fallback price if orderbook fetch fails
  sizeUsdc: number;
  apiKey: string | null | undefined;
  secret: string | null | undefined;
  passphrase: string | null | undefined;
  walletAddress: string | null | undefined;
  privateKey?: string | null | undefined;
  maxRetries?: number;
  retryDelaySec?: number;
}): Promise<{ orderIds: string[]; totalFilledUsdc: number } | null> {
  const maxRetries = params.maxRetries ?? 3;
  const retryDelaySec = params.retryDelaySec ?? 2;

  if (!params.apiKey || !params.secret || !params.passphrase || !params.walletAddress) {
    logger.error("placePolymarketOrderWithRetry: incomplete credentials");
    return null;
  }
  if (!params.privateKey || params.privateKey.startsWith("••••")) {
    logger.error("placePolymarketOrderWithRetry: EOA private key required");
    return null;
  }

  const pk = (params.privateKey.trim().startsWith("0x")
    ? params.privateKey.trim()
    : `0x${params.privateKey.trim()}`) as Hex;

  let clob: ClobClient;
  let tickSize = 0.01;
  let negRisk = false;

  try {
    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
    clob = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer: walletClient as any,
      creds: { key: params.apiKey!, secret: params.secret!, passphrase: params.passphrase! },
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: params.walletAddress!,
    });

    // Fetch token info once — reused across all retry attempts
    try {
      const [tickData, negRiskData] = await Promise.all([
        clob.getTickSize(params.tokenId) as Promise<any>,
        clob.getNegRisk(params.tokenId) as Promise<any>,
      ]);
      tickSize = parseFloat(tickData?.minimum_tick_size ?? tickData?.tick_size ?? tickData ?? "0.01");
      negRisk = typeof negRiskData === "boolean" ? negRiskData : !!(negRiskData?.neg_risk ?? negRiskData?.negRisk ?? false);
      if (isNaN(tickSize) || tickSize <= 0) tickSize = 0.01;
    } catch {
      const fallback = await fetchTokenInfo(params.tokenId);
      tickSize = fallback.tickSize;
      negRisk = fallback.negRisk;
    }
  } catch (err) {
    logger.error({ err }, "placePolymarketOrderWithRetry: failed to build ClobClient");
    return null;
  }

  // GTC aggressive limit: best ask + 2 cents sweeps the book in one shot.
  // Any unfilled remainder stays open on Polymarket (cancel manually if needed — should be rare).
  const bestAsk = await getBestAskPrice(params.tokenId, params.price);
  const aggressivePrice = Math.min(roundToTick(bestAsk + 0.02, tickSize), 0.99);
  const sizeTokens = params.sizeUsdc / bestAsk;

  logger.info(
    { tokenId: params.tokenId, sizeUsdc: params.sizeUsdc, sizeTokens, bestAsk, aggressivePrice, negRisk, tickSize },
    "Placing GTC aggressive order"
  );

  const orderIds: string[] = [];
  let totalFilledUsdc = 0;

  try {
    const result = await clob.createAndPostOrder(
      { tokenID: params.tokenId, price: aggressivePrice, size: sizeTokens, side: Side.BUY },
      { tickSize: tickSize.toString(), negRisk },
      OrderType.GTC,
    ) as any;

    const orderId = result?.orderID || result?.orderId || result?.order?.id;
    if (orderId) orderIds.push(orderId.toString());

    // takingAmount = tokens received, makingAmount = USDC spent
    const takingAmount = parseFloat(result?.takingAmount ?? "0");
    const makingAmount = parseFloat(result?.makingAmount ?? "0");
    totalFilledUsdc = makingAmount > 0 ? makingAmount : (takingAmount > 0 ? takingAmount * bestAsk : 0);

    logger.info(
      { orderId, takingAmount, makingAmount, totalFilledUsdc, status: result?.status },
      "GTC aggressive order result"
    );
  } catch (err) {
    logger.error({ err }, "GTC order placement error");
    return null;
  }

  if (orderIds.length === 0 && totalFilledUsdc === 0) return null;
  logger.info(
    { orderIds, totalFilledUsdc, originalSizeUsdc: params.sizeUsdc },
    "IOC order(s) complete"
  );
  return { orderIds, totalFilledUsdc };
}

/**
 * Call Polymarket's Relayer API to redeem a winning position (gasless).
 * This is the same call the web UI's "Claim" button makes.
 * Requires a Relayer API Key created in Polymarket account settings.
 */
export async function redeemWinningPosition(params: {
  conditionId: string;
  funderAddress: string;
  relayerApiKey: string;
  relayerKeyAddress: string;
}): Promise<boolean> {
  try {
    const res = await fetch("https://relayer-v2.polymarket.com/redeem", {
      method: "POST",
      headers: {
        "RELAYER_API_KEY": params.relayerApiKey,
        "RELAYER_API_KEY_ADDRESS": params.relayerKeyAddress,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        conditionId: params.conditionId,
        funder: params.funderAddress,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => ({})) as any;
    if (!res.ok) {
      logger.error({ conditionId: params.conditionId, status: res.status, data }, "Relayer redeem failed");
      return false;
    }
    logger.info({ conditionId: params.conditionId, data }, "Relayer redeem succeeded");
    return true;
  } catch (err) {
    logger.error({ err, conditionId: params.conditionId }, "Relayer redeem threw");
    return false;
  }
}

export async function syncPolymarketBalance(params: {
  apiKey: string;
  secret: string;
  passphrase: string;
  walletAddress: string;
  privateKey: string;
}): Promise<boolean> {
  try {
    const pk = (params.privateKey.trim().startsWith("0x")
      ? params.privateKey.trim()
      : `0x${params.privateKey.trim()}`) as Hex;

    const account = privateKeyToAccount(pk);
    const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

    const clob = new ClobClient({
      host: "https://clob.polymarket.com",
      chain: 137,
      signer: walletClient as any,
      creds: { key: params.apiKey, secret: params.secret, passphrase: params.passphrase },
      signatureType: SignatureTypeV2.POLY_1271,
      funderAddress: params.walletAddress,
    });

    await clob.updateBalanceAllowance({ asset_type: AssetType.COLLATERAL });
    logger.info({ depositWallet: params.walletAddress }, "Balance allowance synced with Polymarket CLOB");
    return true;
  } catch (err) {
    logger.warn({ err }, "Failed to sync balance allowance (may be geo-blocked or already synced)");
    return false;
  }
}
