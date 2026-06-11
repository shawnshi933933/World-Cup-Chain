---
name: Polymarket order signing and parlay engine
description: Working config for POLY_1271 orders, balance checking, and parlay payout flow
---

## Rule
Use `@polymarket/clob-client-v2` TypeScript SDK for all order placement. Do NOT manually sign orders.

**Why:** POLY_1271 orders require ERC-7739-wrapped signatures. SDK handles wrapping internally.

## Working order config (confirmed June 2026)
- `signatureType = POLY_1271 (3)` for both TS and Python SDKs
- `funderAddress` = Deposit/Funder wallet from Polymarket Settings
- No explicit `maker`/`signer` override needed; SDK sets correctly via funder

## TypeScript SDK pattern
```typescript
const account = privateKeyToAccount(eoaPrivateKey);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });
const clob = new ClobClient({
  host: "https://clob.polymarket.com", chain: 137,
  signer: walletClient as any,
  creds: { key, secret, passphrase },
  signatureType: SignatureTypeV2.POLY_1271,
  funderAddress: depositWalletAddress,
});
const result = await clob.createAndPostOrder(
  { tokenID, price, size, side: Side.BUY },
  { tickSize: tickSize.toString(), negRisk },
  OrderType.GTC,
);
```

## Order retry logic (placePolymarketOrderWithRetry)
- max 3 attempts, 20s gap between checks
- Uses `(clob as any).getOrder(orderId)` → parses `size_matched * price`
- If getOrder unavailable, stops retrying (leaves GTC on book)
- Returns `{ orderIds: string[], totalFilledUsdc: number }`

## On-chain USDC balance (getWalletBalanceUsdc)
```typescript
// Checks both bridged + native USDC on Polygon, sums them
const USDC_BRIDGED = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";
const USDC_NATIVE  = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
// Uses viem createPublicClient + readContract(balanceOf, 6 decimals)
```

## Parlay balance-wait flow (real mode only)
1. Win detected → snapshot `balanceSnapshotUsdc` + set `payoutWaitSince` in DB
2. Next cron tick(s): `Δ = currentBalance - snapshot`
3. If `Δ >= minBetUsdc`: advance to next leg using `Δ` as next leg stake
4. Timeout 15 min → parlay errors
5. Uses actual received amount, not theoretical payout

**Why:** Polymarket auto-redeems winning tokens but may take 1–5 min. Payout is on-chain so we read USDC ERC-20 balance directly.

## Configurable minBetUsdc
- DB: `settings.min_bet_usdc TEXT DEFAULT '2'`
- Env: `MIN_BET_USDC`
- UI: settings page numeric input (0.5–1000, step 0.5)
- resolveMinBetUsdc() in credentials.ts

## DB columns added to parlays
- `balance_snapshot_usdc TEXT` — USDC balance at time of win detection
- `payout_wait_since TIMESTAMPTZ` — when waiting started (for timeout)

## Size units
`size` = conditional tokens = `sizeUsdc / price` (NOT USDC directly)

## Common errors
| Error | Cause | Fix |
|-------|-------|-----|
| "the order signer address..." | Wrong funder or signature_type | Use POLY_1271 + correct funder wallet |
| "market not found" on /tick-size | Token ID with 0x prefix | Token IDs are pure decimal |

## DB columns added to settings
- `min_bet_usdc TEXT NOT NULL DEFAULT '2'`

## balance-allowance
`updateBalanceAllowance` may be geo-blocked from HK (403). Wrap in try-catch; orders still work if balance previously synced.
