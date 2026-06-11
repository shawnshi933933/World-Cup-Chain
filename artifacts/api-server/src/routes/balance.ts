import { Router, type IRouter } from "express";
import { getWalletBalanceUsdc } from "../lib/polymarket";
import { resolvePolymarketCredentials } from "../lib/credentials";

const router: IRouter = Router();

router.get("/balance", async (req, res): Promise<void> => {
  try {
    const creds = await resolvePolymarketCredentials();
    if (!creds?.walletAddress) {
      res.json({ balanceUsdc: null, walletAddress: null });
      return;
    }
    const balanceUsdc = await getWalletBalanceUsdc(creds);
    res.json({ balanceUsdc, walletAddress: creds.walletAddress });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch balance" });
  }
});

export default router;
