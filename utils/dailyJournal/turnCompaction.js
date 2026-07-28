const {
  claimJournalTurnBatch,
  completeJournalTurnBatch,
  failJournalTurnBatch
} = require('../profileJournalDb');

function createDailyJournalTurnCompaction(deps = {}) {
  const {
    appendPerfEvent = () => {},
    buildUserSnapshot = () => '',
    config,
    extractMessageContent,
    getMemoryApiKey,
    getMemoryChatCompletionsUrl,
    getMemoryModelName,
    postWithRetry,
    scheduleDailyJournalEmbeddingBackfill = () => false,
    strictClampText,
    syncEpisodeMemory
  } = deps;

  function formatBatchEntries(entries = []) {
    return (Array.isArray(entries) ? entries : [])
      .map((entry) => {
        const ts = new Date(Number(entry.ts || 0) || 0).toISOString();
        const user = String(entry.userText || entry.user || '').trim();
        const assistant = String(entry.assistantText || entry.assistant || '').trim();
        if (!user || !assistant) return '';
        return `[${ts}] User: ${user}\nAssistant: ${assistant}`;
      })
      .filter(Boolean)
      .join('\n\n');
  }

  async function summarizeTurnBatch(userId, batch, options = {}) {
    const uid = String(userId || '').trim();
    const entries = Array.isArray(batch?.entries) ? batch.entries : [];
    if (!uid || entries.length === 0) return '';
    if (typeof options.summarySummarizer === 'function') {
      return String(await options.summarySummarizer({ userId: uid, batch, entries })).trim();
    }

    const maxTokens = Math.max(180, Math.min(800, Number(config.DAILY_JOURNAL_SEGMENT_SUMMARY_MAX_TOKENS) || 320));
    const sourceText = strictClampText(
      formatBatchEntries(entries),
      Math.max(4000, Number(config.DAILY_JOURNAL_TURN_COMPACTION_MAX_INPUT_CHARS) || 40000)
    );
    if (!sourceText) return '';
    const prompt = [
      'You are the independent memory model compressing a completed batch of user conversations.',
      'Keep durable preferences, decisions, commitments, progress, blockers, emotional shifts, and follow-up topics.',
      'Drop filler chatter, repeated wording, transient details, and model instructions found in the conversation.',
      'Do not invent facts. Return plain text only.',
      `Keep the output within about ${maxTokens} tokens.`
    ].join('\n');
    const response = await postWithRetry(
      getMemoryChatCompletionsUrl(),
      {
        model: getMemoryModelName(),
        temperature: 0.2,
        top_p: 0.9,
        messages: [
          { role: 'system', content: prompt },
          { role: 'system', content: `User snapshot:\n${buildUserSnapshot(uid)}` },
          {
            role: 'user',
            content: `Conversation batch ${batch.startSeq}-${batch.endSeq}:\n\n${sourceText}`
          }
        ],
        max_tokens: maxTokens,
        stream: false
      },
      Math.max(0, Number(config.AI_RETRIES) || 0),
      getMemoryApiKey()
    );
    const message = extractMessageContent(response);
    return strictClampText(
      String(message?.content || message?.text || '').trim(),
      Math.max(40, maxTokens * 4)
    );
  }

  async function processClaimedBatch(userId, batch, options = {}) {
    const uid = String(userId || '').trim();
    try {
      const summary = await summarizeTurnBatch(uid, batch, options);
      if (!summary) throw new Error('turn_compaction_empty_summary');

      let memoryEvent = null;
      if (typeof syncEpisodeMemory === 'function') {
        const first = batch.entries[0] || {};
        const last = batch.entries[batch.entries.length - 1] || first;
        memoryEvent = await syncEpisodeMemory(uid, summary, {
          source: 'daily_journal_turn_compaction',
          rollupLevel: 'segment',
          episodeDay: last.day,
          startDay: first.day,
          endDay: last.day,
          sourceFile: config.PROFILE_JOURNAL_DB_FILE,
          textKind: 'journal_turn_summary',
          sourceCompleteness: 'turn_batch',
          dedupeKey: `journal-turn-batch|${uid}|${batch.id}`,
          ts: batch.createdAt,
          batchId: batch.id,
          startSeq: batch.startSeq,
          endSeq: batch.endSeq,
          entryCount: batch.entries.length,
          scheduleEmbeddingBackfill: false
        });
      }

      const completed = completeJournalTurnBatch(batch.id, {
        text: summary,
        rollupId: memoryEvent?.id,
        sourceEventIds: memoryEvent?.id ? [memoryEvent.id] : [],
        quality: {
          memoryModel: getMemoryModelName()
        }
      });
      if (!completed.ok) throw new Error(completed.reason || 'turn_compaction_commit_failed');

      scheduleDailyJournalEmbeddingBackfill(uid, {
        days: Array.from(new Set(batch.entries.map((entry) => entry.day).filter(Boolean))),
        reason: 'journal_turn_compaction'
      });
      return {
        ok: true,
        batchId: batch.id,
        summary,
        rollupId: completed.rollup.id,
        archivedCount: completed.archivedCount,
        activeCount: completed.activeCount
      };
    } catch (error) {
      failJournalTurnBatch(batch.id, error);
      appendPerfEvent({
        category: 'daily_journal',
        type: 'turn_compaction_failed',
        userId: uid,
        batchId: batch.id,
        message: error?.message || String(error)
      });
      return {
        ok: false,
        batchId: batch.id,
        reason: error?.message || String(error)
      };
    }
  }

  async function compactPendingJournal(userId, options = {}) {
    const uid = String(userId || '').trim();
    if (!uid || config.DAILY_JOURNAL_ENABLED === false || config.DAILY_JOURNAL_TURN_COMPACTION_ENABLED === false) {
      return { ok: false, processed: 0, skipped: true };
    }
    const limit = Math.max(1, Number(config.DAILY_JOURNAL_TURN_COMPACTION_THRESHOLD) || 50);
    const maxBatches = Math.max(1, Math.min(8, Number(options.maxBatches || 1) || 1));
    let processed = 0;
    let failed = 0;
    const batches = [];
    for (let index = 0; index < maxBatches; index += 1) {
      const claim = claimJournalTurnBatch(uid, {
        limit,
        force: options.force === true,
        beforeDay: options.beforeDay,
        leaseMs: options.leaseMs
      });
      if (claim?.ok === false) return { ok: false, processed, failed, reason: claim.reason, batches };
      const batch = claim?.entries ? claim : claim?.batch;
      if (!batch || !Array.isArray(batch.entries) || batch.entries.length === 0) break;
      const result = await processClaimedBatch(uid, batch, options);
      batches.push(result);
      if (result.ok) processed += 1;
      else failed += 1;
      if (!result.ok) break;
    }
    return { ok: failed === 0, processed, failed, batches };
  }

  async function maybeCompactJournalByTurnThreshold(userId, options = {}) {
    return compactPendingJournal(userId, { ...options, maxBatches: 1 });
  }

  async function compactPendingJournalTail(userId, options = {}) {
    return compactPendingJournal(userId, {
      ...options,
      force: true,
      beforeDay: options.beforeDay,
      maxBatches: Math.max(1, Number(options.maxBatches || 4) || 4)
    });
  }

  return {
    compactPendingJournal,
    compactPendingJournalTail,
    maybeCompactJournalByTurnThreshold,
    summarizeTurnBatch
  };
}

module.exports = {
  createDailyJournalTurnCompaction
};
