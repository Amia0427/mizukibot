const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const { loadBridgeStore } = require('./shortTermBridgeMemory');
const { getRecentSessionContextSummaries } = require('./sessionContextSummaryStore');
const {
  getDailyJournalRetrievalBundle,
  collectRecentEntrySidecars
} = require('./dailyJournal');
const { getAccessibleGroupIdsForUser } = require('./memoryScopeIndex');
const { getUserProfile, getUserAffinityState } = require('./memory');
const { queryMemory } = require('./memory-v3');
const { loadSessionProjection } = require('./memory-v3/storage');
const { createLocalKnowledgeNotebook } = require('./localKnowledge/notebook');

const SOURCE_PRIORITY = Object.freeze({
  session_projection: 500,
  short_term_bridge: 420,
  session_summary: 360,
  journal_continuity: 320,
  memory_v3_task: 260,
  memory_v3_group: 240,
  memory_v3_personal: 220,
  notebook_doc: 180,
  journal_rollup: 140,
  journal_entry: 120
});

function normalizeText(value, maxChars = 0) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (!maxChars || text.length <= maxChars) return text;
  return text.slice(0, Math.max(1, Number(maxChars) || 1));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function stableHash(value = '') {
  return crypto.createHash('sha1').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function tokenize(text = '') {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function lexicalScore(query = '', text = '') {
  const q = tokenize(query);
  const t = tokenize(text);
  if (!q.length || !t.length) return 0;
  let hit = 0;
  for (const token of q) {
    if (t.includes(token)) hit += 1;
  }
  return hit * 10 + (hit / Math.max(1, t.length)) * 100;
}

function fuzzyTextScore(query = '', text = '') {
  const q = normalizeText(query).toLowerCase();
  const t = normalizeText(text).toLowerCase();
  if (!q || !t) return 0;
  if (t.includes(q)) return 80;
  const compactQ = q.replace(/\s+/g, '');
  const compactT = t.replace(/\s+/g, '');
  if (compactQ && compactT.includes(compactQ)) return 60;
  let bonus = 0;
  for (let i = 0; i < compactQ.length; i += 2) {
    const piece = compactQ.slice(i, i + 2);
    if (piece.length >= 2 && compactT.includes(piece)) bonus += 8;
  }
  return bonus;
}

function safeReadJson(filePath, fallback = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!String(raw || '').trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function atomicWriteJson(filePath, data) {
  const tempFile = `${filePath}.${process.pid}.tmp`;
  const body = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempFile, body, 'utf8');
    fs.renameSync(tempFile, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, body, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

const {
  getNotebookIndexFile,
  getUserNotebookDir,
  readNotebookDoc,
  readNotebookIndex,
  sanitizeUserId,
  searchNotebookDocs,
  updateNotebookIndexIncremental
} = createLocalKnowledgeNotebook({
  atomicWriteJson,
  config,
  normalizeArray,
  normalizeObject,
  normalizeText,
  safeReadJson,
  stableHash,
  lexicalScore,
  fuzzyTextScore
});

function normalizeSourceForMemoryResult(item = {}) {
  const source = normalizeText(item.source || '').toLowerCase();
  if (source === 'task') return 'memory_v3_task';
  if (source === 'group') return 'memory_v3_group';
  if (source === 'recent') return 'session_projection';
  return 'memory_v3_personal';
}

async function queryLocalKnowledge(input = {}) {
  const userId = normalizeText(input.userId);
  const query = normalizeText(input.query || input.question || '');
  const groupId = normalizeText(input.groupId || '');
  const sessionKey = normalizeText(input.sessionKey || '');
  const topK = Math.max(1, Math.min(20, Number(input.topK || 8) || 8));
  const results = [];

  const sessionProjection = loadSessionProjection();
  const projectionEntry = sessionProjection.sessions?.[sessionKey];
  if (projectionEntry) {
    const text = [
      projectionEntry.activeTopic ? `topic: ${projectionEntry.activeTopic}` : '',
      projectionEntry.carryOverUserTurn ? `carry: ${projectionEntry.carryOverUserTurn}` : '',
      projectionEntry.summary ? `summary: ${projectionEntry.summary}` : '',
      normalizeArray(projectionEntry.openLoops).length ? `open: ${projectionEntry.openLoops.join(' | ')}` : ''
    ].filter(Boolean).join('\n');
    const score = lexicalScore(query, text || projectionEntry.summary || '');
    if (score > 0 || !query) {
      results.push({
        id: `session_projection:${sessionKey}`,
        source: 'session_projection',
        scopeType: 'session',
        text: normalizeText(text || projectionEntry.summary, 1200),
        preview: normalizeText(text || projectionEntry.summary, 240),
        score: score + SOURCE_PRIORITY.session_projection,
        priority: SOURCE_PRIORITY.session_projection,
        updatedAt: Number(projectionEntry.updatedAt || 0) || 0
      });
    }
  }

  const bridgeEntry = loadBridgeStore().sessions?.[sessionKey];
  if (bridgeEntry?.shortTermState) {
    const bridgeText = [
      bridgeEntry.shortTermState.activeTopic,
      bridgeEntry.shortTermState.carryOverUserTurn,
      bridgeEntry.shortTermState.summary,
      ...normalizeArray(bridgeEntry.shortTermState.openLoops)
    ].filter(Boolean).join('\n');
    const score = lexicalScore(query, bridgeText);
    if (score > 0 || !query) {
      results.push({
        id: `short_term_bridge:${sessionKey}`,
        source: 'short_term_bridge',
        scopeType: 'session',
        text: normalizeText(bridgeText, 1200),
        preview: normalizeText(bridgeText, 240),
        score: score + SOURCE_PRIORITY.short_term_bridge,
        priority: SOURCE_PRIORITY.short_term_bridge,
        updatedAt: Number(bridgeEntry.updatedAt || 0) || 0
      });
    }
  }

  const summaries = getRecentSessionContextSummaries(sessionKey, { limit: 3 });
  for (const summary of summaries) {
    const score = lexicalScore(query, summary.summary || '');
    if (score <= 0 && query) continue;
    results.push({
      id: `session_summary:${summary.createdAt}`,
      source: 'session_summary',
      scopeType: 'session',
      text: normalizeText(summary.summary, 1200),
      preview: normalizeText(summary.summary, 240),
      score: score + SOURCE_PRIORITY.session_summary,
      priority: SOURCE_PRIORITY.session_summary,
      updatedAt: Number(summary.createdAt || 0) || 0
    });
  }

  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    sessionKey,
    question: query,
    topic: query,
    lookbackDays: input.lookbackDays
  });
  const continuity = normalizeObject(journalBundle.continuity);
  for (const item of normalizeArray(continuity.sameSession).concat(normalizeArray(continuity.sameTopic)).slice(0, 4)) {
    const snapshot = normalizeObject(item.continuitySnapshot);
    const text = [
      snapshot.activeTopic,
      snapshot.carryOverUserTurn,
      ...normalizeArray(snapshot.openLoops)
    ].filter(Boolean).join('\n');
    const score = lexicalScore(query, text);
    if (score <= 0 && query) continue;
    results.push({
      id: `journal_continuity:${stableHash(text)}`,
      source: 'journal_continuity',
      scopeType: 'personal',
      text: normalizeText(text, 1200),
      preview: normalizeText(text, 240),
      score: score + SOURCE_PRIORITY.journal_continuity,
      priority: SOURCE_PRIORITY.journal_continuity,
      updatedAt: Number(new Date(item.ts || 0).getTime()) || 0
    });
  }

  const memoryResult = input.skipMemoryV3
    ? { ok: true, results: [], skipped: true }
    : await queryMemory({
      userId,
      query,
      topK,
      groupId,
      groupIds: normalizeArray(input.groupIds).length ? input.groupIds : getAccessibleGroupIdsForUser(userId),
      sessionKey,
      sessionId: input.sessionId,
      routePolicyKey: input.routePolicyKey,
      topRouteType: input.topRouteType,
      taskType: input.taskType,
      agentName: input.agentName,
      toolName: input.toolName
    });
  for (const item of normalizeArray(memoryResult.results)) {
    const source = normalizeSourceForMemoryResult(item);
    results.push({
      id: String(item.id || `${source}:${stableHash(item.text)}`).trim(),
      source,
      sourceKind: normalizeText(item.sourceKind || ''),
      scopeType: normalizeText(item.scopeType || ''),
      text: normalizeText(item.text, 1200),
      preview: normalizeText(item.text, 240),
      score: Number(item.score || 0) + (SOURCE_PRIORITY[source] || 0),
      matchMode: normalizeText(item.matchMode || '') || (Number(item.embedding || 0) > 0 ? 'hybrid' : 'lexical'),
      scoreParts: item.scoreParts && typeof item.scoreParts === 'object' ? item.scoreParts : {},
      priority: SOURCE_PRIORITY[source] || 0,
      updatedAt: Number(item.updatedAt || 0) || 0,
      raw: item
    });
  }

  const notebookHits = searchNotebookDocs(userId, query, { topK });
  for (const hit of notebookHits) {
    results.push({
      ...hit,
      priority: SOURCE_PRIORITY.notebook_doc,
      score: Number(hit.score || 0) + SOURCE_PRIORITY.notebook_doc
    });
  }

  const sidecars = collectRecentEntrySidecars(userId, { lookbackDays: input.lookbackDays });
  for (const entry of sidecars.slice(0, 10)) {
    const snapshot = normalizeObject(entry.continuitySnapshot);
    const text = [
      snapshot.activeTopic,
      snapshot.carryOverUserTurn,
      ...normalizeArray(snapshot.openLoops)
    ].filter(Boolean).join('\n');
    const score = lexicalScore(query, text);
    if (score <= 0 && query) continue;
    results.push({
      id: `journal_entry:${stableHash(`${entry.day}:${text}`)}`,
      source: 'journal_entry',
      scopeType: 'personal',
      text: normalizeText(text, 1200),
      preview: normalizeText(text, 240),
      score: score + SOURCE_PRIORITY.journal_entry,
      priority: SOURCE_PRIORITY.journal_entry,
      updatedAt: Number(new Date(entry.ts || 0).getTime()) || 0
    });
  }

  results.sort((a, b) => {
    if (Number(b.priority || 0) !== Number(a.priority || 0)) return Number(b.priority || 0) - Number(a.priority || 0);
    if (Number(b.score || 0) !== Number(a.score || 0)) return Number(b.score || 0) - Number(a.score || 0);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });

  const deduped = [];
  const seen = new Set();
  const duplicates = [];
  for (const item of results) {
    const key = stableHash(item.text || item.preview || '');
    if (seen.has(key)) {
      duplicates.push({ source: item.source, text: item.preview || item.text });
      continue;
    }
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= topK) break;
  }

  return {
    ok: true,
    query,
    results: deduped,
    bySource: deduped.reduce((acc, item) => {
      acc[item.source] = acc[item.source] || [];
      acc[item.source].push(item);
      return acc;
    }, {}),
    diagnostics: {
      candidates: results.length,
      selected: deduped.length,
      duplicates,
      sourcePriority: SOURCE_PRIORITY,
      notebookIndexUpdatedAt: safeReadJson(getNotebookIndexFile(userId), {}).updated_at || '',
      sessionProjectionUpdatedAt: Number(sessionProjection.updatedAt || 0) || 0
    },
    memoryResult,
    journalBundle
  };
}

async function recordLocalMemoryOutcome(input = {}) {
  const payload = normalizeObject(input);
  const writes = [];
  const deduped = [];
  if (typeof payload.recordPersonaMemoryOutcome === 'function') {
    const result = await payload.recordPersonaMemoryOutcome(payload.surface || 'direct_chat', payload);
    writes.push({ target: 'memory_v3', result });
  }
  if (payload.notebook && payload.notebook.userId) {
    const userId = sanitizeUserId(payload.notebook.userId, 'public') || 'public';
    const title = normalizeText(payload.notebook.title || 'memory-note', 120);
    const content = normalizeText(payload.notebook.content || '', 20000);
    if (content) {
      const index = readNotebookIndex(userId);
      const hash = stableHash(content);
      const existing = index.docs.find((doc) => String(doc.content_hash || '').trim() === hash);
      if (existing) {
        deduped.push({ target: 'notebook', id: existing.id });
      } else {
        const userDir = getUserNotebookDir(userId);
        if (!fs.existsSync(userDir)) fs.mkdirSync(userDir, { recursive: true });
        const safeName = title.replace(/[\\/:*?"<>|]/g, '_');
        const filePath = path.join(userDir, `${safeName}.md`);
        fs.writeFileSync(filePath, content, 'utf8');
        const update = updateNotebookIndexIncremental({ userId }, filePath);
        writes.push({ target: 'notebook', filePath, update });
      }
    }
  }
  if (payload.journalFile) {
    const entry = normalizeText(payload.journalEntry || '', 20000);
    if (entry) {
      const line = `\n## ${new Date().toISOString()} [${normalizeText(payload.journalTag || 'local_memory', 32) || 'local_memory'}]\n${entry}\n`;
      fs.appendFileSync(payload.journalFile, line, 'utf8');
      writes.push({ target: 'journal', file: payload.journalFile });
    }
  }

  return {
    persisted: writes.length > 0,
    writes,
    deduped
  };
}

module.exports = {
  queryLocalKnowledge,
  readNotebookDoc,
  recordLocalMemoryOutcome,
  updateNotebookIndexIncremental
};
