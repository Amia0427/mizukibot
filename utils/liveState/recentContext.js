function cleanText(value = '', maxChars = 100) {
  const compact = String(value || '').replace(/\s+/g, ' ').trim();
  if (!compact) return '';
  const limit = Math.max(1, Number(maxChars || 100) || 100);
  return compact.length > limit ? compact.slice(0, limit).trim() : compact;
}

function pickSummary(entry = {}) {
  return cleanText(
    entry.summary
    || entry.text
    || entry.content
    || entry.assistant
    || entry.user,
    100
  );
}

async function queryRecentEntries(userId, limit, deps = {}) {
  if (deps.dailyJournal && typeof deps.dailyJournal.queryRecent === 'function') {
    return deps.dailyJournal.queryRecent(userId, limit);
  }

  const dailyJournal = deps.dailyJournal || (() => {
    try {
      return require('../dailyJournal');
    } catch (_) {
      return null;
    }
  })();
  if (!dailyJournal) return [];

  if (typeof dailyJournal.queryRecent === 'function') {
    return dailyJournal.queryRecent(userId, limit);
  }
  if (typeof dailyJournal.collectRecentEntrySidecars === 'function') {
    return dailyJournal.collectRecentEntrySidecars(userId, { limit });
  }
  if (typeof dailyJournal.getRecentDailySummaries === 'function') {
    return dailyJournal.getRecentDailySummaries(userId, { limit });
  }
  return [];
}

async function getRecentContextSummary(userId, limit = 5, options = {}) {
  const result = await getRecentContextSummaryWithSource(userId, limit, options);
  return result.summary;
}

async function getRecentContextSummaryWithSource(userId, limit = 5, options = {}) {
  const baseSource = {
    sourceFile: 'utils/liveState/recentContext.js',
    sourcePolicy: 'getRecentContextSummary',
    readOnly: true,
    limit: Math.max(1, Number(limit || 5) || 5)
  };
  try {
    const entries = await Promise.race([
      queryRecentEntries(userId, limit, options),
      new Promise((resolve) => setTimeout(() => resolve([]), Math.max(1, Number(options.timeoutMs || 100) || 100)))
    ]);
    const normalizedEntries = Array.isArray(entries) ? entries : [];
    const summaries = normalizedEntries
      .map(pickSummary)
      .filter(Boolean)
      .slice(0, 3);
    if (summaries.length === 0) {
      return {
        summary: null,
        source: {
          ...baseSource,
          dataSource: 'daily_journal_recent_entries',
          found: false,
          entriesRead: normalizedEntries.length,
          summariesUsed: 0
        }
      };
    }
    return {
      summary: cleanText(summaries.join('；'), 300),
      source: {
        ...baseSource,
        dataSource: 'daily_journal_recent_entries',
        found: true,
        entriesRead: normalizedEntries.length,
        summariesUsed: summaries.length
      }
    };
  } catch (error) {
    if (options.logger && typeof options.logger.warn === 'function') {
      options.logger.warn('Recent context query failed, using empty context', {
        userId: String(userId || '').trim(),
        error: error?.message || String(error)
      });
    }
    return {
      summary: null,
      source: {
        ...baseSource,
        dataSource: 'daily_journal_recent_entries_error',
        found: false,
        error: error?.message || String(error)
      }
    };
  }
}

module.exports = {
  cleanText,
  getRecentContextSummary,
  getRecentContextSummaryWithSource
};
