function createDailyJournalSummaryRunner(deps = {}) {
  const {
    appendPerfEvent,
    atomicWriteText,
    buildUserSnapshot,
    config,
    extractMessageContent,
    favorites,
    formatDateInTz,
    formatJournalEntries,
    getBackgroundPressureDelayMs,
    getDatePartsInTz,
    getJournalFilePath,
    getMemoryApiKey,
    getMemoryChatCompletionsUrl,
    getMemoryModelName,
    getSummaryFilePath,
    getYearMonthFromDay,
    loadSummaryState,
    maintainDailyJournalRollups,
    parseJournalEntries,
    postWithRetry,
    readSegmentSummaries,
    safeReadText,
    saveSummaryState,
    scheduleDailyJournalEmbeddingBackfill,
    shiftDate,
    strictClampText,
    syncEpisodeMemory,
    updateJournalIndex,
    sortUniqueStrings
  } = deps;

  async function summarizeJournalForDay(userId, day) {
    const uid = String(userId || '').trim();
    if (!uid || !day || !config.DAILY_JOURNAL_ENABLED) return '';

    const summaryText = safeReadText(getSummaryFilePath(uid, day), '').trim();
    if (summaryText) return summaryText;

    const segments = readSegmentSummaries(uid, day);
    const journalText = safeReadText(getJournalFilePath(uid, day), '').trim();
    const activeEntries = parseJournalEntries(journalText);
    const activeText = formatJournalEntries(activeEntries.slice(-Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8)));

    const sourceParts = [];
    if (segments.length > 0) {
      sourceParts.push(`Segment summaries:\n${segments.map((item) => `- ${item.text}`).join('\n')}`);
    }
    if (activeText) {
      sourceParts.push(`Recent raw entries:\n${activeText}`);
    }

    const sourceText = sourceParts.join('\n\n').trim();
    if (!sourceText) return '';

    const maxTokens = Math.max(400, Number(config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS) || 2500);
    const prompt = [
      'You are compressing one day of user interaction into durable daily memory.',
      'Prefer durable preferences, commitments, decisions, progress, blockers, emotional shifts, and follow-up topics.',
      'Use the segment summaries as the primary source and only use recent raw entries as a supplement.',
      'Drop filler chatter and repeated phrasing.',
      'Return plain text only.'
    ].join('\n');

    const resp = await postWithRetry(
      getMemoryChatCompletionsUrl(),
      {
        model: getMemoryModelName(),
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'system', content: prompt },
          {
            role: 'system',
            content: `User snapshot:\n${buildUserSnapshot(uid)}`
          },
          {
            role: 'user',
            content: `Day: ${day}\n\n${sourceText}`
          }
        ],
        max_tokens: maxTokens,
        stream: false
      },
      Math.max(0, Number(config.AI_RETRIES) || 0),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    return String(msg?.content || msg?.text || '').trim();
  }

  function shouldRunDailySummaryNow(date = new Date()) {
    if (!config.DAILY_JOURNAL_ENABLED) return false;
    const parts = getDatePartsInTz(date, config.TIMEZONE);
    const hour = Math.max(0, Math.min(23, Number(config.DAILY_JOURNAL_SUMMARY_HOUR) || 0));
    const minute = Math.max(0, Math.min(59, Number(config.DAILY_JOURNAL_SUMMARY_MINUTE) || 10));
    return (parts.hour > hour) || (parts.hour === hour && parts.minute >= minute);
  }

  async function runDailyJournalSummaries(options = {}) {
    if (!config.DAILY_JOURNAL_ENABLED) return { ran: false, count: 0 };
    const pressureDelayMs = getBackgroundPressureDelayMs();
    if (pressureDelayMs > 0 && !options.force) {
      appendPerfEvent({
        category: 'background_pressure',
        type: 'daily_journal_summary_deferred',
        delayMs: pressureDelayMs
      });
      return { ran: false, count: 0, reason: 'resource_pressure_deferred', deferMs: pressureDelayMs };
    }

    const state = loadSummaryState();
    const today = formatDateInTz(new Date(), config.TIMEZONE);
    const targetDay = shiftDate(today, -1);

    if (!targetDay) return { ran: false, count: 0 };
    if (!options.force && state.last_day === targetDay) {
      return { ran: false, count: 0 };
    }

    let count = 0;
    let hadFailure = false;
    let fourDayCreated = 0;
    let monthlyCreated = 0;
    for (const userId of Object.keys(favorites || {})) {
      const journalText = safeReadText(getJournalFilePath(userId, targetDay), '').trim();
      const segments = readSegmentSummaries(userId, targetDay);

      try {
        if (journalText || segments.length > 0) {
          const summary = typeof options.summarySummarizer === 'function'
            ? strictClampText(
              await options.summarySummarizer({ userId, day: targetDay, journalText, segments }),
              Math.max(40, Number(config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS) || 2500)
            )
            : await summarizeJournalForDay(userId, targetDay);
          if (summary) {
            atomicWriteText(getSummaryFilePath(userId, targetDay), `${summary}\n`);
            updateJournalIndex(userId, (index) => ({
              ...index,
              summaryDays: sortUniqueStrings([...(index.summaryDays || []), targetDay])
            }));
            await syncEpisodeMemory(userId, summary, {
              source: 'daily_journal_summary',
              rollupLevel: 'daily',
              episodeDay: targetDay,
              yearMonth: getYearMonthFromDay(targetDay),
              sourceFile: getSummaryFilePath(userId, targetDay),
              textKind: 'journal_daily_summary',
              maxChars: config.DAILY_JOURNAL_SUMMARY_MAX_TOKENS
            });
            scheduleDailyJournalEmbeddingBackfill(userId, { days: [targetDay] });
            count += 1;
          }
        }

        const rollupResult = await maintainDailyJournalRollups(userId, options);
        fourDayCreated += Number(rollupResult?.fourDayCreated || 0);
        monthlyCreated += Number(rollupResult?.monthlyCreated || 0);
      } catch (error) {
        hadFailure = true;
        console.error('[daily_journal] failed to summarize day:', {
          userId,
          day: targetDay,
          message: error?.message || error
        });
      }
    }

    if (!hadFailure) {
      state.last_day = targetDay;
      state.last_run_at = Date.now();
      saveSummaryState(state);
    }

    return { ran: true, count, day: targetDay, hadFailure, fourDayCreated, monthlyCreated };
  }

  return {
    runDailyJournalSummaries,
    shouldRunDailySummaryNow,
    summarizeJournalForDay
  };
}

module.exports = {
  createDailyJournalSummaryRunner
};
