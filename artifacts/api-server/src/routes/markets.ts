import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, marketsCacheTable } from "@workspace/db";
import { fetchWorldCupMarkets, fetchMarketById } from "../lib/polymarket";
import { GetMarketsQueryParams } from "@workspace/api-zod";

const router: IRouter = Router();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

router.get("/markets", async (req, res): Promise<void> => {
  const parsed = GetMarketsQueryParams.safeParse(req.query);
  const search = parsed.success ? parsed.data.search : undefined;
  const forceRefresh = parsed.success ? parsed.data.refresh : false;

  try {
    if (!forceRefresh) {
      // Check cache first
      const cutoff = new Date(Date.now() - CACHE_TTL_MS);
      const cached = await db.select().from(marketsCacheTable);
      const fresh = cached.filter(m => m.cachedAt && new Date(m.cachedAt) > cutoff);

      if (fresh.length > 0) {
        let markets = fresh.map(m => ({
          id: m.id,
          slug: m.slug,
          title: m.title,
          category: m.category,
          endDate: m.endDate?.toISOString() ?? null,
          active: m.active,
          closed: m.closed,
          resolved: m.resolved,
          outcomes: m.outcomes,
          cachedAt: m.cachedAt?.toISOString(),
        }));

        if (search) {
          const q = search.toLowerCase();
          markets = markets.filter(m => m.title.toLowerCase().includes(q));
        }

        res.json(markets);
        return;
      }
    }

    // Fetch fresh from Polymarket
    const markets = await fetchWorldCupMarkets(search);

    // Upsert into cache (only when not filtering)
    if (!search) {
      for (const m of markets) {
        await db
          .insert(marketsCacheTable)
          .values({
            id: m.id,
            slug: m.slug,
            title: m.title,
            category: m.category,
            endDate: m.endDate ? new Date(m.endDate) : null,
            active: m.active,
            closed: m.closed,
            resolved: m.resolved,
            outcomes: m.outcomes,
            cachedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: marketsCacheTable.id,
            set: {
              slug: m.slug,
              title: m.title,
              category: m.category,
              endDate: m.endDate ? new Date(m.endDate) : null,
              active: m.active,
              closed: m.closed,
              resolved: m.resolved,
              outcomes: m.outcomes,
              cachedAt: new Date(),
            },
          });
      }
    }

    const result = markets.map(m => ({
      id: m.id,
      slug: m.slug,
      title: m.title,
      category: m.category,
      endDate: m.endDate ?? null,
      active: m.active,
      closed: m.closed,
      resolved: m.resolved,
      outcomes: m.outcomes,
      cachedAt: new Date().toISOString(),
    }));

    res.json(result);
  } catch (err) {
    req.log.error({ err }, "Failed to get markets");
    res.status(500).json({ error: "Failed to fetch markets" });
  }
});

router.get("/markets/:marketId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.marketId) ? req.params.marketId[0] : req.params.marketId;

  try {
    // Try cache first
    const [cached] = await db.select().from(marketsCacheTable).where(eq(marketsCacheTable.id, raw));
    if (cached) {
      res.json({
        id: cached.id,
        slug: cached.slug,
        title: cached.title,
        category: cached.category,
        endDate: cached.endDate?.toISOString() ?? null,
        active: cached.active,
        closed: cached.closed,
        resolved: cached.resolved,
        outcomes: cached.outcomes,
        cachedAt: cached.cachedAt?.toISOString(),
      });
      return;
    }

    // Fetch from Polymarket
    const market = await fetchMarketById(raw);
    if (!market) {
      res.status(404).json({ error: "Market not found" });
      return;
    }

    res.json({
      id: market.id,
      slug: market.slug,
      title: market.title,
      category: market.category,
      endDate: market.endDate ?? null,
      active: market.active,
      closed: market.closed,
      resolved: market.resolved,
      outcomes: market.outcomes,
      cachedAt: new Date().toISOString(),
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get market");
    res.status(500).json({ error: "Failed to fetch market" });
  }
});

export default router;
