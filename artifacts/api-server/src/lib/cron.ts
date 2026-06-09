import { pollAllActiveParlays } from "./parlay-engine";
import { logger } from "./logger";

const POLL_INTERVAL_MS = 60 * 1000; // 60 seconds
const WATCHDOG_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes
const MAX_POLL_SILENCE_MS = 3 * 60 * 1000; // restart if no poll in 3 minutes

let running = false;
let lastPollAt: number | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;

/** Schedule the next poll using recursive setTimeout (never stalls on a hung tick) */
function schedulePoll(): void {
  if (!running) return;
  setTimeout(async () => {
    if (!running) return;
    try {
      logger.debug("Polling active parlays for settlement");
      await pollAllActiveParlays();
    } catch (err) {
      logger.error({ err }, "Cron poll error");
    } finally {
      lastPollAt = Date.now();
      schedulePoll(); // always reschedule, even after an error
    }
  }, POLL_INTERVAL_MS);
}

/** Watchdog: if no poll has completed in MAX_POLL_SILENCE_MS, restart the scheduler */
function startWatchdog(): void {
  if (watchdogTimer) return;
  watchdogTimer = setInterval(() => {
    if (!running) return;
    const silence = lastPollAt ? Date.now() - lastPollAt : Infinity;
    if (silence > MAX_POLL_SILENCE_MS) {
      logger.warn({ silenceMs: silence }, "Cron watchdog: no recent poll detected — restarting scheduler");
      // Kick off an immediate poll and reschedule
      pollAllActiveParlays()
        .then(() => { lastPollAt = Date.now(); })
        .catch(err => logger.error({ err }, "Watchdog recovery poll error"))
        .finally(() => schedulePoll());
    }
  }, WATCHDOG_INTERVAL_MS);
}

export function startCron(): void {
  if (running) return;
  running = true;
  lastPollAt = Date.now(); // treat start as a poll to avoid immediate watchdog trigger
  logger.info("Starting parlay settlement cron (recursive scheduler + watchdog)");
  schedulePoll();
  startWatchdog();
}

export function stopCron(): void {
  running = false;
  if (watchdogTimer) {
    clearInterval(watchdogTimer);
    watchdogTimer = null;
  }
  logger.info("Stopped parlay settlement cron");
}
