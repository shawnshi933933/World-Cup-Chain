import { Router, type IRouter } from "express";
import { eq, and, sum, count } from "drizzle-orm";
import { db, parlaysTable, parlayLegsTable } from "@workspace/db";
import { startParlayExecution } from "../lib/parlay-engine";
import {
  GetParlaysQueryParams,
  CreateParlayBody,
  GetParlayParams,
  DeleteParlayParams,
  StartParlayParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

function formatParlay(p: any) {
  return {
    id: p.id,
    name: p.name,
    initialAmount: parseFloat(p.initialAmount),
    currentAmount: parseFloat(p.currentAmount),
    status: p.status,
    simulationMode: p.simulationMode,
    totalOdds: parseFloat(p.totalOdds),
    totalOddsWorstCase: parseFloat(p.totalOddsWorstCase ?? p.totalOdds),
    potentialPayout: parseFloat(p.potentialPayout),
    currentLegIndex: p.currentLegIndex,
    totalLegs: p.totalLegs,
    createdAt: p.createdAt instanceof Date ? p.createdAt.toISOString() : p.createdAt,
    updatedAt: p.updatedAt instanceof Date ? p.updatedAt.toISOString() : p.updatedAt,
  };
}

function formatLeg(l: any) {
  return {
    id: l.id,
    parlayId: l.parlayId,
    legOrder: l.legOrder,
    marketId: l.marketId,
    marketTitle: l.marketTitle,
    selectedOutcomes: l.selectedOutcomes,
    stakeAmount: l.stakeAmount ? parseFloat(l.stakeAmount) : null,
    payoutAmount: l.payoutAmount ? parseFloat(l.payoutAmount) : null,
    status: l.status,
    settledAt: l.settledAt instanceof Date ? l.settledAt.toISOString() : l.settledAt ?? null,
    polymarketOrderId: l.polymarketOrderId ?? null,
  };
}

router.get("/parlays", async (req, res): Promise<void> => {
  const parsed = GetParlaysQueryParams.safeParse(req.query);
  const statusFilter = parsed.success ? parsed.data.status : undefined;

  try {
    let query = db.select().from(parlaysTable);
    const allParlays = await query.orderBy(parlaysTable.createdAt);

    let result = allParlays;
    if (statusFilter && statusFilter !== "all") {
      result = allParlays.filter(p => p.status === statusFilter);
    }

    res.json(result.map(formatParlay));
  } catch (err) {
    req.log.error({ err }, "Failed to get parlays");
    res.status(500).json({ error: "Failed to fetch parlays" });
  }
});

router.get("/parlays/stats", async (req, res): Promise<void> => {
  try {
    const parlays = await db.select().from(parlaysTable);

    const totalParlays = parlays.length;
    const activeParlays = parlays.filter(p => p.status === "active").length;
    const wonParlays = parlays.filter(p => p.status === "won").length;
    const lostParlays = parlays.filter(p => p.status === "lost").length;
    const totalStaked = parlays.reduce((sum, p) => sum + parseFloat(p.initialAmount as string), 0);

    // Calculate total payout from won parlays
    const wonLegs = await db.select().from(parlayLegsTable);
    const totalPayout = parlays
      .filter(p => p.status === "won")
      .reduce((sum, p) => sum + parseFloat(p.currentAmount as string), 0);

    const netProfit = totalPayout - totalStaked;

    res.json({
      totalParlays,
      activeParlays,
      wonParlays,
      lostParlays,
      totalStaked: Math.round(totalStaked * 100) / 100,
      totalPayout: Math.round(totalPayout * 100) / 100,
      netProfit: Math.round(netProfit * 100) / 100,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get parlay stats");
    res.status(500).json({ error: "Failed to fetch stats" });
  }
});

router.post("/parlays", async (req, res): Promise<void> => {
  const parsed = CreateParlayBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  const { name, initialAmount, simulationMode, legs } = parsed.data;

  try {
    // Calculate cumulative odds
    let totalOdds = 1;
    let totalOddsWorstCase = 1;

    for (const leg of legs) {
      if (leg.selectedOutcomes.length === 1) {
        totalOdds *= leg.selectedOutcomes[0].odds;
        totalOddsWorstCase *= leg.selectedOutcomes[0].odds;
      } else if (leg.selectedOutcomes.length === 2) {
        const bestOdds = Math.max(...leg.selectedOutcomes.map(o => o.odds));
        const worstOdds = Math.min(...leg.selectedOutcomes.map(o => o.odds));
        totalOdds *= bestOdds;
        totalOddsWorstCase *= worstOdds;
      }
    }

    totalOdds = Math.round(totalOdds * 100) / 100;
    totalOddsWorstCase = Math.round(totalOddsWorstCase * 100) / 100;
    const potentialPayout = Math.round(initialAmount * totalOdds * 100) / 100;

    const [parlay] = await db
      .insert(parlaysTable)
      .values({
        name,
        initialAmount: initialAmount.toString(),
        currentAmount: initialAmount.toString(),
        status: "draft",
        simulationMode,
        totalOdds: totalOdds.toString(),
        totalOddsWorstCase: totalOddsWorstCase.toString(),
        potentialPayout: potentialPayout.toString(),
        currentLegIndex: 0,
        totalLegs: legs.length,
      })
      .returning();

    // Insert legs
    for (let i = 0; i < legs.length; i++) {
      const leg = legs[i];
      await db.insert(parlayLegsTable).values({
        parlayId: parlay.id,
        legOrder: i,
        marketId: leg.marketId,
        marketTitle: leg.marketTitle,
        selectedOutcomes: leg.selectedOutcomes,
        status: "pending",
      });
    }

    res.status(201).json(formatParlay(parlay));
  } catch (err) {
    req.log.error({ err }, "Failed to create parlay");
    res.status(500).json({ error: "Failed to create parlay" });
  }
});

router.get("/parlays/:parlayId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.parlayId) ? req.params.parlayId[0] : req.params.parlayId;
  const parlayId = parseInt(raw, 10);

  if (isNaN(parlayId)) {
    res.status(400).json({ error: "Invalid parlay ID" });
    return;
  }

  try {
    const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
    if (!parlay) {
      res.status(404).json({ error: "Parlay not found" });
      return;
    }

    const legs = await db
      .select()
      .from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);

    res.json({ ...formatParlay(parlay), legs: legs.map(formatLeg) });
  } catch (err) {
    req.log.error({ err }, "Failed to get parlay");
    res.status(500).json({ error: "Failed to fetch parlay" });
  }
});

router.delete("/parlays/:parlayId", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.parlayId) ? req.params.parlayId[0] : req.params.parlayId;
  const parlayId = parseInt(raw, 10);

  if (isNaN(parlayId)) {
    res.status(400).json({ error: "Invalid parlay ID" });
    return;
  }

  try {
    const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
    if (!parlay) {
      res.status(404).json({ error: "Parlay not found" });
      return;
    }

    if (parlay.status === "active") {
      res.status(400).json({ error: "Cannot delete an active parlay" });
      return;
    }

    await db.delete(parlaysTable).where(eq(parlaysTable.id, parlayId));
    res.sendStatus(204);
  } catch (err) {
    req.log.error({ err }, "Failed to delete parlay");
    res.status(500).json({ error: "Failed to delete parlay" });
  }
});

router.post("/parlays/:parlayId/start", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.parlayId) ? req.params.parlayId[0] : req.params.parlayId;
  const parlayId = parseInt(raw, 10);

  if (isNaN(parlayId)) {
    res.status(400).json({ error: "Invalid parlay ID" });
    return;
  }

  try {
    await startParlayExecution(parlayId);

    const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
    const legs = await db
      .select()
      .from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);

    res.json({ ...formatParlay(parlay!), legs: legs.map(formatLeg) });
  } catch (err: any) {
    req.log.error({ err }, "Failed to start parlay");
    res.status(400).json({ error: err.message || "Failed to start parlay" });
  }
});

export default router;
