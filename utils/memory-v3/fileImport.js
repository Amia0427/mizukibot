const fs = require('fs');
const path = require('path');
const {
  canonicalizeText,
  clampText,
  normalizeText
} = require('./helpers');
const {
  normalizeCategory,
  normalizeIntent,
  normalizePrivacyLevel,
  normalizeTags
} = require('./categoryMetadata');
const { appendVersionedMemoryUpdate } = require('./versionedUpdate');
const { materializeMemoryViews } = require('./materializer');

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);

function normalizeImportTags(values = []) {
  if (Array.isArray(values)) return normalizeTags(values, 24);
  return normalizeTags(String(values || '').split(','), 24);
}

function isSupportedMemoryImportFile(filePath = '') {
  return SUPPORTED_EXTENSIONS.has(path.extname(String(filePath || '')).toLowerCase());
}

function readImportTextFile(filePath = '') {
  const resolved = path.resolve(String(filePath || ''));
  if (!resolved) throw new Error('file path is required');
  if (!fs.existsSync(resolved)) throw new Error(`file not found: ${resolved}`);
  const stat = fs.statSync(resolved);
  if (!stat.isFile()) throw new Error(`not a file: ${resolved}`);
  if (!isSupportedMemoryImportFile(resolved)) {
    throw new Error(`unsupported memory import extension: ${path.extname(resolved) || 'none'}`);
  }
  const maxBytes = Math.max(1024, Number(process.env.MEMORY_FILE_IMPORT_MAX_BYTES || 1024 * 1024) || 1024 * 1024);
  if (stat.size > maxBytes) throw new Error(`file too large for memory import: ${stat.size} > ${maxBytes}`);
  return {
    filePath: resolved,
    fileName: path.basename(resolved),
    extension: path.extname(resolved).toLowerCase(),
    text: fs.readFileSync(resolved, 'utf8')
  };
}

function splitLongText(text = '', maxChars = 1400) {
  const value = normalizeText(text);
  if (!value) return [];
  const limit = Math.max(240, Number(maxChars || 1400) || 1400);
  if (value.length <= limit) return [value];
  const chunks = [];
  let cursor = 0;
  while (cursor < value.length) {
    let end = Math.min(value.length, cursor + limit);
    const boundary = value.slice(cursor, end).search(/(?:\n\n|[。！？.!?]\s)/g);
    if (boundary > 200 && cursor + boundary < end) end = cursor + boundary + 1;
    chunks.push(value.slice(cursor, end));
    cursor = end;
  }
  return chunks.map(normalizeText).filter(Boolean);
}

function splitMarkdownChunks(text = '', options = {}) {
  const maxChars = Math.max(240, Number(options.maxChunkChars || 1400) || 1400);
  const lines = String(text || '').split(/\r?\n/);
  const sections = [];
  let currentTitle = '';
  let buffer = [];
  const flush = () => {
    const body = normalizeText(buffer.join('\n'));
    if (body) {
      for (const chunk of splitLongText(body, maxChars)) {
        sections.push({
          title: currentTitle,
          text: currentTitle ? `${currentTitle}\n${chunk}` : chunk
        });
      }
    }
    buffer = [];
  };
  for (const line of lines) {
    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (heading) {
      flush();
      currentTitle = normalizeText(heading[2]);
      continue;
    }
    buffer.push(line);
  }
  flush();
  if (sections.length > 0) return sections;
  return splitParagraphChunks(text, options);
}

function splitParagraphChunks(text = '', options = {}) {
  const maxChars = Math.max(240, Number(options.maxChunkChars || 1400) || 1400);
  const paragraphs = String(text || '')
    .split(/\n\s*\n/g)
    .map(normalizeText)
    .filter(Boolean);
  const chunks = [];
  let buffer = '';
  for (const paragraph of paragraphs.length ? paragraphs : splitLongText(text, maxChars)) {
    const next = buffer ? `${buffer}\n${paragraph}` : paragraph;
    if (next.length > maxChars && buffer) {
      chunks.push({ title: '', text: buffer });
      buffer = paragraph;
    } else {
      buffer = next;
    }
  }
  if (buffer) chunks.push({ title: '', text: buffer });
  return chunks.flatMap((chunk) => splitLongText(chunk.text, maxChars).map((textPart) => ({
    title: chunk.title || '',
    text: textPart
  })));
}

function splitMemoryImportChunks(text = '', options = {}) {
  const extension = String(options.extension || '').toLowerCase();
  const chunks = extension === '.md' || extension === '.markdown'
    ? splitMarkdownChunks(text, options)
    : splitParagraphChunks(text, options);
  return chunks
    .map((chunk) => ({
      title: normalizeText(chunk.title),
      text: clampText(chunk.text, Math.max(400, Number(options.eventMaxChars || 4000) || 4000))
    }))
    .filter((chunk) => chunk.text.length >= Math.max(8, Number(options.minChunkChars || 16) || 16));
}

function buildImportEvent(chunk = {}, context = {}) {
  const category = normalizeCategory(context.category || 'file_import') || 'file_import';
  const tags = normalizeImportTags(['file_import', context.fileName, ...(Array.isArray(context.tags) ? context.tags : [])]);
  const text = normalizeText(chunk.text);
  const canonicalKey = normalizeText([
    'file_import',
    context.userId || context.groupId || 'global',
    context.fileName,
    chunk.title,
    canonicalizeText(text).slice(0, 120)
  ].filter(Boolean).join('|')).toLowerCase();
  return {
    type: 'memory_confirmed',
    userId: normalizeText(context.userId),
    sessionKey: normalizeText(context.sessionKey),
    groupId: normalizeText(context.groupId),
    channelId: normalizeText(context.channelId),
    sessionId: normalizeText(context.sessionId),
    routePolicyKey: normalizeText(context.routePolicyKey),
    topRouteType: normalizeText(context.topRouteType),
    scopeType: normalizeText(context.scopeType || (context.groupId ? 'group' : 'personal')).toLowerCase() || 'personal',
    source: 'file_import',
    sourceKind: 'file_import',
    status: 'active',
    confidence: Number(context.confidence || 0.9) || 0.9,
    importance: Number(context.importance || 0.75) || 0.75,
    evidenceCount: 1,
    memoryKind: normalizeText(context.memoryKind || 'document'),
    semanticSlot: normalizeText(context.semanticSlot || (category === 'preference' ? 'preference_like' : 'file_import')),
    canonicalKey,
    text,
    payload: {
      type: normalizeText(context.type || 'fact'),
      fieldKey: normalizeText(context.fieldKey || context.semanticSlot || (category === 'preference' ? 'preference_like' : 'file_import')),
      category,
      tags,
      intent: normalizeIntent(context.intent || 'bulk_import'),
      privacyLevel: normalizePrivacyLevel(context.privacyLevel || 'private'),
      fileName: normalizeText(context.fileName),
      filePath: normalizeText(context.filePath),
      fileTitle: normalizeText(chunk.title),
      chunkIndex: Number(chunk.chunkIndex || 0) || 0,
      chunkCount: Number(context.chunkCount || 0) || 0,
      importedAt: Number(context.importedAt || Date.now()) || Date.now()
    }
  };
}

async function importMemoryFile(options = {}) {
  const userId = normalizeText(options.userId);
  const groupId = normalizeText(options.groupId);
  if (!userId && !groupId) throw new Error('userId or groupId is required for memory import');
  const file = readImportTextFile(options.filePath || options.file);
  const chunks = splitMemoryImportChunks(file.text, {
    ...options,
    extension: file.extension
  }).map((chunk, index, list) => ({
    ...chunk,
    chunkIndex: index,
    chunkCount: list.length
  }));
  const importedAt = Number(options.now || Date.now()) || Date.now();
  const context = {
    ...options,
    userId,
    groupId,
    fileName: file.fileName,
    filePath: options.storeAbsolutePath === true ? file.filePath : file.fileName,
    category: options.category || 'file_import',
    tags: normalizeImportTags(options.tags),
    chunkCount: chunks.length,
    importedAt
  };
  const events = chunks.map((chunk) => buildImportEvent(chunk, context));
  if (options.dryRun === true) {
    return {
      ok: true,
      dryRun: true,
      file: file.filePath,
      chunks: chunks.length,
      events
    };
  }
  const results = [];
  for (const event of events) {
    results.push(await appendVersionedMemoryUpdate(event, {
      threshold: options.similarThreshold,
      enableVersionedUpdate: options.enableVersionedUpdate !== false
    }));
  }
  const materialize = options.materialize === false
    ? null
    : materializeMemoryViews({
        force: true,
        scheduleEmbeddingBackfill: options.scheduleEmbeddingBackfill !== false
      });
  return {
    ok: true,
    dryRun: false,
    file: file.filePath,
    chunks: chunks.length,
    created: results.filter((item) => item.action === 'created').length,
    updated: results.filter((item) => item.action === 'updated').length,
    results,
    materialize
  };
}

module.exports = {
  buildImportEvent,
  importMemoryFile,
  isSupportedMemoryImportFile,
  readImportTextFile,
  splitMemoryImportChunks
};
