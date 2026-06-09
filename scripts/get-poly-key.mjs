import { ethers } from "ethers";

const PRIVATE_KEY = process.env.POLY_WALLET_KEY;
if (!PRIVATE_KEY) {
  console.error("❌ 请先设置环境变量 POLY_WALLET_KEY");
  process.exit(1);
}

const wallet = new ethers.Wallet(PRIVATE_KEY);
const walletAddress = wallet.address;
console.log("钱包地址:", walletAddress);

const timestamp = Math.floor(Date.now() / 1000);
const nonce = 0;

const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
const types = {
  ClobAuth: [
    { name: "address",   type: "address" },
    { name: "timestamp", type: "string"  },
    { name: "nonce",     type: "uint256" },
    { name: "message",   type: "string"  },
  ],
};
const value = {
  address:   walletAddress,
  timestamp: String(timestamp),
  nonce,
  message:   "This message attests that I control the given wallet",
};

const signature = await wallet.signTypedData(domain, types, value);
console.log("签名:", signature);

const sigStripped = signature.replace(/^0x/, "");

const res = await fetch("https://clob.polymarket.com/auth/api-key", {
  method: "POST",
  headers: {
    "POLY_ADDRESS":   walletAddress,
    "POLY_SIGNATURE": sigStripped,
    "POLY_TIMESTAMP": String(timestamp),
    "POLY_NONCE":     String(nonce),
  },
});

const body = await res.json();
console.log("Polymarket 返回 (status", res.status + "):", JSON.stringify(body, null, 2));

if (!res.ok) {
  console.error("❌ 获取失败:", body.error);
  process.exit(1);
}

const { apiKey, secret, passphrase } = body;

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.log("\n✅ 成功！凭证如下（请手动保存）:");
  console.log("apiKey:", apiKey);
  console.log("secret:", secret);
  console.log("passphrase:", passphrase);
} else {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  const existing = await client.query("SELECT id FROM settings LIMIT 1");
  if (existing.rows.length > 0) {
    await client.query(
      `UPDATE settings SET wallet_address=$1, polymarket_api_key=$2, polymarket_secret=$3, polymarket_passphrase=$4, simulation_mode=false WHERE id=$5`,
      [walletAddress, apiKey, secret, passphrase, existing.rows[0].id]
    );
  } else {
    await client.query(
      `INSERT INTO settings (wallet_address, polymarket_api_key, polymarket_secret, polymarket_passphrase, simulation_mode) VALUES ($1,$2,$3,$4,false)`,
      [walletAddress, apiKey, secret, passphrase]
    );
  }
  await client.end();
  console.log("\n✅ 成功！凭证已写入数据库，模拟模式已关闭。");
}
