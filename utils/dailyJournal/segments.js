function createDailyJournalSegments(deps = {}) {
  const {
    appendJsonLine,
    appendPerfEvent,
    atomicWriteText,
    buildUserSnapshot,
    config,
    extractMessageContent,
    formatDateInTz,
    formatJournalEntries,
    getBackgroundPressureDelayMs,
    getEntrySidecarFilePath,
    getJournalFilePath,
    getMemoryApiKey,
    getMemoryChatCompletionsUrl,
    getMemoryModelName,
    getSegmentsFilePath,
    getYearMonthFromDay,
    isValidDayString,
    loadSummaryState,
    normalizeContinuitySnapshot,
    normalizeTimestampToDay,
    parseJournalEntries,
    postWithRetry,
    readJsonLines,
    safeReadText,
    saveSummaryState,
    scheduleDailyJournalEmbeddingBackfill,
    shiftDate,
    strictClampText,
    syncEpisodeMemory
  } = deps;

  function normalizeText(value = '') {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function normalizeStringArray(values = [], limit = 16) {
    const list = Array.isArray(values) ? values : [values];
    const out = [];
    const seen = new Set();
    for (const raw of list) {
      const value = normalizeText(raw);
      if (!value || seen.has(value)) continue;
      seen.add(value);
      out.push(value);
      if (out.length >= Math.max(1, Number(limit) || 1)) break;
    }
    return out;
  }

  function normalizeEvidenceSidecarItems(values = []) {
    return (Array.isArray(values) ? values : [])
      .map((item) => {
        const value = item && typeof item === 'object' ? item : {};
        return {
          turnId: normalizeText(value.turnId || value.turn_id),
          userText: strictClampText(value.userText || value.user_text || value.question || '', 500),
          assistantText: strictClampText(value.assistantText || value.assistant_text || value.reply || value.finalReply || '', 500),
          sourceSessionId: normalizeText(value.sourceSessionId || value.source_session_id || value.sessionId || value.session_id)
        };
      })
      .filter((item) => item.turnId || item.userText || item.assistantText)
      .slice(0, 16);
  }

  function buildEntrySidecarRecord(record = {}, options = {}, day = '') {
    const routeMeta = options.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
    const turnIds = normalizeStringArray(options.turnIds || options.turn_ids, 32);
    const turnId = normalizeText(options.turnId || options.turn_id || turnIds[turnIds.length - 1]);
    const evidence = normalizeEvidenceSidecarItems(options.evidence);
    return {
      ts: String(record.ts || new Date().toISOString()),
      day: String(day || '').trim(),
      sessionKey: String(options.sessionKey || '').trim(),
      sourceSessionId: normalizeText(options.sourceSessionId || options.source_session_id || options.sessionId || routeMeta.sessionId || routeMeta.session_id),
      jobId: normalizeText(options.jobId || options.postReplyJobId || options.post_reply_job_id),
      postReplyJobId: normalizeText(options.postReplyJobId || options.post_reply_job_id || options.jobId),
      turnId,
      turnIds,
      evidence,
      groupId: String(options.groupId || routeMeta.groupId || routeMeta.group_id || '').trim(),
      channelId: String(options.channelId || routeMeta.channelId || routeMeta.channel_id || '').trim(),
      routePolicyKey: String(options.routePolicyKey || '').trim(),
      topRouteType: String(options.topRouteType || '').trim(),
      taskType: String(options.taskType || routeMeta.taskType || routeMeta.task_type || '').trim(),
      continuitySnapshot: normalizeContinuitySnapshot(options.continuitySnapshot),
      contextStats: options.contextStats && typeof options.contextStats === 'object'
        ? {
            usageRatio: Number(options.contextStats.usageRatio || 0) || 0,
            compactionLevel: String(options.contextStats.compactionLevel || options.contextStats.level || '').trim()
          }
        : {
            usageRatio: 0,
            compactionLevel: ''
          }
    };
  }

  function readEntrySidecar(userId, day) {
    const uid = String(userId || '').trim();
    if (!uid || !isValidDayString(day)) return [];
    return readJsonLines(getEntrySidecarFilePath(uid, day));
  }

  function collectRecentEntrySidecars(userId, options = {}) {
    const uid = String(userId || '').trim();
    if (!uid) return [];
    const lookbackDays = Math.max(1, Number(options.lookbackDays || config.CONTINUITY_JOURNAL_LOOKBACK_DAYS || 7));
    const targetDay = normalizeTimestampToDay(options.timestamp) || formatDateInTz(new Date(), config.TIMEZONE);
    const days = [];
    for (let i = 0; i < lookbackDays; i += 1) {
      days.push(shiftDate(targetDay, -i));
    }
    return days.flatMap((day) => readEntrySidecar(uid, day));
  }

  function getSegmentState(state, userId, day) {
    const uid = String(userId || '').trim();
    if (!uid || !day) return null;
    if (!state.users || typeof state.users !== 'object') state.users = {};
    if (!state.users[uid] || typeof state.users[uid] !== 'object') state.users[uid] = {};
    if (!state.users[uid][day] || typeof state.users[uid][day] !== 'object') {
      state.users[uid][day] = {
        journal_offset: 0,
        segment_count: 0,
        last_segment_at: 0
      };
    }
    return state.users[uid][day];
  }

  function readUnsegmentedEntries(userId, day, state) {
    const journalText = safeReadText(getJournalFilePath(userId, day), '');
    const entries = parseJournalEntries(journalText);
    const segmentState = getSegmentState(state, userId, day);
    if (!segmentState) return [];
    const offset = Math.max(0, Number(segmentState.journal_offset) || 0);
    return entries.slice(offset);
  }

  function consumeEntriesForSegmentation(entries = []) {
    const maxEntries = Math.max(1, Number(config.DAILY_JOURNAL_SEGMENT_MAX_ENTRIES) || 20);
    const maxBytes = Math.max(512, Number(config.DAILY_JOURNAL_SEGMENT_MAX_BYTES) || 8192);
    const out = [];
    let bytes = 0;

    for (const entry of entries) {
      const entryText = formatJournalEntries([entry]);
      const nextBytes = Buffer.byteLength(entryText, 'utf8');
      if (out.length > 0 && (out.length >= maxEntries || bytes + nextBytes > maxBytes)) break;
      out.push(entry);
      bytes += nextBytes;
      if (out.length >= maxEntries || bytes >= maxBytes) break;
    }

    return out;
  }

  function trimActiveJournalWindow(userId, day, state) {
    const filePath = getJournalFilePath(userId, day);
    const entries = parseJournalEntries(safeReadText(filePath, ''));
    const segmentState = getSegmentState(state, userId, day);
    if (!segmentState) return;

    const keepTail = Math.max(1, Number(config.DAILY_JOURNAL_ACTIVE_RAW_MAX_ENTRIES) || 8);
    const tail = entries.slice(-keepTail);
    atomicWriteText(filePath, tail.length > 0 ? `${formatJournalEntries(tail)}\n` : '');
    segmentState.journal_offset = 0;
  }

  async function summarizeJournalSegment(userId, day, segmentEntries = [], options = {}) {
    const uid = String(userId || '').trim();
    const entries = Array.isArray(segmentEntries) ? segmentEntries : [];
    if (!uid || !day || entries.length === 0) return '';

    if (typeof options.segmentSummarizer === 'function') {
      return String(await options.segmentSummarizer({ userId: uid, day, entries })).trim();
    }

    const maxTokens = Math.max(180, Math.min(600, Math.floor(Number(config.DAILY_JOURNAL_SEGMENT_SUMMARY_MAX_TOKENS) || 320)));
    const sourceText = formatJournalEntries(entries);
    const prompt = [
      'You compress a small batch of chat journal entries into durable daily memory notes.',
      'Keep only stable preferences, decisions, commitments, progress, blockers, and topics worth continuing later.',
      'Drop filler, repeated banter, and low-value chatter.',
      'Return plain text only.',
      `Keep the output within about ${maxTokens} tokens.`
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
            content: `Day: ${day}\n\nSegment entries:\n${sourceText}`
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

  async function maybeSegmentJournal(userId, day, state, options = {}) {
    const segmentState = getSegmentState(state, userId, day);
    if (!segmentState) return false;

    const pendingEntries = readUnsegmentedEntries(userId, day, state);
    const batch = consumeEntriesForSegmentation(pendingEntries);
    if (batch.length === 0) return false;

    const summary = await summarizeJournalSegment(userId, day, batch, options);
    if (!summary) return false;

    const segmentIndex = Math.max(0, Number(segmentState.segment_count) || 0);
    appendJsonLine(getSegmentsFilePath(userId, day), {
      index: segmentIndex,
      created_at: new Date().toISOString(),
      entry_count: batch.length,
      summary
    }, {
      flushNow: true
    });
    await syncEpisodeMemory(userId, summary, {
      source: 'daily_journal_summary',
      rollupLevel: 'segment',
      episodeDay: day,
      startDay: day,
      endDay: day,
      yearMonth: getYearMonthFromDay(day),
      part: segmentIndex,
      sourceFile: getSegmentsFilePath(userId, day),
      textKind: 'journal_segment',
      sourceCompleteness: 'segment',
      maxChars: config.DAILY_JOURNAL_SEGMENT_MAX_BYTES,
      scheduleEmbeddingBackfill: false,
      refreshReason: 'journal_segment_generated'
    });
    scheduleDailyJournalEmbeddingBackfill(userId, { days: [day] });

    segmentState.journal_offset = Math.max(0, Number(segmentState.journal_offset) || 0) + batch.length;
    segmentState.segment_count = Math.max(0, Number(segmentState.segment_count) || 0) + 1;
    segmentState.last_segment_at = Date.now();
    trimActiveJournalWindow(userId, day, state);
    return true;
  }

  async function maybeSegmentJournalByThreshold(userId, day, options = {}) {
    const uid = String(userId || '').trim();
    if (!uid || !day || !config.DAILY_JOURNAL_ENABLED) return false;
    const pressureDelayMs = getBackgroundPressureDelayMs();
    if (pressureDelayMs > 0) {
      appendPerfEvent({
        category: 'background_pressure',
        type: 'daily_journal_segment_deferred',
        delayMs: pressureDelayMs,
        userId: uid,
        day
      });
      return false;
    }
    const state = loadSummaryState();
    const pendingEntries = readUnsegmentedEntries(uid, day, state);
    if (pendingEntries.length === 0) return false;

    const minPendingEntries = Math.max(1, Number(config.DAILY_JOURNAL_SEGMENT_MIN_PENDING_ENTRIES) || 1);
    const maxPendingAgeMs = Math.max(0, Number(config.DAILY_JOURNAL_SEGMENT_MAX_PENDING_AGE_MS) || 0);
    const oldestTs = Date.parse(String(pendingEntries[0]?.ts || ''));
    const oldestAgeMs = Number.isFinite(oldestTs) ? Math.max(0, Date.now() - oldestTs) : 0;
    if (pendingEntries.length < minPendingEntries && (!maxPendingAgeMs || oldestAgeMs < maxPendingAgeMs)) {
      return false;
    }

    const segmented = await maybeSegmentJournal(uid, day, state, options);
    saveSummaryState(state);
    return segmented;
  }

  function readSegmentSummaries(userId, day) {
    const raw = safeReadText(getSegmentsFilePath(userId, day), '').trim();
    if (!raw) return [];
    return raw
      .split(/\r?\n/)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .map((item) => ({
        day,
        text: String(item.summary || '').trim(),
        entryCount: Number(item.entry_count || 0) || 0,
        index: Number(item.index || 0) || 0
      }))
      .filter((item) => item.text);
  }

  return {
    buildEntrySidecarRecord,
    collectRecentEntrySidecars,
    maybeSegmentJournal,
    maybeSegmentJournalByThreshold,
    readEntrySidecar,
    readSegmentSummaries
  };
}

module.exports = {
  createDailyJournalSegments
};
