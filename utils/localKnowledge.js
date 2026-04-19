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
const { readFileSync } = require('fs');

const NOTEBOOK_ROOT = path.join(config.DATA_DIR, 'notebook');
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

function sanitizeUserId(value, fallback = '') {
  const raw = String(value || fallback || '').trim();
  const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
  return cleaned || '';
}

function getUserNotebookDir(userId = '') {
  return path.join(NOTEBOOK_ROOT, sanitizeUserId(userId, 'public') || 'public');
}

function getNotebookIndexFile(userId = '') {
  return path.join(getUserNotebookDir(userId), 'index.json');
}

function getNotebookPathMeta(filePath = '') {
  try {
    const stat = fs.statSync(filePath);
    return {
      mtimeMs: Number(stat.mtimeMs || 0) || 0,
      size: Number(stat.size || 0) || 0
    };
  } catch (_) {
    return null;
  }
}

function readNotebookIndex(userId = '') {
  const index = safeReadJson(getNotebookIndexFile(userId), {
    docs: [],
    file_state: {},
    updated_at: new Date().toISOString()
  });
  if (!Array.isArray(index.docs)) index.docs = [];
  if (!index.file_state || typeof index.file_state !== 'object') index.file_state = {};
  return index;
}

function chunkText(text = '', chunkSize = 450, overlap = 80) {
  const input = String(text || '').replace(/\r/g, '').trim();
  if (!input) return [];
  const chunks = [];
  let cursor = 0;
  let paraNo = 1;
  while (cursor < input.length) {
    const end = Math.min(input.length, cursor + chunkSize);
    const content = input.slice(cursor, end);
    chunks.push({
      chunk_index: chunks.length,
      para_no: paraNo++,
      text: content
    });
    if (end >= input.length) break;
    cursor = Math.max(0, end - overlap);
  }
  return chunks;
}

function buildNotebookScopeMetadata(doc = {}, userId = '') {
  const sourcePath = normalizeText(doc.source_path || '');
  const scopeMatch = sourcePath.replace(/\\/g, '/').match(/\/(users|groups|bot)\/([^/]+)/i);
  const scopeFolder = String(scopeMatch?.[1] || 'users').toLowerCase();
  const scopeValue = normalizeText(scopeMatch?.[2] || userId || 'public');
  return {
    scopeType: scopeFolder === 'groups' ? 'group' : (scopeFolder === 'bot' ? 'bot' : 'personal'),
    ownerUserId: scopeFolder === 'users' ? scopeValue : normalizeText(userId),
    groupId: scopeFolder === 'groups' ? scopeValue : '',
    sessionKey: '',
    sourceKind: 'notebook',
    updatedAt: Number(new Date(doc.updated_at || Date.now()).getTime()) || Date.now(),
    tags: []
  };
}

function updateNotebookIndexIncremental(scope = {}, changedPath = '') {
  const userId = sanitizeUserId(scope.userId || scope.ownerUserId || 'public', 'public') || 'public';
  const index = readNotebookIndex(userId);
  const notebookDir = getUserNotebookDir(userId);
  if (!fs.existsSync(notebookDir)) {
    return { ok: true, updated: 0, skipped: 0, dedup: 0, total: 0 };
  }

  const targetFiles = changedPath
    ? [path.resolve(changedPath)]
    : fs.readdirSync(notebookDir)
      .filter((name) => /\.(md|txt)$/i.test(name))
      .map((name) => path.join(notebookDir, name));

  let updated = 0;
  let skipped = 0;
  let dedup = 0;
  for (const fullPath of targetFiles) {
    if (!fs.existsSync(fullPath)) continue;
    const meta = getNotebookPathMeta(fullPath);
    if (!meta) continue;
    const previous = index.file_state[fullPath];
    if (
      previous
      && Number(previous.mtimeMs || 0) === Number(meta.mtimeMs || 0)
      && Number(previous.size || 0) === Number(meta.size || 0)
    ) {
      skipped += 1;
      continue;
    }
    const content = fs.readFileSync(fullPath, 'utf8');
    const hash = stableHash(content);
    const duplicate = index.docs.find((doc) => String(doc.content_hash || '').trim() === hash && String(doc.source_path || '').trim() !== fullPath);
    if (duplicate) {
      index.file_state[fullPath] = { ...meta, hash };
      index.docs = index.docs.filter((doc) => String(doc.source_path || '').trim() !== fullPath);
      dedup += 1;
      continue;
    }
    const chunks = chunkText(content);
    const existingDoc = index.docs.find((doc) => String(doc.source_path || '').trim() === fullPath);
    const doc = {
      id: String(existingDoc?.id || `nb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
      title: path.basename(fullPath),
      source_path: fullPath,
      created_at: existingDoc?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      content_hash: hash,
      chunks,
      metadata: {
        ...buildNotebookScopeMetadata(existingDoc || { source_path: fullPath, updated_at: new Date().toISOString() }, userId),
        updatedAt: Date.now()
      }
    };
    index.docs = index.docs.filter((item) => String(item.source_path || '').trim() !== fullPath);
    index.docs.push(doc);
    index.file_state[fullPath] = { ...meta, hash };
    updated += 1;
  }

  index.updated_at = new Date().toISOString();
  atomicWriteJson(getNotebookIndexFile(userId), index);
  return {
    ok: true,
    updated,
    skipped,
    dedup,
    total: index.docs.length
  };
}

function searchNotebookDocs(userId = '', query = '', options = {}) {
  const index = readNotebookIndex(userId);
  const limit = Math.max(1, Math.min(20, Number(options.topK || options.limit || 5) || 5));
  const hits = [];
  for (const doc of normalizeArray(index.docs)) {
    const chunks = normalizeArray(doc.chunks);
    for (const chunk of chunks) {
      const text = normalizeText(chunk?.text || '', 800);
      if (!text) continue;
      const title = normalizeText(doc.title || '', 160);
      const score = Math.max(
        lexicalScore(query, text),
        lexicalScore(query, title) + 8,
        fuzzyTextScore(query, text),
        fuzzyTextScore(query, title) + 6
      );
      if (score <= 0) continue;
      hits.push({
        id: `notebook:${doc.id}:${Number(chunk?.chunk_index || 0)}`,
        source: 'notebook_doc',
        sourceKind: 'notebook',
        scopeType: normalizeText(doc?.metadata?.scopeType || 'personal'),
        ownerUserId: normalizeText(doc?.metadata?.ownerUserId || userId),
        groupId: normalizeText(doc?.metadata?.groupId || ''),
        sessionKey: normalizeText(doc?.metadata?.sessionKey || ''),
        updatedAt: Number(doc?.metadata?.updatedAt || new Date(doc.updated_at || 0).getTime()) || 0,
        title: normalizeText(doc.title),
        ref: {
          source: 'notebook',
          userId: normalizeText(userId),
          docId: String(doc.id || '').trim(),
          chunkIndex: Number(chunk?.chunk_index || 0) || 0
        },
        text,
        preview: normalizeText(text, 240),
        score
      });
    }
  }
  hits.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  return hits.slice(0, limit);
}

function readNotebookDoc(scope = {}, ref = {}) {
  const userId = sanitizeUserId(scope.userId || ref.userId || scope.ownerUserId || 'public', 'public') || 'public';
  const index = readNotebookIndex(userId);
  const docId = String(ref.docId || '').trim();
  const chunkIndex = Number(ref.chunkIndex || 0) || 0;
  const doc = index.docs.find((item) => String(item.id || '').trim() === docId);
  if (!doc) {
    return { ok: false, reason: 'not_found' };
  }
  const chunks = normalizeArray(doc.chunks);
  const selected = chunks.find((item) => Number(item?.chunk_index || 0) === chunkIndex) || chunks[0] || null;
  return {
    ok: true,
    source: 'notebook',
    docId,
    chunkIndex: Number(selected?.chunk_index || 0) || 0,
    title: normalizeText(doc.title),
    text: normalizeText(selected?.text || '', 4000),
    metadata: normalizeObject(doc.metadata)
  };
}

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

  const memoryResult = await queryMemory({
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
