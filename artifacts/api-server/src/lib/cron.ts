import { pollAllActiveParlays } from "./parlay-engine";
import { logger } from "./logger";

let cronInterval: ReturnType<typeof setInterval> | null = null;

export function startCron(): void {
  if (cronInterval) return;

  const POLL_INTERVAL_MS = 60 * 1000; // every 60 seconds

  logger.info("Starting parlay settlement cron job");

  cronInterval = setInterval(async () => {
    try {
      logger.debug("Polling active parlays for settlement");
      await pollAllActiveParlays();
    } catch (err) {
      logger.error({ err }, "Cron poll error");
    }
  }, POLL_INTERVAL_MS);
}

export function stopCron(): void {
  if (cronInterval) {
    clearInterval(cronInterval);
    cronInterval = null;
    logger.info("Stopped parlay settlement cron job");
  }
}
