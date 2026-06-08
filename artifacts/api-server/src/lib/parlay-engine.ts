import { eq, and } from "drizzle-orm";
import { db, parlaysTable, parlayLegsTable, settingsTable } from "@workspace/db";
import { checkMarketResolution, placePolymarketOrder } from "./polymarket";
import { logger } from "./logger";

type SelectedOutcome = {
  name: string;
  tokenId: string;
  odds: number;
  price: number;
  won: boolean | null;
};

export async function startParlayExecution(parlayId: number): Promise<void> {
  const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
  if (!parlay || parlay.status !== "draft") {
    throw new Error("Parlay not found or not in draft state");
  }

  const legs = await db
    .select()
    .from(parlayLegsTable)
    .where(eq(parlayLegsTable.parlayId, parlayId))
    .orderBy(parlayLegsTable.legOrder);

  if (legs.length === 0) {
    throw new Error("Parlay has no legs");
  }

  await db.update(parlaysTable)
    .set({ status: "active", updatedAt: new Date() })
    .where(eq(parlaysTable.id, parlayId));

  await executeNextLeg(parlayId);
}

export async function executeNextLeg(parlayId: number): Promise<void> {
  const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
  if (!parlay || parlay.status !== "active") return;

  const legs = await db
    .select()
    .from(parlayLegsTable)
    .where(eq(parlayLegsTable.parlayId, parlayId))
    .orderBy(parlayLegsTable.legOrder);

  const currentLegIndex = parlay.currentLegIndex;
  if (currentLegIndex >= legs.length) {
    // All legs done — parlay won
    await db.update(parlaysTable)
      .set({ status: "won", updatedAt: new Date() })
      .where(eq(parlaysTable.id, parlayId));
    logger.info({ parlayId }, "Parlay completed successfully");
    return;
  }

  const leg = legs[currentLegIndex];
  if (leg.status === "active") {
    // Already active, don't re-start
    return;
  }

  const stakeAmount = parseFloat(parlay.currentAmount as string);

  if (parlay.simulationMode) {
    // Simulation mode: just mark the leg as active with the stake amount
    await db.update(parlayLegsTable)
      .set({ status: "active", stakeAmount: stakeAmount.toString(), updatedAt: new Date() })
      .where(eq(parlayLegsTable.id, leg.id));
  } else {
    // Real mode: place order on Polymarket
    const [settings] = await db.select().from(settingsTable).limit(1);
    if (!settings?.polymarketApiKey || !settings?.walletAddress) {
      logger.error({ parlayId }, "No Polymarket API key or wallet address configured");
      return;
    }

    const outcomes = leg.selectedOutcomes as SelectedOutcome[];
    // Pick the outcome with best odds (highest potential return)
    const bestOutcome = outcomes.reduce((best, o) => o.odds > best.odds ? o : best, outcomes[0]);

    if (!settings.polymarketSecret || !settings.polymarketPassphrase) {
      logger.error({ parlayId }, "Polymarket L2 credentials incomplete (need apiKey, secret, passphrase)");
      await db.update(parlayLegsTable)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(parlayLegsTable.id, leg.id));
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const orderResult = await placePolymarketOrder({
      tokenId: bestOutcome.tokenId,
      amount: stakeAmount,
      apiKey: settings.polymarketApiKey,
      secret: settings.polymarketSecret,
      passphrase: settings.polymarketPassphrase,
      walletAddress: settings.walletAddress,
    });

    if (!orderResult) {
      logger.error({ parlayId, legOrder: leg.legOrder }, "Order placement failed — marking leg as errored");
      await db.update(parlayLegsTable)
        .set({ status: "pending", updatedAt: new Date() })
        .where(eq(parlayLegsTable.id, leg.id));
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    await db.update(parlayLegsTable)
      .set({
        status: "active",
        stakeAmount: stakeAmount.toString(),
        polymarketOrderId: orderResult.orderId,
        updatedAt: new Date(),
      })
      .where(eq(parlayLegsTable.id, leg.id));
  }

  logger.info({ parlayId, legOrder: leg.legOrder }, "Leg activated");
}

export async function checkAndSettleActiveLeg(parlayId: number): Promise<void> {
  const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
  if (!parlay || parlay.status !== "active") return;

  const legs = await db
    .select()
    .from(parlayLegsTable)
    .where(and(eq(parlayLegsTable.parlayId, parlayId), eq(parlayLegsTable.status, "active")))
    .orderBy(parlayLegsTable.legOrder);

  if (legs.length === 0) return;
  const leg = legs[0];

  if (parlay.simulationMode) {
    // Simulation: check market resolution via Polymarket API
    const resolution = await checkMarketResolution(leg.marketId);
    if (!resolution.resolved) return;

    const outcomes = leg.selectedOutcomes as SelectedOutcome[];
    const winningOutcomeNames = resolution.winningOutcomes.map(n => n.toLowerCase());

    // Check if any of selected outcomes won
    const wonOutcome = outcomes.find(o => winningOutcomeNames.some(w => w.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(w)));

    const updatedOutcomes = outcomes.map(o => ({
      ...o,
      won: wonOutcome ? o.name === wonOutcome.name : false,
    }));

    if (!wonOutcome) {
      // Lost this leg — parlay fails
      await db.update(parlayLegsTable)
        .set({ status: "lost", selectedOutcomes: updatedOutcomes, settledAt: new Date(), updatedAt: new Date() })
        .where(eq(parlayLegsTable.id, leg.id));

      await db.update(parlaysTable)
        .set({ status: "lost", currentAmount: "0", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));

      logger.info({ parlayId, legOrder: leg.legOrder }, "Leg lost — parlay failed");
      return;
    }

    // Won — calculate payout
    const stakeAmount = parseFloat(leg.stakeAmount as string);
    const payout = stakeAmount * wonOutcome.odds;
    const roundedPayout = Math.round(payout * 1000000) / 1000000;

    await db.update(parlayLegsTable)
      .set({
        status: "won",
        payoutAmount: roundedPayout.toString(),
        selectedOutcomes: updatedOutcomes,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(parlayLegsTable.id, leg.id));

    // Update parlay current amount and advance leg index
    const nextLegIndex = parlay.currentLegIndex + 1;
    const allLegs = await db.select().from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);

    const isLastLeg = nextLegIndex >= allLegs.length;

    await db.update(parlaysTable)
      .set({
        currentAmount: roundedPayout.toString(),
        currentLegIndex: nextLegIndex,
        status: isLastLeg ? "won" : "active",
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));

    logger.info({ parlayId, legOrder: leg.legOrder, payout: roundedPayout }, "Leg won");

    if (!isLastLeg) {
      await executeNextLeg(parlayId);
    }
  } else {
    // Real mode: check market resolution
    const resolution = await checkMarketResolution(leg.marketId);
    if (!resolution.resolved) return;

    const outcomes = leg.selectedOutcomes as SelectedOutcome[];
    const winningOutcomeNames = resolution.winningOutcomes.map(n => n.toLowerCase());
    const wonOutcome = outcomes.find(o => winningOutcomeNames.some(w => w.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(w)));

    const updatedOutcomes = outcomes.map(o => ({
      ...o,
      won: wonOutcome ? o.name === wonOutcome.name : false,
    }));

    if (!wonOutcome) {
      await db.update(parlayLegsTable)
        .set({ status: "lost", selectedOutcomes: updatedOutcomes, settledAt: new Date(), updatedAt: new Date() })
        .where(eq(parlayLegsTable.id, leg.id));

      await db.update(parlaysTable)
        .set({ status: "lost", currentAmount: "0", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const stakeAmount = parseFloat(leg.stakeAmount as string);
    const payout = stakeAmount * wonOutcome.odds;
    const roundedPayout = Math.round(payout * 1000000) / 1000000;

    await db.update(parlayLegsTable)
      .set({
        status: "won",
        payoutAmount: roundedPayout.toString(),
        selectedOutcomes: updatedOutcomes,
        settledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(parlayLegsTable.id, leg.id));

    const nextLegIndex = parlay.currentLegIndex + 1;
    const allLegs = await db.select().from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);

    const isLastLeg = nextLegIndex >= allLegs.length;

    await db.update(parlaysTable)
      .set({
        currentAmount: roundedPayout.toString(),
        currentLegIndex: nextLegIndex,
        status: isLastLeg ? "won" : "active",
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));

    if (!isLastLeg) {
      await executeNextLeg(parlayId);
    }
  }
}

export async function pollAllActiveParlays(): Promise<void> {
  const activeParlays = await db
    .select()
    .from(parlaysTable)
    .where(eq(parlaysTable.status, "active"));

  for (const parlay of activeParlays) {
    try {
      await checkAndSettleActiveLeg(parlay.id);
    } catch (err) {
      logger.error({ err, parlayId: parlay.id }, "Error polling parlay");
    }
  }
}
