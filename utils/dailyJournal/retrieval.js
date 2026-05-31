function createDailyJournalRetrieval(deps = {}) {
  const config = deps.config || {};
  const {
    READ_LOG_FILE,
    appendJsonLine,
    collectDailySummaryItems,
    compareFourDayRollups,
    compareMonthlyRollups,
    formatDailyJournalBundleText,
    formatDateInTz,
    formatJournalEntries,
    getDailyJournalStats,
    getDailySummaryItem,
    getEntrySidecarFilePath,
    getJournalFilePath,
    getYearMonthFromDay,
    isValidDayString,
    listFourDayRollups,
    listMonthlyRollups,
    normalizeContinuitySnapshot,
    normalizeTimestampToDay,
    normalizeYearMonth,
    parseJournalEntries,
    readEntrySidecar,
    readJsonLines,
    safeReadText,
    selectMostRecentItems,
    filterInjectableJournalEntries,
    shiftDate,
    strictClampText
  } = deps;

  function buildEmptyRetrievalBundle(options = {}) {
    const byLayer = {
      daily: [],
      fourDay: [],
      monthly: []
    };
    if (options.includeActiveRaw) byLayer.activeRaw = [];
    const stats = {
      dailyCount: 0,
      fourDayCount: 0,
      monthlyCount: 0,
      totalChars: 0
    };
    if (options.includeActiveRaw) stats.activeRawCount = 0;
    return {
      text: '',
      items: [],
      byLayer,
      continuity: {
        sameSession: [],
        sameTopic: []
      },
      query: {
        lookbackDays: Math.max(1, Number(options.lookbackDays) || Number(config.DAILY_JOURNAL_LOOKBACK_DAYS) || 2),
        maxFourDayFiles: Math.max(0, Number(options.maxFourDayFiles) || Number(config.DAILY_JOURNAL_4DAY_PROMPT_MAX_FILES) || 0),
        maxMonthlyFiles: Math.max(0, Number(options.maxMonthlyFiles) || Number(config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0),
        timestamp: options.timestamp ?? null,
        day: options.day || '',
        yearMonth: options.yearMonth || ''
      },
      stats
    };
  }

  function buildActiveRawJournalItem(userId, day, options = {}) {
    const uid = String(userId || '').trim();
    if (!uid || !isValidDayString(day)) return null;
    const rawEntries = filterInjectableJournalEntries(parseJournalEntries(safeReadText(getJournalFilePath(uid, day), '')));
    if (rawEntries.length === 0) return null;

    const maxEntries = Math.max(1, Number(options.activeRawMaxEntries) || Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8);
    const sessionKey = String(options.sessionKey || '').trim();
    const sidecars = readEntrySidecar(uid, day).filter((item) => item?.journalWriteSkipped !== true && item?.unsafe !== true);
    const alignedSidecars = sidecars.length >= rawEntries.length
      ? sidecars.slice(-rawEntries.length)
      : Array.from({ length: rawEntries.length - sidecars.length }, () => null).concat(sidecars);
    const merged = rawEntries.map((entry, index) => {
      const sidecar = alignedSidecars[index] && typeof alignedSidecars[index] === 'object'
        ? alignedSidecars[index]
        : {};
      return {
        time: entry.time,
        user: entry.user,
        assistant: entry.assistant,
        ts: String(sidecar.ts || '').trim(),
        sessionKey: String(sidecar.sessionKey || '').trim(),
        source: 'journal_active_raw'
      };
    });

    const sessionEntries = sessionKey
      ? merged.filter((entry) => entry.sessionKey === sessionKey).slice(-maxEntries)
      : [];
    const selectedKeys = new Set(sessionEntries.map((entry) => `${entry.ts}|${entry.time}|${entry.user}|${entry.assistant}`));
    const backfillEntries = merged
      .filter((entry) => !selectedKeys.has(`${entry.ts}|${entry.time}|${entry.user}|${entry.assistant}`))
      .slice(-Math.max(0, maxEntries - sessionEntries.length));
    const selected = sessionEntries.concat(backfillEntries).slice(0, maxEntries);
    const text = strictClampText(
      formatJournalEntries(selected),
      Math.max(600, Number(config.MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS || 160) * 12)
    );
    if (!text) return null;
    return {
      kind: 'active_raw',
      day,
      text,
      entries: selected,
      source: 'journal_active_raw'
    };
  }

  function matchSidecarEntries(entries = [], options = {}) {
    const sessionKey = String(options.sessionKey || '').trim();
    const topicNeedle = String(options.topic || '').trim().toLowerCase();
    const matchedSession = [];
    const matchedTopic = [];

    for (const entry of Array.isArray(entries) ? entries : []) {
      const snapshot = entry && typeof entry === 'object' ? normalizeContinuitySnapshot(entry.continuitySnapshot) : normalizeContinuitySnapshot();
      const activeTopic = String(snapshot.activeTopic || '').trim().toLowerCase();
      const carry = String(snapshot.carryOverUserTurn || '').trim().toLowerCase();
      if (sessionKey && String(entry.sessionKey || '').trim() === sessionKey) {
        matchedSession.push({ ...entry, continuitySnapshot: snapshot });
      }
      if (topicNeedle && (activeTopic.includes(topicNeedle) || carry.includes(topicNeedle))) {
        matchedTopic.push({ ...entry, continuitySnapshot: snapshot });
      }
    }

    return {
      sameSession: matchedSession,
      sameTopic: matchedTopic
    };
  }

  function nowMs() {
    return Date.now();
  }

  function shouldLogDailyJournalReads() {
    return Boolean(config.DAILY_JOURNAL_READ_LOG_ENABLED);
  }

  function hashText(text) {
    let hash = 2166136261;
    const input = String(text || '');
    for (let i = 0; i < input.length; i += 1) {
      hash ^= input.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return `fnv1a_${(hash >>> 0).toString(16)}`;
  }

  function logDailyJournalRead(event = {}) {
    if (!shouldLogDailyJournalReads()) return;
    appendJsonLine(READ_LOG_FILE, {
      ts: new Date().toISOString(),
      ...event
    });
  }

  function getDailyJournalRetrievalBundle(userId, options = {}) {
    const startedAt = nowMs();
    const uid = String(userId || '').trim();
    if (!uid || !config.DAILY_JOURNAL_ENABLED) {
      return buildEmptyRetrievalBundle(options);
    }

    const lookbackDays = Math.max(1, Number(options.lookbackDays || options.dailyLookbackDays) || Number(config.DAILY_JOURNAL_LOOKBACK_DAYS) || 2);
    const maxFourDayFiles = Math.max(0, Number(options.maxFourDayFiles) || Number(config.DAILY_JOURNAL_4DAY_PROMPT_MAX_FILES) || 0);
    const maxMonthlyFiles = Math.max(0, Number(options.maxMonthlyFiles) || Number(config.DAILY_JOURNAL_MONTHLY_PROMPT_MAX_FILES) || 0);
    const targetDay = normalizeTimestampToDay(options.timestamp);
    const targetYearMonth = normalizeYearMonth(options.yearMonth);
    const includeActiveRaw = Boolean(options.includeActiveRaw);
    const activeRawDay = targetDay || formatDateInTz(new Date(), config.TIMEZONE);

    let activeRawItems = [];
    let dailyItems = [];
    let fourDayItems = [];
    let monthlyItems = [];

    if (targetYearMonth) {
      monthlyItems = listMonthlyRollups(uid).filter((item) => item.yearMonth === targetYearMonth);
    } else if (targetDay) {
      const dailyItem = getDailySummaryItem(uid, targetDay);
      if (dailyItem) dailyItems.push(dailyItem);

      if (config.DAILY_JOURNAL_4DAY_ENABLED) {
        const hit = listFourDayRollups(uid).find((item) => item.startDay <= targetDay && item.endDay >= targetDay);
        if (hit) fourDayItems.push(hit);
      }

      if (config.DAILY_JOURNAL_MONTHLY_ENABLED && maxMonthlyFiles > 0) {
        monthlyItems = selectMostRecentItems(
          listMonthlyRollups(uid).filter((item) => item.yearMonth === getYearMonthFromDay(targetDay)),
          maxMonthlyFiles,
          compareMonthlyRollups
        );
      }
    } else {
      const today = formatDateInTz(new Date(), config.TIMEZONE);
      const days = [];
      for (let i = 0; i < lookbackDays; i += 1) {
        days.push(shiftDate(today, -i));
      }

      dailyItems = collectDailySummaryItems(uid, days);
      if (config.DAILY_JOURNAL_4DAY_ENABLED && maxFourDayFiles > 0) {
        fourDayItems = selectMostRecentItems(listFourDayRollups(uid), maxFourDayFiles, compareFourDayRollups);
      }
      if (config.DAILY_JOURNAL_MONTHLY_ENABLED && maxMonthlyFiles > 0) {
        monthlyItems = selectMostRecentItems(listMonthlyRollups(uid), maxMonthlyFiles, compareMonthlyRollups);
      }
    }

    dailyItems = dailyItems.slice().sort((a, b) => a.day.localeCompare(b.day));
    fourDayItems = fourDayItems.slice().sort(compareFourDayRollups);
    monthlyItems = monthlyItems.slice().sort(compareMonthlyRollups);
    if (includeActiveRaw) {
      const activeRawItem = buildActiveRawJournalItem(uid, activeRawDay, options);
      activeRawItems = activeRawItem ? [activeRawItem] : [];
    }

    const items = [...activeRawItems, ...dailyItems, ...fourDayItems, ...monthlyItems];
    const continuityEntries = items
      .flatMap((item) => Array.isArray(item.sidecarEntries) ? item.sidecarEntries : [])
      .filter((item) => item?.journalWriteSkipped !== true && item?.unsafe !== true);
    const continuity = matchSidecarEntries(continuityEntries, {
      sessionKey: options.sessionKey,
      topic: options.topic || options.question || ''
    });
    const byLayer = {
      daily: dailyItems,
      fourDay: fourDayItems,
      monthly: monthlyItems
    };
    if (includeActiveRaw) byLayer.activeRaw = activeRawItems;
    const resultStats = {
      dailyCount: dailyItems.length,
      fourDayCount: fourDayItems.length,
      monthlyCount: monthlyItems.length,
      totalChars: items.reduce((sum, item) => sum + String(item.text || '').length, 0)
    };
    if (includeActiveRaw) resultStats.activeRawCount = activeRawItems.length;
    const result = {
      text: formatDailyJournalBundleText(items),
      items,
      byLayer,
      continuity,
      query: {
        lookbackDays,
        maxFourDayFiles,
        maxMonthlyFiles,
        timestamp: options.timestamp ?? null,
        day: targetDay,
        yearMonth: targetYearMonth || getYearMonthFromDay(targetDay)
      },
      stats: resultStats
    };

    const stats = getDailyJournalStats(uid, lookbackDays);
    logDailyJournalRead({
      userId: uid,
      lookbackDays,
      durationMs: nowMs() - startedAt,
      queryHash: hashText(result.text),
      queryMode: targetYearMonth ? 'yearMonth' : (targetDay ? 'timestamp' : 'default'),
      day: targetDay,
      yearMonth: result.query.yearMonth,
      selectedDays: dailyItems.length,
      selectedKinds: items.map((item) => item.kind || 'unknown'),
      totalSegments: stats.totalSegments,
      totalSegmentEntries: stats.totalSegmentEntries,
      rawTailEntries: stats.rawTailEntries,
      summaryChars: stats.summaryChars,
      segmentChars: stats.segmentChars,
      rawTailChars: stats.rawTailChars,
      activeRawCount: activeRawItems.length,
      fourDayCount: fourDayItems.length,
      monthlyCount: monthlyItems.length
    });

    return result;
  }

  return {
    buildActiveRawJournalItem,
    buildEmptyRetrievalBundle,
    getDailyJournalRetrievalBundle,
    hashText,
    logDailyJournalRead,
    matchSidecarEntries,
    nowMs,
    shouldLogDailyJournalReads
  };
}

module.exports = {
  createDailyJournalRetrieval
};
