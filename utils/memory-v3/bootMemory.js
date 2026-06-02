const config = require('../../config');
const {
  clampText,
  normalizeText
} = require('./helpers');
const { queryMemory } = require('./query');
const { assembleMemoryPacket } = require('./packet');
const { matchMemoryTriggers } = require('./triggerGlossary');

function compactLines(lines = [], maxChars = 1200) {
  const output = [];
  let used = 0;
  for (const raw of Array.isArray(lines) ? lines : []) {
    const line = normalizeText(raw);
    if (!line) continue;
    if (used + line.length + 1 > maxChars) break;
    output.push(line);
    used += line.length + 1;
  }
  return output;
}

async function buildBootMemory(input = {}) {
  const userId = normalizeText(input.userId);
  if (!userId) return { ok: false, reason: 'user_id_required', text: '' };
  const query = normalizeText(input.query || '身份 偏好 关系 最近任务 连续性');
  const topK = Math.max(3, Math.min(12, Number(input.topK || config.MEMORY_V3_TOP_K || 8) || 8));
  const result = await queryMemory({
    ...input,
    userId,
    query,
    topK,
    facet: input.facet || 'continuity',
    source: input.source || 'all'
  });
  const packet = assembleMemoryPacket(result, {
    userId,
    sessionKey: input.sessionKey,
    question: query,
    forceStableProfile: true
  });
  const triggerMatches = matchMemoryTriggers(query, {
    namespace: input.namespace,
    limit: 6
  });
  const sections = [];
  if (packet.stableProfileText) sections.push(`[BootProfile]\n${packet.stableProfileText}`);
  if (packet.sessionContinuityText) sections.push(`[BootContinuity]\n${packet.sessionContinuityText}`);
  if (packet.relevantEvidenceText) sections.push(`[BootEvidence]\n${packet.relevantEvidenceText}`);
  if (packet.taskStrategyText) sections.push(`[BootTasks]\n${packet.taskStrategyText}`);
  if (triggerMatches.length) {
    sections.push(`[BootTriggers]\n${compactLines(triggerMatches.map((item) => `${item.keyword} -> ${item.uri}${item.disclosure ? `: ${item.disclosure}` : ''}`), 480).join('\n')}`);
  }
  const text = clampText(sections.filter(Boolean).join('\n\n'), Math.max(300, Number(input.maxChars || 1600) || 1600));
  return {
    ok: true,
    userId,
    uri: 'system://boot',
    query,
    text,
    digest: compactLines(result.digest || [], 520),
    results: Array.isArray(result.results) ? result.results.slice(0, topK) : [],
    triggerMatches,
    diagnostics: {
      facet: result.facet,
      sourceCoverage: result.sourceCoverage || {},
      stats: result.stats || {}
    }
  };
}

module.exports = {
  buildBootMemory
};
