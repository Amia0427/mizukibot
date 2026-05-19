const {
  isPositiveMemoryRecallText,
  normalizeArray,
  normalizeObject,
  normalizeStringList,
  trimLine
} = require('./helpers');

function summarizeProbeDigest(probeResult = null, maxItems = 3) {
  const parsed = probeResult && typeof probeResult === 'object' ? probeResult : null;
  if (!parsed) return [];

  const digest = normalizeStringList(parsed.digest, maxItems, 180);
  if (digest.length > 0) return digest;

  const results = normalizeArray(parsed.results)
    .map((item) => trimLine(item?.text || item?.preview || item?.title || '', 180))
    .filter(Boolean)
    .slice(0, Math.max(1, Number(maxItems) || 1));
  if (results.length > 0) return results;

  const opened = trimLine(parsed?.data?.text || parsed?.data?.preview || '', 180);
  return opened ? [opened] : [];
}

function collectDigestLines(snapshot = {}, prefix = '', options = {}) {
  const state = normalizeObject(snapshot, {});
  const lines = [];
  const activeTopic = trimLine(state.activeTopic || state.active_topic, 180);
  const activeTopicFirst = options.activeTopicFirst !== false;
  if (activeTopic && activeTopicFirst) lines.push(`${prefix}${activeTopic}`);
  const summary = trimLine(state.summary || '', 180);
  if (summary && options.includeSummary) lines.push(`${prefix}${summary}`);
  const openLoops = normalizeStringList(state.openLoops || state.open_loops, 2, 160);
  const commitments = normalizeStringList(state.assistantCommitments || state.assistant_commitments, 2, 160);
  const constraints = normalizeStringList(state.userConstraints || state.user_constraints, 2, 160);
  const carry = trimLine(state.carryOverUserTurn || state.carry_over_user_turn, 180);
  if (carry) lines.push(`${prefix}${carry}`);
  for (const value of openLoops) lines.push(`${prefix}${value}`);
  for (const value of commitments) lines.push(`${prefix}${value}`);
  for (const value of constraints) lines.push(`${prefix}${value}`);
  if (activeTopic && !activeTopicFirst) lines.push(`${prefix}${activeTopic}`);
  return normalizeStringList(lines, 6, 180);
}

function buildActiveRawDigestLines(activeRawItems = []) {
  const lines = [];
  for (const item of normalizeArray(activeRawItems)) {
    const entries = normalizeArray(item?.entries);
    if (entries.length > 0) {
      for (const entry of entries) {
        const userText = trimLine(entry?.user, 110);
        const assistantText = trimLine(entry?.assistant, 110);
        const merged = [userText ? `User: ${userText}` : '', assistantText ? `Assistant: ${assistantText}` : ''].filter(Boolean).join(' / ');
        if (merged) lines.push(merged);
      }
      continue;
    }
    const text = trimLine(item?.text, 180);
    if (text) lines.push(text);
  }
  return normalizeStringList(lines, 8, 180);
}

function buildDailyJournalDigest(bundle = {}) {
  const continuity = normalizeObject(bundle.continuity, {});
  const activeRaw = normalizeArray(bundle.byLayer?.activeRaw);
  const sameSession = normalizeArray(continuity.sameSession);
  const sameTopic = normalizeArray(continuity.sameTopic);
  const preferred = sameSession.length > 0 ? sameSession : sameTopic;
  const activeRawDigestLines = buildActiveRawDigestLines(activeRaw);
  const digestLines = normalizeStringList(preferred.flatMap((entry) => collectDigestLines(entry.continuitySnapshot)), 6, 180);
  return {
    digestLines,
    activeRawDigestLines,
    sourceFlags: [
      ...(activeRaw.length > 0 ? ['journal_active_raw'] : []),
      ...(sameSession.length > 0 ? ['journal_same_session'] : []),
      ...(sameTopic.length > 0 ? ['journal_same_topic'] : [])
    ],
    payload: {
      activeRaw,
      sameSession,
      sameTopic
    }
  };
}

function buildMemoryContextDigest(memoryContext = {}) {
  const context = normalizeObject(memoryContext, {});
  const digestLines = [];
  if (String(context.taskMemoryText || '').trim()) digestLines.push(`task:${trimLine(context.taskMemoryText, 120)}`);
  if (String(context.groupMemoryText || '').trim()) digestLines.push(`group:${trimLine(context.groupMemoryText, 120)}`);
  if (String(context.dailyJournalText || '').trim()) digestLines.push(`journal:${trimLine(context.dailyJournalText, 120)}`);
  if (isPositiveMemoryRecallText(context.retrievedMemoryForPrompt)) {
    digestLines.push(`recall:${trimLine(context.retrievedMemoryForPrompt, 120)}`);
  }
  return normalizeStringList(digestLines, 2, 140);
}

module.exports = {
  buildActiveRawDigestLines,
  buildDailyJournalDigest,
  buildMemoryContextDigest,
  collectDigestLines,
  summarizeProbeDigest
};
