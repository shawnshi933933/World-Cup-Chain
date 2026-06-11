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
    const bestAsk = parseFloat(asks[0].price);
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

const USDC_POLYGON_BRIDGED = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174" as const;
const USDC_POLYGON_NATIVE  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;
const USDC_DECIMALS = 6;
const ERC20_BALANCE_ABI = [{
  inputs: [{ name: "account", type: "address" }],
  name: "balanceOf",
  outputs: [{ name: "", type: "uint256" }],
  stateMutability: "view",
  type: "function",
}] as const;

/** Read on-chain USDC balance of the deposit wallet (both bridged + native, sum). */
export async function getWalletBalanceUsdc(walletAddress: string): Promise<number> {
  try {
    const { createPublicClient } = await import("viem");
    const publicClient = createPublicClient({ chain: polygon, transport: http() });
    const addr = walletAddress as `0x${string}`;
    const [b1, b2] = await Promise.all([
      publicClient.readContract({ address: USDC_POLYGON_BRIDGED, abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [addr] }).catch(() => 0n),
      publicClient.readContract({ address: USDC_POLYGON_NATIVE,  abi: ERC20_BALANCE_ABI, functionName: "balanceOf", args: [addr] }).catch(() => 0n),
    ]);
    const total = Number(b1 + b2) / 10 ** USDC_DECIMALS;
    logger.debug({ walletAddress, total }, "Fetched on-chain USDC balance");
    return total;
  } catch (err) {
    logger.warn({ err, walletAddress }, "Failed to fetch on-chain USDC balance");
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

  const orderIds: string[] = [];
  let totalFilledUsdc = 0;
  let remainingUsdc = params.sizeUsdc;

  for (let attempt = 0; attempt < maxRetries && remainingUsdc >= 1; attempt++) {
    if (attempt > 0) {
      await new Promise(r => setTimeout(r, retryDelaySec * 1000));
      logger.info({ attempt, remainingUsdc }, `GTC top-up attempt ${attempt + 1}/${maxRetries}`);
    }

    // GTC aggressive limit: best ask + 2 cents, sweeps the book up to this price.
    // Unfilled remainder stays as a maker order — we cancel it immediately after.
    const bestAsk = await getBestAskPrice(params.tokenId, params.price);
    const aggressivePrice = Math.min(roundToTick(bestAsk + 0.02, tickSize), 0.99);
    const sizeTokens = remainingUsdc / bestAsk; // size based on best ask, not limit price

    logger.info(
      { tokenId: params.tokenId, remainingUsdc, sizeTokens, bestAsk, aggressivePrice, negRisk, tickSize, attempt },
      "Placing GTC aggressive order"
    );

    try {
      const result = await clob.createAndPostOrder(
        { tokenID: params.tokenId, price: aggressivePrice, size: sizeTokens, side: Side.BUY },
        { tickSize: tickSize.toString(), negRisk },
        OrderType.GTC,
      ) as any;

      const orderId = result?.orderID || result?.orderId || result?.order?.id;
      if (orderId) orderIds.push(orderId.toString());

      // Parse fill: takingAmount = tokens received, makingAmount = USDC spent
      const takingAmount = parseFloat(result?.takingAmount ?? "0");
      const makingAmount = parseFloat(result?.makingAmount ?? "0");
      const filledUsdc = makingAmount > 0 ? makingAmount : (takingAmount > 0 ? takingAmount * bestAsk : 0);

      logger.info(
        { orderId, takingAmount, makingAmount, filledUsdc, remainingUsdc, status: result?.status },
        "GTC aggressive order result"
      );

      // Cancel unfilled remainder so it doesn't linger on the book
      if (orderId) {
        try {
          await clob.cancelOrder({ orderID: orderId });
          logger.info({ orderId }, "Cancelled GTC order remainder");
        } catch (cancelErr) {
          // Already fully filled or cancel failed — not critical
          logger.warn({ orderId, cancelErr }, "GTC cancel attempt failed (may already be fully filled)");
        }
      }

      if (filledUsdc > 0) {
        totalFilledUsdc += filledUsdc;
        remainingUsdc -= filledUsdc;
        if (remainingUsdc < 0.01) break;
      } else {
        // Nothing filled — orderbook empty or price mismatch; stop retrying
        logger.warn({ tokenId: params.tokenId, attempt }, "GTC order filled nothing — stopping retries");
        break;
      }
    } catch (err) {
      logger.error({ err, attempt }, "GTC order placement error — stopping retries");
      break;
    }
  }

  if (orderIds.length === 0 && totalFilledUsdc === 0) return null;
  logger.info(
    { orderIds, totalFilledUsdc, originalSizeUsdc: params.sizeUsdc },
    "IOC order(s) complete"
  );
  return { orderIds, totalFilledUsdc };
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
