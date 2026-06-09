import { Router, type IRouter } from "express";
import healthRouter from "./health";
import marketsRouter from "./markets";
import parlaysRouter from "./parlays";
import settingsRouter from "./settings";
import authRouter from "./auth";

const router: IRouter = Router();

router.use(healthRouter);
router.use(marketsRouter);
router.use(parlaysRouter);
router.use(settingsRouter);
router.use(authRouter);

export default router;
