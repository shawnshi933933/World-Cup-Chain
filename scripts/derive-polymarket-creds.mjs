/**
 * 一次性脚本：从 MetaMask 私钥派生 Polymarket L2 API 凭证
 *
 * 用法（在 Replit Shell 里执行）：
 *   node scripts/derive-polymarket-creds.mjs 0x你的私钥
 *
 * ⚠️  私钥只在本地使用，不会发送到任何服务器。
 *     运行完成后立刻把终端内容清除，不要截图传播。
 */

import { ethers } from "ethers";

const CLOB_HOST = "https://clob.polymarket.com";

async function main() {
  const privateKey = process.argv[2];
  if (!privateKey || !privateKey.startsWith("0x")) {
    console.error("❌  用法: node scripts/derive-polymarket-creds.mjs 0x<私钥>");
    process.exit(1);
  }

  const wallet = new ethers.Wallet(privateKey);
  const address = await wallet.getAddress();
  console.log("\n钱包地址:", address);

  // Polymarket L2 key derivation: sign the canonical nonce message
  const nonce = 0;
  const message = `This message attests that I control the given wallet\nnonce: ${nonce}`;
  const sig = await wallet.signMessage(message);

  // Derive key/secret/passphrase from signature bytes (Polymarket standard)
  const sigBytes = ethers.getBytes(sig);
  const apiKey     = ethers.hexlify(sigBytes.slice(0, 16)).slice(2);
  const secret     = ethers.hexlify(sigBytes.slice(16, 32)).slice(2);
  const passphrase = ethers.hexlify(sigBytes.slice(32, 48)).slice(2);

  // Verify with the CLOB endpoint
  console.log("\n正在向 Polymarket CLOB 验证...");
  const ts = Math.floor(Date.now() / 1000).toString();
  const hmacMsg = ts + "GET" + "/auth/api-key" + "";
  const { createHmac } = await import("crypto");
  let keyBuf;
  try { keyBuf = Buffer.from(secret, "base64"); } catch { keyBuf = Buffer.from(secret, "hex"); }
  const hmacSig = createHmac("sha256", keyBuf).update(hmacMsg).digest("base64");

  const r = await fetch(`${CLOB_HOST}/auth/api-key`, {
    headers: {
      "POLY_ADDRESS":    address,
      "POLY_API_KEY":    apiKey,
      "POLY_PASSPHRASE": passphrase,
      "POLY_SIGNATURE":  hmacSig,
      "POLY_TIMESTAMP":  ts,
    },
  });

  if (r.ok) {
    console.log("✅  验证成功！\n");
  } else {
    const body = await r.text();
    console.log(`\n⚠️  CLOB 验证返回 ${r.status}: ${body}`);
    console.log("凭证仍然输出，可能是账户未在 Polymarket 注册，请先用该钱包登录一次 polymarket.com\n");
  }

  console.log("════════════════════════════════════════");
  console.log("把以下 4 个值填入 Replit Secrets:");
  console.log("════════════════════════════════════════");
  console.log(`POLYMARKET_API_KEY    = ${apiKey}`);
  console.log(`POLYMARKET_SECRET     = ${secret}`);
  console.log(`POLYMARKET_PASSPHRASE = ${passphrase}`);
  console.log(`POLYMARKET_WALLET     = ${address}`);
  console.log("════════════════════════════════════════");
  console.log("\n⚠️  完成后请立刻清除终端（Ctrl+L），不要保存或截图私钥！");
}

main().catch(err => {
  console.error("错误:", err.message);
  process.exit(1);
});
