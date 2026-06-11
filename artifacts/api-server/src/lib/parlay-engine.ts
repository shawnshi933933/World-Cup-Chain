import { eq, and } from "drizzle-orm";
import { db, parlaysTable, parlayLegsTable } from "@workspace/db";
import { checkMarketResolution, placePolymarketOrderWithRetry, redeemWinningPosition } from "./polymarket";
import { resolvePolymarketCredentials, resolveMinBetUsdc } from "./credentials";
import { logger } from "./logger";

const GAS_FEE_USDC = 0.01;
// Delay between relayer redeem call and placing the next leg (let chain settle)
const REDEEM_SETTLE_DELAY_MS = 90 * 1000;

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

      logger.info({ parlayId, stake1, stake2, ratio1: o1.ratio, ratio2: o2.ratio }, "Placing split IOC orders");

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

    // No balance snapshot needed — payout is now handled via Relayer redeem at win detection.
  }
}

export async function checkAndSettleActiveLeg(parlayId: number): Promise<void> {
  const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
  if (!parlay || parlay.status !== "active") return;

  // PHASE A: After relayer redeem, wait REDEEM_SETTLE_DELAY_MS then advance to next leg.
  // payoutWaitSince = the timestamp at which we should proceed (set at win detection).
  // currentAmount is already set to theoreticalPayout by the win handler.
  if (!parlay.simulationMode && parlay.payoutWaitSince) {
    const now = Date.now();
    const proceedAt = parlay.payoutWaitSince.getTime();

    if (now < proceedAt) {
      logger.debug({ parlayId, waitMs: proceedAt - now }, "Waiting for redeem settlement — skipping");
      return;
    }

    logger.info({ parlayId, currentAmount: parlay.currentAmount }, "Redeem settle delay passed — advancing to next leg");
    const nextLegIndex = parlay.currentLegIndex + 1;
    const allLegs = await db.select().from(parlayLegsTable)
      .where(eq(parlayLegsTable.parlayId, parlayId))
      .orderBy(parlayLegsTable.legOrder);
    const isLastLeg = nextLegIndex >= allLegs.length;

    await db.update(parlaysTable)
      .set({
        currentLegIndex: nextLegIndex,
        status: isLastLeg ? "won" : "active",
        payoutWaitSince: null,
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));

    if (!isLastLeg) {
      await executeNextLeg(parlayId);
    }
    return;
  }

  // PHASE B: Settlement check — look up active leg and check if market resolved
  const legs = await db
    .select()
    .from(parlayLegsTable)
    .where(and(eq(parlayLegsTable.parlayId, parlayId), eq(parlayLegsTable.status, "active")))
    .orderBy(parlayLegsTable.legOrder);

  if (legs.length === 0) return;
  const leg = legs[0];

  // Skip until the match end time has passed — no point polling during the game
  if (leg.marketEndDate && new Date() < leg.marketEndDate) {
    logger.debug(
      { parlayId, marketEndDate: leg.marketEndDate, legOrder: leg.legOrder },
      "Match end time not reached — skipping settlement check"
    );
    return;
  }

  const resolution = await checkMarketResolution(leg.marketId);

  if (!resolution.resolved) {
    // Reset confirmation count if it was previously incremented
    if ((leg.resolvedConfirmCount ?? 0) > 0) {
      await db.update(parlayLegsTable)
        .set({ resolvedConfirmCount: 0, updatedAt: new Date() })
        .where(eq(parlayLegsTable.id, leg.id));
    }
    return;
  }

  // Market shows resolved — require 2 consecutive confirmations before settling
  // to guard against transient API glitches
  const newConfirmCount = (leg.resolvedConfirmCount ?? 0) + 1;
  if (newConfirmCount < 2) {
    await db.update(parlayLegsTable)
      .set({ resolvedConfirmCount: newConfirmCount, updatedAt: new Date() })
      .where(eq(parlayLegsTable.id, leg.id));
    logger.info(
      { parlayId, legOrder: leg.legOrder, confirmCount: newConfirmCount },
      "Market resolved — awaiting 2nd confirmation before settling"
    );
    return;
  }

  // Double-confirmed — proceed with settlement
  logger.info({ parlayId, legOrder: leg.legOrder }, "Market resolution double-confirmed — settling leg");

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
    // Real mode — call Relayer API to redeem winning position (gasless, same as web "Claim" button).
    // Then wait REDEEM_SETTLE_DELAY_MS for the chain to settle before placing the next leg.
    const creds = await resolvePolymarketCredentials();

    // Store theoreticalPayout as currentAmount so PHASE A uses it for the next leg stake
    const proceedAt = new Date(Date.now() + REDEEM_SETTLE_DELAY_MS);
    await db.update(parlaysTable)
      .set({
        currentAmount: theoreticalPayout.toString(),
        payoutWaitSince: proceedAt,
        updatedAt: new Date(),
      })
      .where(eq(parlaysTable.id, parlayId));

    // Fire-and-forget relayer call — failure is non-fatal (chain may settle on its own)
    if (creds?.relayerApiKey && creds?.relayerKeyAddress && creds?.walletAddress) {
      redeemWinningPosition({
        conditionId: leg.marketId,
        funderAddress: creds.walletAddress,
        relayerApiKey: creds.relayerApiKey,
        relayerKeyAddress: creds.relayerKeyAddress,
      }).then(ok => {
        if (!ok) logger.warn({ parlayId }, "Relayer redeem returned false — next leg will still be attempted after delay");
      }).catch(err => logger.error({ err, parlayId }, "Relayer redeem threw unexpectedly"));
    } else {
      logger.warn({ parlayId }, "Relayer API key not configured — skipping redeem call, next leg proceeds after delay");
    }

    logger.info({ parlayId, theoreticalPayout, proceedAt }, "Leg won (real mode) — redeem initiated, next leg scheduled");
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
