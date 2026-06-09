import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, marketsCacheTable, settingsTable } from "@workspace/db";
import {
  fetchWorldCupMarkets,
  fetchMarketsBySlugs,
  fetchMarketById,
} from "../lib/polymarket";
import { GetMarketsQueryParams } from "@workspace/api-zod";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function getPinnedSlugs(): Promise<string[]> {
  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    if (!settings?.pinnedMarketSlugs) return [];
    return JSON.parse(settings.pinnedMarketSlugs) as string[];
  } catch {
    return [];
  }
}

router.get("/markets", async (req, res): Promise<void> => {
  const parsed = GetMarketsQueryParams.safeParse(req.query);
  const search = parsed.success ? parsed.data.search : undefined;
  const forceRefresh = parsed.success ? parsed.data.refresh : false;

  try {
    if (!forceRefresh) {
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
        markets.sort((a, b) => {
          if (!a.endDate) return 1;
          if (!b.endDate) return -1;
          return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
        });
        res.json(markets);
        return;
      }
    }

    // Fetch fresh: World Cup + pinned markets (e.g. FIFA Friendlies) in parallel
    const pinnedSlugs = await getPinnedSlugs();
    const [wcMarkets, pinnedMarkets] = await Promise.all([
      fetchWorldCupMarkets(search),
      pinnedSlugs.length > 0 ? fetchMarketsBySlugs(pinnedSlugs) : Promise.resolve([]),
    ]);

    // Merge and sort everything by date
    const markets = [...pinnedMarkets, ...wcMarkets].sort((a, b) => {
      if (!a.endDate) return 1;
      if (!b.endDate) return -1;
      return new Date(a.endDate).getTime() - new Date(b.endDate).getTime();
    });

    // Upsert into cache
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

/**
 * POST /api/markets/pinned
 * Body: { slug: string, action: "add" | "remove" }
 * Pins or unpins a Polymarket event slug so it always appears in the markets list.
 */
router.post("/markets/pinned", async (req, res): Promise<void> => {
  const { slug, action } = req.body as { slug?: string; action?: string };
  if (!slug || typeof slug !== "string") {
    res.status(400).json({ error: "slug is required" });
    return;
  }
  if (action !== "add" && action !== "remove") {
    res.status(400).json({ error: "action must be 'add' or 'remove'" });
    return;
  }

  try {
    const [settings] = await db.select().from(settingsTable).limit(1);
    const current: string[] = settings?.pinnedMarketSlugs
      ? JSON.parse(settings.pinnedMarketSlugs)
      : [];

    let updated: string[];
    if (action === "add") {
      if (current.includes(slug)) {
        res.json({ pinnedSlugs: current, message: "Already pinned" });
        return;
      }
      // Verify the slug resolves on gamma-api before pinning
      const markets = await fetchMarketsBySlugs([slug]);
      if (markets.length === 0) {
        res.status(404).json({ error: `No 3-outcome match market found for slug: ${slug}` });
        return;
      }
      updated = [...current, slug];
      logger.info({ slug }, "Pinned market slug");
    } else {
      updated = current.filter(s => s !== slug);
      logger.info({ slug }, "Unpinned market slug");
    }

    await db
      .update(settingsTable)
      .set({ pinnedMarketSlugs: JSON.stringify(updated), updatedAt: new Date() })
      .where(eq(settingsTable.id, settings.id));

    // Bust the markets cache so next fetch picks up the change
    await db.delete(marketsCacheTable);

    res.json({ pinnedSlugs: updated });
  } catch (err) {
    req.log.error({ err }, "Failed to update pinned markets");
    res.status(500).json({ error: "Failed to update pinned markets" });
  }
});

router.get("/markets/:marketId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.marketId) ? req.params.marketId[0] : req.params.marketId;

  try {
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
