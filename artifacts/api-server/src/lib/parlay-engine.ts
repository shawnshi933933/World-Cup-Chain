import { eq, and } from "drizzle-orm";
import { db, parlaysTable, parlayLegsTable } from "@workspace/db";
import { checkMarketResolution, placePolymarketOrderWithRetry, getWalletBalanceUsdc } from "./polymarket";
import { resolvePolymarketCredentials, resolveMinBetUsdc } from "./credentials";
import { logger } from "./logger";

const GAS_FEE_USDC = 0.01;
// After payoutWaitSince is reached, retry delta check up to 3 times (every ~10 min, 30 min total)
const PAYOUT_RETRY_WINDOW_MS = 30 * 60 * 1000;

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

    // Take 3 balance snapshots at T+10, T+20, T+30 min (fire-and-forget, each overwrites previous).
    // Multiple reads guard against transient API errors; delay ensures CLOB reflects deduction.
    if (creds.walletAddress) {
      const credsCopy = { ...creds };
      for (const delayMin of [10, 20, 30]) {
        setTimeout(async () => {
          try {
            const balance = await getWalletBalanceUsdc(credsCopy);
            await db.update(parlaysTable)
              .set({ balanceSnapshotUsdc: balance.toString(), updatedAt: new Date() })
              .where(eq(parlaysTable.id, parlayId));
            logger.info({ parlayId, delayMin, balanceSnapshot: balance }, "Balance snapshot taken");
          } catch (err) {
            logger.warn({ err, parlayId, delayMin }, "Balance snapshot failed — fallback triggers at win detection");
          }
        }, delayMin * 60 * 1000);
      }
      logger.info({ parlayId }, "Balance snapshots scheduled at T+10, T+20, T+30 min");
    }
  }
}

export async function checkAndSettleActiveLeg(parlayId: number): Promise<void> {
  const [parlay] = await db.select().from(parlaysTable).where(eq(parlaysTable.id, parlayId));
  if (!parlay || parlay.status !== "active") return;

  // PHASE A: Wait until payoutWaitSince (= matchEndDate + 10 min), then check delta.
  // Retries every ~60s for up to 30 min (3 × 10-min windows). Gives up after that.
  if (!parlay.simulationMode && parlay.payoutWaitSince && parlay.balanceSnapshotUsdc) {
    const now = Date.now();
    const checkAt = parlay.payoutWaitSince.getTime();

    // Not time yet — skip silently until match end + 10 min
    if (now < checkAt) {
      logger.debug({ parlayId, waitMs: checkAt - now }, "Payout check not due yet — skipping");
      return;
    }

    const elapsedSinceCheckAt = now - checkAt;
    if (elapsedSinceCheckAt > PAYOUT_RETRY_WINDOW_MS) {
      logger.error({ parlayId, elapsedMs: elapsedSinceCheckAt }, "Payout delta not detected after 30 min retries — marking as error");
      await db.update(parlaysTable)
        .set({ status: "error", balanceSnapshotUsdc: null, payoutWaitSince: null, updatedAt: new Date() })
        .where(eq(parlaysTable.id, parlayId));
      return;
    }

    const creds = await resolvePolymarketCredentials();
    if (!creds?.walletAddress) return;

    const minBet = await resolveMinBetUsdc();
    const currentBalance = await getWalletBalanceUsdc(creds);
    const snapshotBalance = parseFloat(parlay.balanceSnapshotUsdc);
    const delta = currentBalance - snapshotBalance;

    logger.info({ parlayId, currentBalance, snapshotBalance, delta, minBet, elapsedSinceCheckAt }, "Checking payout delta");

    if (delta < minBet) {
      logger.info({ parlayId, delta, minBet }, "Delta not yet sufficient — will retry next poll");
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
    // Real mode — set payoutWaitSince to matchEndDate + 10 min so we only start
    // checking the delta after the match has ended and Polymarket has had time to settle.
    const creds = await resolvePolymarketCredentials();
    let extraUpdate: Record<string, any> = {};

    // Fallback snapshot if scheduled setTimeouts were lost (e.g. pm2 restart)
    if (!parlay.balanceSnapshotUsdc) {
      if (creds?.walletAddress) {
        const balanceNow = await getWalletBalanceUsdc(creds);
        extraUpdate.balanceSnapshotUsdc = balanceNow.toString();
        logger.warn({ parlayId, balanceNow }, "Balance snapshot missing — taking fallback snapshot at win detection");
      }
    }

    // payoutWaitSince = matchEndDate + 10 min (or now + 10 min if no end date)
    const matchEndDate = leg.marketEndDate ? new Date(leg.marketEndDate) : new Date();
    const payoutCheckAt = new Date(matchEndDate.getTime() + 10 * 60 * 1000);
    // If the match has already ended, check 10 min from now instead
    const effectiveCheckAt = payoutCheckAt < new Date()
      ? new Date(Date.now() + 10 * 60 * 1000)
      : payoutCheckAt;

    await db.update(parlaysTable)
      .set({ payoutWaitSince: effectiveCheckAt, updatedAt: new Date(), ...extraUpdate })
      .where(eq(parlaysTable.id, parlayId));
    logger.info(
      { parlayId, payoutCheckAt: effectiveCheckAt, balanceSnapshot: parlay.balanceSnapshotUsdc ?? extraUpdate.balanceSnapshotUsdc },
      "Leg won (real mode) — delta check scheduled"
    );
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
