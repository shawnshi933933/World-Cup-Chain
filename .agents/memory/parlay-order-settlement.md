---
name: Parlay order & settlement design
description: Correct order type, snapshot timing, and settlement polling logic for the parlay engine.
---

## Order placement — use IOC, not GTC

**Rule:** Always use `OrderType.IOC` for parlay leg orders.

**Why:** GTC orders sit on the book unfilled if our bid is below the current ask (Gamma API mid-price ≠ CLOB ask). IOC fills what's available immediately and cancels the rest — no stale orders, and fill amount is in the response directly (no 20s wait-and-poll needed).

**How to apply:**
1. Before each attempt call `getBestAskPrice(tokenId, fallbackPrice)` — fetches `GET /book?token_id=X`, returns `asks[0].price`.
2. Place IOC at that price. Parse `result.size_matched * price` as `filledUsdc`.
3. If `filledUsdc === 0`, stop retrying (orderbook empty). Otherwise subtract from `remainingUsdc` and retry after 2s.
4. Max 3 attempts. Token info (tickSize, negRisk) fetched once and reused.

## Balance snapshot timing — after orders, not at win detection

**Rule:** Snapshot wallet USDC balance immediately after all IOC orders complete in `executeNextLeg`, not when the market resolves.

**Why:** Match can take hours. If snapshot is taken at win-detection time, any deposits the user made during the match inflate the snapshot and corrupt the payout delta calculation.

**How to apply:** In `executeNextLeg` (real mode), after updating the leg DB row, call `getWalletBalanceUsdc` and write to `parlays.balance_snapshot_usdc`. The win-detection code (`checkAndSettleActiveLeg`) only sets `payout_wait_since`; it does NOT overwrite the snapshot unless it's missing (fallback path for pre-update parlays).

## Settlement polling — skip during match, double-confirm resolution

**Rule:** Never poll `checkMarketResolution` before `leg.market_end_date`. After endDate, require 2 consecutive `resolved=true` responses before settling.

**Why:** Polling during the match wastes API calls and adds noise. Two confirmations guard against transient Polymarket API glitches returning a stale `resolved=true`.

**How to apply:**
- Store `market_end_date` in `parlay_legs` at creation (from market data `endDate`).
- `parlay_legs.resolved_confirm_count` tracks consecutive confirmations; reset to 0 on any `resolved=false` response.
- Settle only when `resolvedConfirmCount` reaches 2.

## Prod DB migration (parlay_legs)
```sql
ALTER TABLE parlay_legs ADD COLUMN IF NOT EXISTS market_end_date TIMESTAMPTZ;
ALTER TABLE parlay_legs ADD COLUMN IF NOT EXISTS resolved_confirm_count INTEGER NOT NULL DEFAULT 0;
```
