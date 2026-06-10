---
name: Polymarket order signing
description: Working configuration for placing Polymarket CLOB orders with POLY_1271 proxy wallet setup
---

## Rule
Use `@polymarket/clob-client-v2` TypeScript SDK for all order placement. Do NOT manually sign orders with ethers/viem signTypedData.

**Why:** POLY_1271 orders require ERC-7739-wrapped signatures. `signTypedData` produces the wrong format. The SDK handles wrapping internally.

## Working config (confirmed June 2026)

- `signatureType = POLY_1271 (3)` for both TS and Python SDKs
- `key / signer` = EOA private key
- `funderAddress` = the Deposit/Funder wallet shown in Polymarket Settings — **NOT necessarily the wallet shown in MetaMask or UI**. Must use the address that was active when `create_or_derive_api_key()` was called.
- No explicit `maker`/`signer` override needed in `create_and_post_order` — SDK handles correctly with funder set.

## TypeScript SDK pattern
```typescript
const account = privateKeyToAccount(eoaPrivateKey);
const walletClient = createWalletClient({ account, chain: polygon, transport: http() });

const clob = new ClobClient({
  host: "https://clob.polymarket.com",
  chain: 137,
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
// result.orderID, result.success, result.status === 'live'
```

## Python SDK pattern (py_clob_client_v2)
```python
client = ClobClient(host, key=PRIVATE_KEY, chain_id=137,
                    creds=creds, signature_type=SignatureTypeV2.POLY_1271, funder=DEPOSIT_WALLET)
resp = client.create_and_post_order(
    order_args=OrderArgs(token_id=TOKEN, price=0.69, size=5, side=Side.BUY),
    options=PartialCreateOrderOptions(
        tick_size=client.get_tick_size(TOKEN),
        neg_risk=client.get_neg_risk(TOKEN)
    ),
    order_type=OrderType.GTC
)
# Success: {'errorMsg': '', 'orderID': '0x...', 'status': 'live', 'success': True}
```

## API key derivation
```python
temp = ClobClient(host, key=PK, chain_id=137,
                  signature_type=SignatureTypeV2.POLY_1271, funder=DEPOSIT_WALLET)
creds = temp.create_or_derive_api_key()  # returns ApiCreds object (not dict)
# Use creds.api_key, creds.api_secret, creds.api_passphrase
```

## Size units
`size` = conditional tokens to buy = `sizeUsdc / price` (NOT the USDC amount directly)

## Token IDs
Large decimal integers — NO `0x` prefix. Fetch from DB:
`SELECT title, outcomes FROM markets_cache WHERE title ILIKE '%team%';`
The `outcomes` JSONB column has `tokenId` per outcome.

## Common errors
| Error | Cause | Fix |
|-------|-------|-----|
| "the order signer address has to be the address of the API KEY" | Wrong funder address or signature_type | Use POLY_1271 + correct funder wallet |
| "market not found" on /tick-size | Wrong token_id (0x prefix added) | Token IDs are pure decimal |
| "Invalid asset type" on get_balance_allowance | Missing param | Pass `params={"asset_type": COLLATERAL}` |
| `ClobClient` has no attribute 'key' | SDK v2 doesn't expose .key | Derive EOA address via eth_account separately |

## DB column
Settings table needs `polymarket_private_key TEXT`:
`ALTER TABLE settings ADD COLUMN IF NOT EXISTS polymarket_private_key TEXT;`

## Tick size / neg_risk
Fetch per token before placing — use SDK `clob.getTickSize(tokenID)` / `clob.getNegRisk(tokenID)` with fallback to manual HTTP:
- `GET https://clob.polymarket.com/tick-size?token_id=...`
- `GET https://clob.polymarket.com/neg-risk?token_id=...`

## balance-allowance
`updateBalanceAllowance` may be geo-blocked from HK (403). Wrap in try-catch; orders can still succeed if balance was previously synced.
