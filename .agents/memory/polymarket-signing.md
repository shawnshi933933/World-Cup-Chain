---
name: Polymarket order signing
description: Correct approach for EIP-712 order signing on Polymarket CLOB API
---

## Rule
Use `signature_type=3` (POLY_1271) for signing orders. The `secret` field from API credentials (URL-safe base64-decoded) IS the 32-byte L2 private key — no separate wallet private key is needed.

**Why:** Polymarket uses proxy wallets (ERC-1271) for newer accounts. The L2 key is derived from the L1 wallet by signing an EIP-712 message during credential creation. The encoded result is stored as `api_secret`. Python SDK reference code confirms `signature_type=3` and that `ClobClient(key=PRIVATE_KEY, funder=DEPOSIT_WALLET_ADDRESS)` uses L2 signing.

**How to apply:**
```typescript
const normalized = secret.replace(/-/g, '+').replace(/_/g, '/');
const l2KeyBytes = Buffer.from(normalized, 'base64');
const l2Wallet = new ethers.Wallet('0x' + l2KeyBytes.toString('hex'));
// maker = walletAddress (funder), signer = l2Wallet.address, signatureType = 3
```
Always fetch `tick_size` and `neg_risk` from CLOB API per token before placing order:
- `GET https://clob.polymarket.com/tick-size?token_id=...`
- `GET https://clob.polymarket.com/neg-risk?token_id=...`
Round price to nearest tick or get INVALID_ORDER_MIN_TICK_SIZE.
