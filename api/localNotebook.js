const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

const NOTEBOOK_ROOT = path.join(config.DATA_DIR, 'notebook');

function getToolPolicyHelpers() {
  const policy = require('../utils/toolPolicy');
  return {
    sanitizeUserId: typeof policy.sanitizeUserId === 'function'
      ? policy.sanitizeUserId
      : ((value, fallback = '') => String(value || fallback || '').trim()),
    mustStayInside: typeof policy.mustStayInside === 'function'
      ? policy.mustStayInside
      : ((_root, target) => path.resolve(target))
  };
}

function normalizeUserId(userId) {
  const { sanitizeUserId } = getToolPolicyHelpers();
  return sanitizeUserId(userId, 'public') || 'public';
}

function getUserNotebookDir(userId) {
  return path.join(NOTEBOOK_ROOT, normalizeUserId(userId));
}

function getUserIndexFile(userId) {
  return path.join(getUserNotebookDir(userId), 'index.json');
}

function ensureUserNotebook(userId) {
  const dir = getUserNotebookDir(userId);
  const idx = getUserIndexFile(userId);

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  if (!fs.existsSync(idx)) {
    fs.writeFileSync(
      idx,
      JSON.stringify({ docs: [], file_state: {}, updated_at: new Date().toISOString() }, null, 2),
      'utf-8'
    );
  }
}

function readIndex(userId) {
  ensureUserNotebook(userId);
  const idxFile = getUserIndexFile(userId);
  try {
    const obj = JSON.parse(fs.readFileSync(idxFile, 'utf-8'));
    if (!obj || typeof obj !== 'object') return { docs: [], file_state: {}, updated_at: new Date().toISOString() };
    if (!Array.isArray(obj.docs)) obj.docs = [];
    if (!obj.file_state || typeof obj.file_state !== 'object') obj.file_state = {};
    return obj;
  } catch (_) {
    return { docs: [], file_state: {}, updated_at: new Date().toISOString() };
  }
}

function writeIndex(userId, indexObj) {
  ensureUserNotebook(userId);
  indexObj.updated_at = new Date().toISOString();
  fs.writeFileSync(getUserIndexFile(userId), JSON.stringify(indexObj, null, 2), 'utf-8');
}

function sha256(text) {
  return crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\u4e00-\u9fa5a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

function chunkText(text, chunkSize = 450, overlap = 80) {
  const t = String(text || '').replace(/\r/g, '').trim();
  if (!t) return [];
  const chunks = [];
  let i = 0;
  let paraNo = 1;

  while (i < t.length) {
    const end = Math.min(t.length, i + chunkSize);
    const part = t.slice(i, end);
    chunks.push({
      chunk_index: chunks.length,
      para_no: paraNo++,
      text: part
    });
    if (end >= t.length) break;
    i = Math.max(0, end - overlap);
  }
  return chunks;
}

function scoreChunk(queryTokens, chunkTextValue) {
  const ct = tokenize(chunkTextValue);
  if (!ct.length || !queryTokens.length) return 0;
  let hit = 0;
  for (const q of queryTokens) {
    if (ct.includes(q)) hit += 1;
  }
  const density = hit / Math.max(1, ct.length);
  return hit * 10 + density * 100;
}

function safeDocId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function isTextFile(name) {
  return /\.(md|txt)$/i.test(String(name || ''));
}

function getFileMeta(fullPath) {
  try {
    const st = fs.statSync(fullPath);
    return {
      mtimeMs: st.mtimeMs,
      size: st.size
    };
  } catch (_) {
    return null;
  }
}

function upsertDocByPath(indexObj, newDoc) {
  const i = indexObj.docs.findIndex((d) => d.source_path === newDoc.source_path);
  if (i >= 0) indexObj.docs[i] = newDoc;
  else indexObj.docs.push(newDoc);
}

function removeDocByPath(indexObj, sourcePath) {
  indexObj.docs = indexObj.docs.filter((d) => d.source_path !== sourcePath);
}

async function notebook_reindex_folder(userId, folderPath, options = {}) {
  const { mustStayInside } = getToolPolicyHelpers();
  const uid = normalizeUserId(userId);
  ensureUserNotebook(uid);

  const notebookDir = getUserNotebookDir(uid);
  const requestedDir = String(folderPath || '').trim() || notebookDir;
  const dir = mustStayInside(notebookDir, requestedDir, 'Notebook reindex path');
  if (!fs.existsSync(dir)) return `Directory does not exist: ${dir}`;

  const incremental = options && options.incremental !== false;
  const indexObj = readIndex(uid);

  const files = fs.readdirSync(dir).filter(isTextFile);
  const fullPaths = files.map((f) => path.join(dir, f));

  const pathSet = new Set(fullPaths);
  const stalePaths = Object.keys(indexObj.file_state || {}).filter((p) => !pathSet.has(p));
  for (const sp of stalePaths) {
    delete indexObj.file_state[sp];
    removeDocByPath(indexObj, sp);
  }

  let indexed = 0;
  let skipped = 0;
  let dedup = 0;
  let updated = 0;

  for (const full of fullPaths) {
    const safeFull = mustStayInside(notebookDir, full, 'Notebook file path');
    const meta = getFileMeta(safeFull);
    if (!meta) continue;

    const prev = indexObj.file_state[safeFull];
    const shouldFastSkip = incremental
      && prev
      && Number(prev.mtimeMs) === Number(meta.mtimeMs)
      && Number(prev.size) === Number(meta.size);

    if (shouldFastSkip) {
      skipped += 1;
      continue;
    }

    const content = fs.readFileSync(safeFull, 'utf-8');
    const h = sha256(content);
    const oldDoc = indexObj.docs.find((d) => d.source_path === safeFull);
    const hashExistsInOthers = indexObj.docs.find(
      (d) => d.content_hash === h && d.source_path !== safeFull
    );

    if (hashExistsInOthers) {
      indexObj.file_state[safeFull] = { mtimeMs: meta.mtimeMs, size: meta.size, hash: h };
      if (oldDoc) removeDocByPath(indexObj, safeFull);
      dedup += 1;
      continue;
    }

    const chunks = chunkText(content);
    const doc = {
      id: oldDoc?.id || safeDocId(),
      title: path.basename(safeFull),
      source_path: safeFull,
      created_at: oldDoc?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      content_hash: h,
      chunks
    };

    upsertDocByPath(indexObj, doc);
    indexObj.file_state[safeFull] = { mtimeMs: meta.mtimeMs, size: meta.size, hash: h };

    if (oldDoc) updated += 1;
    else indexed += 1;
  }

  writeIndex(uid, indexObj);

  return JSON.stringify({
    ok: true,
    user_id: uid,
    folder: dir,
    incremental,
    total_docs: indexObj.docs.length,
    indexed,
    updated,
    skipped,
    dedup,
    files_scanned: files.length
  });
}

async function notebook_add_document(userId, title, content) {
  const { mustStayInside } = getToolPolicyHelpers();
  const uid = normalizeUserId(userId);
  ensureUserNotebook(uid);

  const t = String(title || '').trim();
  const c = String(content || '').trim();

  if (!t || !c) return 'Please provide userId, title, and content.';

  const idx = readIndex(uid);
  const h = sha256(c);

  const same = idx.docs.find((d) => d.content_hash === h);
  if (same) {
    return JSON.stringify({
      ok: true,
      dedup: true,
      user_id: uid,
      doc_id: same.id,
      title: same.title,
      citation_hint: `[${same.title} ?1]`
    });
  }

  const safeName = t.replace(/[\\/:*?"<>|]/g, '_');
  const userDir = getUserNotebookDir(uid);
  const savePath = mustStayInside(userDir, path.join(userDir, `${safeName}.md`), 'Notebook save path');
  fs.writeFileSync(savePath, c, 'utf-8');

  const chunks = chunkText(c);
  const doc = {
    id: safeDocId(),
    title: `${safeName}.md`,
    source_path: savePath,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    content_hash: h,
    chunks
  };

  idx.docs.push(doc);

  const meta = getFileMeta(savePath);
  idx.file_state[savePath] = {
    mtimeMs: meta?.mtimeMs || Date.now(),
    size: meta?.size || Buffer.byteLength(c, 'utf8'),
    hash: h
  };

  writeIndex(uid, idx);

  return JSON.stringify({
    ok: true,
    dedup: false,
    user_id: uid,
    saved: savePath,
    chunks: chunks.length,
    hash: h
  });
}

async function notebook_list_docs(userId) {
  const uid = normalizeUserId(userId);
  const idx = readIndex(uid);

  return JSON.stringify({
    user_id: uid,
    total: idx.docs.length,
    docs: idx.docs.map((d) => ({
      id: d.id,
      title: d.title,
      source_path: d.source_path,
      hash: d.content_hash,
      chunks: Array.isArray(d.chunks) ? d.chunks.length : 0,
      created_at: d.created_at,
      updated_at: d.updated_at
    }))
  });
}

async function notebook_search(userId, query, top_k = 5) {
  const uid = normalizeUserId(userId);
  const q = String(query || '').trim();
  if (!q) return 'Please provide query.';

  const idx = readIndex(uid);
  if (!idx.docs.length) {
    return JSON.stringify({
      user_id: uid,
      query: q,
      total_hits: 0,
      top_k: 0,
      results: [],
      message: 'Notebook is empty. Add documents or reindex first.'
    });
  }

  const qTokens = tokenize(q);
  const hits = [];

  for (const doc of idx.docs) {
    const chunks = Array.isArray(doc.chunks) ? doc.chunks : [];
    for (const ch of chunks) {
      const text = typeof ch === 'string' ? ch : (ch.text || '');
      const paraNo = typeof ch === 'string' ? 1 : (Number(ch.para_no) || (Number(ch.chunk_index) + 1 || 1));
      const chunkIndex = typeof ch === 'string' ? 0 : (Number(ch.chunk_index) || 0);
      const score = scoreChunk(qTokens, text);
      if (score > 0) {
        hits.push({
          doc_title: doc.title,
          source_path: doc.source_path,
          chunk_index: chunkIndex,
          para_no: paraNo,
          score,
          citation: `[${doc.title} ?${paraNo}]`,
          snippet: text.slice(0, 320)
        });
      }
    }
  }

  hits.sort((a, b) => b.score - a.score);
  const k = Math.max(1, Math.min(20, Number(top_k) || 5));
  const top = hits.slice(0, k);

  return JSON.stringify({
    user_id: uid,
    query: q,
    total_hits: hits.length,
    top_k: top.length,
    results: top
  });
}

module.exports = {
  readIndex,
  writeIndex,
  chunkText,
  scoreChunk,
  notebook_reindex_folder,
  notebook_add_document,
  notebook_list_docs,
  notebook_search
};
