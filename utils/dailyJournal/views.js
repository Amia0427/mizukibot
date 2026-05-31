function createDailyJournalViews(deps = {}) {
  const {
    compareFourDayRollups,
    compareMonthlyRollups,
    config,
    formatDateInTz,
    formatJournalEntries,
    fs,
    getJournalFilePath,
    getJournalIndex: getStoredJournalIndex,
    getSummaryFilePath,
    getUserJournalDir,
    isValidDayString,
    listFourDayRollupsFromDisk,
    listMonthlyRollupsFromDisk,
    listUserSummaryDaysFromDisk,
    normalizeJournalIndex,
    parseJournalEntries,
    readEntrySidecar,
    readSegmentSummaries,
    safeReadText,
    filterInjectableJournalEntries,
    shiftDate,
    strictClampText
  } = deps;

  function scanJournalIndex(userId) {
    const uid = String(userId || '').trim();
    const summaryDays = listUserSummaryDaysFromDisk(uid);
    const fourDayRollups = listFourDayRollupsFromDisk(uid).map((item) => ({
      startDay: item.startDay,
      endDay: item.endDay,
      yearMonth: item.yearMonth,
      filePath: item.filePath
    }));
    const monthlyRollups = listMonthlyRollupsFromDisk(uid).map((item) => ({
      yearMonth: item.yearMonth,
      part: item.part,
      filePath: item.filePath
    }));
    return normalizeJournalIndex({
      updatedAt: Date.now(),
      summaryDays,
      fourDayRollups,
      monthlyRollups
    });
  }

  function getJournalIndex(userId) {
    return getStoredJournalIndex(userId, scanJournalIndex);
  }

  function listUserSummaryDays(userId) {
    return getJournalIndex(userId).summaryDays.slice();
  }

  function listFourDayRollups(userId) {
    const index = getJournalIndex(userId);
    return index.fourDayRollups
      .map((item) => {
        const text = safeReadText(item.filePath, '').trim();
        if (!text) return null;
        return {
          kind: 'four_day_rollup',
          startDay: item.startDay,
          endDay: item.endDay,
          yearMonth: item.yearMonth,
          sourceCount: 4,
          filePath: item.filePath,
          text
        };
      })
      .filter(Boolean)
      .sort(compareFourDayRollups);
  }

  function listMonthlyRollups(userId) {
    const index = getJournalIndex(userId);
    return index.monthlyRollups
      .map((item) => {
        const text = safeReadText(item.filePath, '').trim();
        if (!text) return null;
        return {
          kind: 'monthly_rollup',
          yearMonth: item.yearMonth,
          part: item.part,
          sourceCount: 7,
          filePath: item.filePath,
          text
        };
      })
      .filter(Boolean)
      .sort(compareMonthlyRollups);
  }

  function getDailySummaryItem(userId, day) {
    const uid = String(userId || '').trim();
    if (!uid || !isValidDayString(day)) return null;
    const sidecarEntries = readEntrySidecar(uid, day).filter((item) => item?.journalWriteSkipped !== true && item?.unsafe !== true);

    const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
    if (summaryText) {
      return { day, text: summaryText, kind: 'daily_summary', sidecarEntries };
    }

    const segments = readSegmentSummaries(uid, day);
    if (segments.length > 0) {
      const merged = segments.map((item) => item.text).join('\n').trim();
      if (merged) {
        return { day, text: merged, kind: 'segments', segments, sidecarEntries };
      }
    }

    const rawEntries = filterInjectableJournalEntries(parseJournalEntries(safeReadText(getJournalFilePath(uid, day), '')));
    if (rawEntries.length > 0) {
      const keepTail = Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8);
      const rawText = strictClampText(formatJournalEntries(rawEntries.slice(-keepTail)), Math.max(600, Number(config.MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS || 160) * 12));
      if (rawText) {
        return {
          day,
          text: rawText,
          kind: 'raw_journal',
          rawEntries: rawEntries.length,
          sidecarEntries
        };
      }
    }

    return null;
  }

  function collectDailySummaryItems(userId, days = []) {
    const uid = String(userId || '').trim();
    return (Array.isArray(days) ? days : [])
      .map((day) => getDailySummaryItem(uid, day))
      .filter(Boolean)
      .sort((a, b) => a.day.localeCompare(b.day));
  }

  function listUserJournalDays(userId) {
    const dir = getUserJournalDir(userId);
    if (!fs.existsSync(dir)) return [];

    return fs.readdirSync(dir)
      .filter((name) => /^\d{4}-\d{2}-\d{2}\.journal\.md$/i.test(name))
      .map((name) => name.slice(0, 10))
      .sort();
  }

  function getDailyJournalStats(userId, lookbackDays = config.DAILY_JOURNAL_LOOKBACK_DAYS) {
    const uid = String(userId || '').trim();
    if (!uid || !config.DAILY_JOURNAL_ENABLED) {
      return {
        userId: uid,
        lookbackDays: Math.max(1, Number(lookbackDays) || 2),
        totalDays: 0,
        daysWithSummary: 0,
        daysWithSegments: 0,
        totalSegments: 0,
        totalSegmentEntries: 0,
        rawTailEntries: 0,
        summaryChars: 0,
        segmentChars: 0,
        rawTailChars: 0
      };
    }

    const today = formatDateInTz(new Date(), config.TIMEZONE);
    const count = Math.max(1, Number(lookbackDays) || 2);
    const days = [];
    for (let i = 0; i < count; i += 1) {
      days.push(shiftDate(today, -i));
    }

    const stats = {
      userId: uid,
      lookbackDays: count,
      totalDays: days.length,
      daysWithSummary: 0,
      daysWithSegments: 0,
      totalSegments: 0,
      totalSegmentEntries: 0,
      rawTailEntries: 0,
      summaryChars: 0,
      segmentChars: 0,
      rawTailChars: 0
    };

    for (const day of days) {
      const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
      if (summaryText) {
        stats.daysWithSummary += 1;
        stats.summaryChars += summaryText.length;
      }

      const segments = readSegmentSummaries(uid, day);
      if (segments.length > 0) {
        stats.daysWithSegments += 1;
        stats.totalSegments += segments.length;
        stats.totalSegmentEntries += segments.reduce((sum, item) => sum + (Number(item.entryCount || 0) || 0), 0);
        stats.segmentChars += segments.reduce((sum, item) => sum + String(item.text || '').length, 0);
      }

      const rawEntries = filterInjectableJournalEntries(parseJournalEntries(safeReadText(getJournalFilePath(uid, day), '')));
      stats.rawTailEntries += rawEntries.length;
      stats.rawTailChars += rawEntries.reduce((sum, item) => {
        return sum + String(item.user || '').length + String(item.assistant || '').length;
      }, 0);
    }

    return stats;
  }

  function createRecentDailySummariesGetter(getDailyJournalRetrievalBundle) {
    return function getRecentDailySummaries(userId, lookbackDays = config.DAILY_JOURNAL_LOOKBACK_DAYS) {
      const bundle = getDailyJournalRetrievalBundle(userId, { lookbackDays });
      return {
        text: bundle.byLayer.daily.map((item) => `[${item.day}]\n${item.text}`).join('\n\n'),
        items: bundle.byLayer.daily
      };
    };
  }

  return {
    collectDailySummaryItems,
    createRecentDailySummariesGetter,
    getDailyJournalStats,
    getDailySummaryItem,
    getJournalIndex,
    listFourDayRollups,
    listMonthlyRollups,
    listUserJournalDays,
    listUserSummaryDays,
    scanJournalIndex
  };
}

module.exports = {
  createDailyJournalViews
};
