---
name: Polymarket POLY_1271 deposit wallet signing
description: How to correctly sign and place orders using the deposit wallet (POLY_1271) flow
---

## Rule
Use `@polymarket/clob-client-v2` TypeScript SDK for all order placement. Do NOT manually sign orders with ethers/viem signTypedData.

**Why:** POLY_1271 orders require ERC-7739-wrapped signatures that are longer than standard ECDSA. `signTypedData` produces the wrong format. The SDK handles ERC-7739 wrapping internally.

## Key address distinction
- **EOA / owner**: `0x67fb9e2b7e59c749035e7124e8b8b9f2e9658fbd` — derived from private key; used as signing key only
- **Deposit wallet**: `0xe6B765193A1d37E722A35338674BDAD190C69B24` — ERC-1967 proxy contract; holds pUSD; goes in both `maker` AND `signer` fields of the order

## Order fields (POLY_1271)
- `maker` = deposit wallet address
- `signer` = deposit wallet address (SAME as maker — NOT the EOA)
- `signatureType` = 3
- Actual signing key = EOA private key (via viem WalletClient)
- `POLY_ADDRESS` L2 header = EOA address (SDK sets automatically)

## SDK usage pattern
```typescript
import { ClobClient, OrderType, Side, SignatureTypeV2 } from "@polymarket/clob-client-v2";
import { createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";

const account = privateKeyToAccount(eoaPrivateKey);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

const clob = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: 137,
  signer: walletClient as any,
  creds: { key, secret, passphrase },
  signatureType: SignatureTypeV2.POLY_1271,
  funderAddress: depositWalletAddress,  // 0xe6B765...
});

const result = await clob.createAndPostOrder(
  { tokenID, price, size, side: Side.BUY },
  { tickSize, negRisk },
  OrderType.GTC,
);
```

## Size units
`size` parameter = conditional tokens to buy = `sizeUsdc / price` (NOT USDC amount directly)

## DB column
Settings table needs `polymarket_private_key TEXT`. On new DBs run:
`ALTER TABLE settings ADD COLUMN IF NOT EXISTS polymarket_private_key TEXT;`

## Tick size / neg_risk
Still fetch from CLOB API per token before placing:
- `GET https://clob.polymarket.com/tick-size?token_id=...`
- `GET https://clob.polymarket.com/neg-risk?token_id=...`
Round price to nearest tick or get INVALID_ORDER_MIN_TICK_SIZE error.

## balance-allowance endpoint
`updateBalanceAllowance` may be geo-blocked from HK (403). Wrap in try-catch; orders can still succeed if balance was previously synced.
