import { eq, and } from "drizzle-orm";
import { db, parlaysTable, parlayLegsTable, settingsTable } from "@workspace/db";
import { checkMarketResolution, placePolymarketOrder } from "./polymarket";
import { logger } from "./logger";

// Polygon (Polymarket's chain) gas fees are minimal; deduct a small fixed amount per leg in real mode.
const GAS_FEE_USDC = 0.01;

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
    await db.update(parlaysTable)
      .set({ status: "won", updatedAt: new Date() })
      .where(eq(parlaysTable.id, parlayId));
    logger.info({ parlayId }, "Parlay completed successfully");
    return;
  }

  const leg = legs[currentLegIndex];
  if (leg.status === "active") {
    return;
  }

  const stakeAmount = parseFloat(parlay.currentAmount as string);

  if (parlay.simulationMode) {
    await db.update(parlayLegsTable)
      .set({ status: "active", stakeAmount: stakeAmount.toString(), updatedAt: new Date() })
      .where(eq(parlayLegsTable.id, leg.id));
  } else {
    // Real mode: validate full L2 credentials
    const [settings] = await db.select().from(settingsTable).limit(1);
    if (!settings?.polymarketApiKey || !settings?.polymarketSecret || !settings?.polymarketPassphrase || !settings?.walletAddress) {
      logger.error({ parlayId }, "Polymarket L2 credentials incomplete (need apiKey, secret, passphrase, walletAddress)");
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const outcomes = leg.selectedOutcomes as SelectedOutcome[];

    // Real mode: in a parlay, we bet on one outcome per leg.
    // If the user selected multiple outcomes for coverage, we choose the one with the highest odds
    // (highest potential return) as the single real-money bet. Settlement will check all selected outcomes.
    const betOutcome = outcomes.reduce((best, o) => o.odds > best.odds ? o : best, outcomes[0]);

    // Net stake after deducting gas fee
    const netStake = Math.max(stakeAmount - GAS_FEE_USDC, 0);
    if (netStake <= 0) {
      logger.error({ parlayId, stakeAmount }, "Stake too small after gas deduction");
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    // Limit GTC order: size = tokens to buy = netStake / price; price = current market price
    const orderResult = await placePolymarketOrder({
      tokenId: betOutcome.tokenId,
      price: betOutcome.price,
      sizeUsdc: netStake,
      apiKey: settings.polymarketApiKey,
      secret: settings.polymarketSecret,
      passphrase: settings.polymarketPassphrase,
      walletAddress: settings.walletAddress,
    });

    if (!orderResult) {
      logger.error({ parlayId, legOrder: leg.legOrder }, "Order placement failed — marking parlay as errored");
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    await db.update(parlayLegsTable)
      .set({
        status: "active",
        stakeAmount: netStake.toString(),
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

  // Resolution logic is the same for simulation and real mode:
  // The leg is won if ANY of the selected outcomes matches the market winner.
  const resolution = await checkMarketResolution(leg.marketId);
  if (!resolution.resolved) return;

  const outcomes = leg.selectedOutcomes as SelectedOutcome[];
  const winningOutcomeNames = resolution.winningOutcomes.map(n => n.toLowerCase());

  const wonOutcome = outcomes.find(o =>
    winningOutcomeNames.some(w => w.includes(o.name.toLowerCase()) || o.name.toLowerCase().includes(w))
  );

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
    logger.info({ parlayId, legOrder: leg.legOrder }, "Leg lost — parlay failed");
    return;
  }

  // Payout = stake * odds of winning outcome
  const stakeAmount = parseFloat(leg.stakeAmount as string);
  const rawPayout = stakeAmount * wonOutcome.odds;

  // Deduct gas fee before rolling proceeds to next leg (real mode only; simulation keeps full payout)
  const payout = parlay.simulationMode
    ? Math.round(rawPayout * 1_000_000) / 1_000_000
    : Math.round(Math.max(rawPayout - GAS_FEE_USDC, 0) * 1_000_000) / 1_000_000;

  await db.update(parlayLegsTable)
    .set({
      status: "won",
      payoutAmount: payout.toString(),
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
      currentAmount: payout.toString(),
      currentLegIndex: nextLegIndex,
      status: isLastLeg ? "won" : "active",
      updatedAt: new Date(),
    })
    .where(eq(parlaysTable.id, parlayId));

  logger.info({ parlayId, legOrder: leg.legOrder, payout, simulationMode: parlay.simulationMode }, "Leg won");

  if (!isLastLeg) {
    await executeNextLeg(parlayId);
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
