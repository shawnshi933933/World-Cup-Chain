import { eq, and } from "drizzle-orm";
import { db, parlaysTable, parlayLegsTable } from "@workspace/db";
import { checkMarketResolution, placePolymarketOrderWithRetry, getWalletBalanceUsdc } from "./polymarket";
import { resolvePolymarketCredentials, resolveMinBetUsdc } from "./credentials";
import { logger } from "./logger";

const GAS_FEE_USDC = 0.01;
const PAYOUT_WAIT_TIMEOUT_MS = 15 * 60 * 1000;

type SelectedOutcome = {
  name: string;
  tokenId: string;
  odds: number;
  price: number;
  won: boolean | null;
  ratio?: number;
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
  if (leg.status === "active") return;

  const stakeAmount = parseFloat(parlay.currentAmount as string);

  if (parlay.simulationMode) {
    await db.update(parlayLegsTable)
      .set({ status: "active", stakeAmount: stakeAmount.toString(), updatedAt: new Date() })
      .where(eq(parlayLegsTable.id, leg.id));
  } else {
    const creds = await resolvePolymarketCredentials();
    if (!creds) {
      logger.error({ parlayId }, "Polymarket L2 credentials not configured");
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const outcomes = leg.selectedOutcomes as SelectedOutcome[];
    const netStake = Math.max(stakeAmount - GAS_FEE_USDC, 0);
    if (netStake <= 0) {
      logger.error({ parlayId, stakeAmount }, "Stake too small after gas deduction");
      await db.update(parlaysTable)
        .set({ status: "error", updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const hasSplit = outcomes.length === 2 && outcomes.every(o => o.ratio !== undefined && o.ratio !== null);
    let orderId: string | undefined;
    let actualStake = netStake;

    if (hasSplit) {
      const [o1, o2] = outcomes;
      const stake1 = netStake * (o1.ratio! / 100);
      const stake2 = netStake * (o2.ratio! / 100);

      logger.info({ parlayId, stake1, stake2, ratio1: o1.ratio, ratio2: o2.ratio }, "Placing split orders with retry");

      const [r1, r2] = await Promise.all([
        placePolymarketOrderWithRetry({ tokenId: o1.tokenId, price: o1.price, sizeUsdc: stake1, ...creds }),
        placePolymarketOrderWithRetry({ tokenId: o2.tokenId, price: o2.price, sizeUsdc: stake2, ...creds }),
      ]);

      if (!r1 || !r2) {
        logger.error({ parlayId, legOrder: leg.legOrder }, "One or both split orders failed — marking parlay as errored");
        await db.update(parlaysTable)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(parlaysTable.id, parlayId));
        return;
      }

      orderId = `${r1.orderIds.join(",")}|${r2.orderIds.join(",")}`;
      actualStake = r1.totalFilledUsdc + r2.totalFilledUsdc;
    } else {
      const betOutcome = outcomes[0];
      const r = await placePolymarketOrderWithRetry({
        tokenId: betOutcome.tokenId,
        price: betOutcome.price,
        sizeUsdc: netStake,
        ...creds,
      });

      if (!r) {
        logger.error({ parlayId, legOrder: leg.legOrder }, "Order placement failed — marking parlay as errored");
        await db.update(parlaysTable)
          .set({ status: "error", updatedAt: new Date() })
          .where(eq(parlaysTable.id, parlayId));
        return;
      }

      orderId = r.orderIds.join(",");
      actualStake = r.totalFilledUsdc;
    }

    await db.update(parlayLegsTable)
      .set({
        status: "active",
        stakeAmount: actualStake.toString(),
        polymarketOrderId: orderId,
        updatedAt: new Date(),
      })
      .where(eq(parlayLegsTable.id, leg.id));
  }
}

export async function checkAndSettleActiveLeg(parlayId: number): Promise<void> {
  const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
  if (!parlay || parlay.status !== "active") return;

  // PHASE: Waiting for on-chain USDC payout to arrive after a win
  if (!parlay.simulationMode && parlay.payoutWaitSince && parlay.balanceSnapshotUsdc) {
    const elapsed = Date.now() - parlay.payoutWaitSince.getTime();
    if (elapsed > PAYOUT_WAIT_TIMEOUT_MS) {
      logger.error({ parlayId, elapsedMs: elapsed }, "Payout wait timeout — marking parlay as error");
      await db.update(parlaysTable)
        .set({ status: "error", balanceSnapshotUsdc: null, payoutWaitSince: null, updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const creds = await resolvePolymarketCredentials();
    if (!creds?.walletAddress) return;

    const minBet = await resolveMinBetUsdc();
    const currentBalance = await getWalletBalanceUsdc(creds.walletAddress);
    const snapshotBalance = parseFloat(parlay.balanceSnapshotUsdc);
    const delta = currentBalance - snapshotBalance;

    logger.info({ parlayId, currentBalance, snapshotBalance, delta, minBet, elapsedMs: elapsed }, "Checking payout arrival");

    if (delta < minBet) {
      logger.info({ parlayId, delta, minBet }, "Payout not yet arrived — will retry next poll");
      return;
    }

    logger.info({ parlayId, delta }, "Payout confirmed — advancing to next leg");
    const nextLegIndex = parlay.currentLegIndex + 1;
    const allLegs = await db.select().from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);
    const isLastLeg = nextLegIndex >= allLegs.length;

    await db.update(parlaysTable)
      .set({
        currentAmount: delta.toString(),
        currentLegIndex: nextLegIndex,
        status: isLastLeg ? "won" : "active",
        balanceSnapshotUsdc: null,
        payoutWaitSince: null,
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));

    if (!isLastLeg) {
      await executeNextLeg(parlayId);
    }
    return;
  }

  // PHASE: Normal settlement — check if current active leg's market has resolved
  const legs = await db
    .select()
    .from(parlayLegsTable)
    .where(and(eq(parlayLegsTable.parlayId, parlayId), eq(parlayLegsTable.status, "active")))
    .orderBy(parlayLegsTable.legOrder);

  if (legs.length === 0) return;
  const leg = legs[0];

  const resolution = await checkMarketResolution(leg.marketId);
  if (!resolution.resolved) return;

  const outcomes = leg.selectedOutcomes as SelectedOutcome[];
  const winningOutcomeNames = resolution.winningOutcomes.map(n => n.toLowerCase());

  const wonOutcome: SelectedOutcome | undefined = outcomes.find(o =>
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

  const stakeAmount = parseFloat(leg.stakeAmount as string);
  const ratio = (wonOutcome.ratio ?? 100) / 100;
  const rawPayout = stakeAmount * ratio * wonOutcome.odds;

  const theoreticalPayout = parlay.simulationMode
    ? Math.round(rawPayout * 1_000_000) / 1_000_000
    : Math.round(Math.max(rawPayout - GAS_FEE_USDC, 0) * 1_000_000) / 1_000_000;

  await db.update(parlayLegsTable)
    .set({
      status: "won",
      payoutAmount: theoreticalPayout.toString(),
      selectedOutcomes: updatedOutcomes,
      settledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(parlayLegsTable.id, leg.id));

  logger.info({ parlayId, legOrder: leg.legOrder, theoreticalPayout, ratio, simulationMode: parlay.simulationMode }, "Leg won");

  if (parlay.simulationMode) {
    const nextLegIndex = parlay.currentLegIndex + 1;
    const allLegs = await db.select().from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);
    const isLastLeg = nextLegIndex >= allLegs.length;

    await db.update(parlaysTable)
      .set({
        currentAmount: theoreticalPayout.toString(),
        currentLegIndex: nextLegIndex,
        status: isLastLeg ? "won" : "active",
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));

    if (!isLastLeg) {
      await executeNextLeg(parlayId);
    }
  } else {
    const creds = await resolvePolymarketCredentials();
    if (!creds?.walletAddress) {
      logger.error({ parlayId }, "Cannot snapshot balance — no wallet address in credentials");
      return;
    }
    const balanceNow = await getWalletBalanceUsdc(creds.walletAddress);
    await db.update(parlaysTable)
      .set({
        balanceSnapshotUsdc: balanceNow.toString(),
        payoutWaitSince: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));
    logger.info({ parlayId, balanceSnapshot: balanceNow }, "Leg won (real mode) — snapshotted balance, waiting for USDC payout");
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
