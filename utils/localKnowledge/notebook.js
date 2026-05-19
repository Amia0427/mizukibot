const fs = require('fs');
const path = require('path');

function createLocalKnowledgeNotebook(deps = {}) {
  const {
    atomicWriteJson,
    config,
    normalizeArray,
    normalizeObject,
    normalizeText,
    safeReadJson,
    stableHash,
    lexicalScore,
    fuzzyTextScore
  } = deps;

  const notebookRoot = path.join(config.DATA_DIR, 'notebook');

  function sanitizeUserId(value, fallback = '') {
    const raw = String(value || fallback || '').trim();
    const cleaned = raw.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    return cleaned || '';
  }

  function getUserNotebookDir(userId = '') {
    return path.join(notebookRoot, sanitizeUserId(userId, 'public') || 'public');
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

  return {
    sanitizeUserId,
    getUserNotebookDir,
    getNotebookIndexFile,
    readNotebookIndex,
    searchNotebookDocs,
    readNotebookDoc,
    updateNotebookIndexIncremental
  };
}

module.exports = {
  createLocalKnowledgeNotebook
};
