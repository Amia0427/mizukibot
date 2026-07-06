const config = require('../config');
const {
  runDailyJournalSummaries,
  shouldRunDailySummaryNow
} = require('../utils/dailyJournal');

function startDailyJournalSummaryScheduler(options = {}) {
  if (!config.DAILY_JOURNAL_ENABLED || !config.DAILY_JOURNAL_SUMMARY_SCHEDULER_ENABLED) {
    return { stop() {} };
  }

  let stopped = false;
  let timer = null;
  let running = false;
  const intervalMs = Math.max(60 * 1000, Number(config.DAILY_JOURNAL_SUMMARY_SCHEDULER_INTERVAL_MS) || 10 * 60 * 1000);
  const logger = options.logger || console;

  async function runOnce(date = new Date()) {
    if (stopped || running || !shouldRunDailySummaryNow(date)) return null;
    running = true;
    try {
      return await runDailyJournalSummaries();
    } catch (error) {
      logger.error?.('[daily_journal] summary scheduler failed:', error?.message || error);
      return null;
    } finally {
      running = false;
    }
  }

  function schedule(delayMs = intervalMs) {
    if (stopped) return;
    timer = setTimeout(() => {
      timer = null;
      void runOnce().finally(() => schedule(intervalMs));
    }, Math.max(0, Number(delayMs) || 0));
    timer.unref?.();
  }

  schedule(0);
  logger.log?.(`[daily_journal] summary scheduler armed: interval ${Math.floor(intervalMs / 60000)}m`);

  return {
    runOnce,
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    }
  };
}

module.exports = {
  startDailyJournalSummaryScheduler
};
