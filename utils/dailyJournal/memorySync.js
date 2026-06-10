function createDailyJournalMemorySync({
  config,
  strictClampText
}) {
  async function syncEpisodeMemory(userId, text, options = {}) {
    const uid = String(userId || '').trim();
    const content = strictClampText(text, Math.max(40, Number(options.maxChars) || 4000));
    if (!uid || !content) return null;
    if (config.MEMORY_V3_ENABLED === false) return null;
    const { appendJournalEpisodeEvent, scheduleJournalV3Refresh } = require('../memory-v3/journalPipeline');
    const event = await appendJournalEpisodeEvent({
      ...options,
      userId: uid,
      text: content,
      source: options.source || 'daily_journal',
      sourceKind: 'journal'
    });
    if (event && options.scheduleRefresh !== false) {
      scheduleJournalV3Refresh({
        userId: uid,
        days: [options.episodeDay, options.startDay, options.endDay].filter(Boolean),
        delayMs: options.delayMs,
        scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill,
        reason: options.refreshReason || 'journal_episode_event'
      });
    }
    return event;
  }

  function scheduleDailyJournalEmbeddingBackfill(userId, options = {}) {
    const uid = String(userId || '').trim();
    if (!uid || config.MEMORY_JOURNAL_EMBEDDING_BACKFILL_ENABLED === false) return false;
    try {
      const { scheduleJournalV3Refresh } = require('../memory-v3/journalPipeline');
      const result = scheduleJournalV3Refresh({
        userId: uid,
        days: Array.isArray(options.days) ? options.days : [],
        delayMs: options.delayMs,
        reason: options.reason || 'journal_embedding_backfill'
      });
      return result?.ok !== false;
    } catch (error) {
      console.warn('[daily_journal] failed to schedule embedding backfill:', error?.message || error);
      return false;
    }
  }

  function getMemoryChatCompletionsUrl() {
    const raw = String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(raw)) return raw;
    if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
    return raw;
  }

  function getMemoryModelName() {
    return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  }

  function getMemoryApiKey() {
    if (String(config.MEMORY_API_BASE_URL || '').trim()) {
      return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
    }
    return String(config.API_KEY || '').trim();
  }

  return {
    syncEpisodeMemory,
    scheduleDailyJournalEmbeddingBackfill,
    getMemoryChatCompletionsUrl,
    getMemoryModelName,
    getMemoryApiKey
  };
}

module.exports = {
  createDailyJournalMemorySync
};
