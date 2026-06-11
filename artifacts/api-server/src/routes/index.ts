import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketsRouter from "./markets";
import parlaysRouter from "./parlays";
import settingsRouter from "./settings";
import authRouter from "./auth";
import balanceRouter from "./balance";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketsRouter);
router.use(parlaysRouter);
router.use(settingsRouter);
router.use(authRouter);
router.use(balanceRouter);

export default router;
