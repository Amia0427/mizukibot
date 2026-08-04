const fs = require('fs');
const path = require('path');

const EMBEDDING_BATCH_SIZE = 16;

function normalizeName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function quoteSql(value = '') {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createMaimaiVectorIndex(options = {}) {
  const dir = path.resolve(String(options.dir || '').trim());
  if (!dir) throw new Error('maimai LanceDB dir is required');
  const embeddingModel = String(options.embeddingModel || 'BAAI/bge-m3');
  const embeddingDimension = Number(options.embeddingDimension || 0);
  if (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0) throw new Error('maimai embedding dimension is required');
  const modelVersion = String(options.embeddingModelVersion || embeddingModel);
  const tablePrefix = `maimai_chart_segments_${normalizeName(embeddingModel)}_${embeddingDimension}_${normalizeName(modelVersion)}`;
  const tableNameFor = (generationId = 0) => `${tablePrefix}_g${Math.max(0, Number(generationId) || 0)}`;
  const embedTexts = options.embedTexts;
  let dbPromise = null;

  async function openDb() {
    if (!dbPromise) {
      dbPromise = (options.lancedb
        ? Promise.resolve(options.lancedb)
        : import('@lancedb/lancedb')).then((module) => module.connect(dir));
    }
    return dbPromise;
  }

  async function writeDocuments(documents = [], writeOptions = {}) {
    const rows = [];
    for (let offset = 0; offset < documents.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = documents.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      const missing = batch.filter((document) => !Array.isArray(document.vector));
      let embedded = [];
      if (missing.length > 0) {
        if (typeof embedTexts !== 'function') return { ok: false, reason: 'embedding_unavailable', vectorCount: rows.length };
        embedded = await embedTexts(missing.map((document) => document.text));
      }
      let embeddedIndex = 0;
      for (const document of batch) {
        const vector = Array.isArray(document.vector) ? document.vector : embedded[embeddedIndex++];
        if (!Array.isArray(vector) || vector.length !== embeddingDimension) {
          return { ok: false, reason: 'embedding_dimension_mismatch', vectorCount: rows.length };
        }
        rows.push({
          id: String(document.id),
          generationId: Number(document.generationId || 0),
          chartKey: String(document.chartKey || ''),
          contentHash: String(document.contentHash || ''),
          segmentIndex: Number(document.segmentIndex ?? -1),
          kind: String(document.kind || 'global'),
          text: String(document.text || ''),
          embeddingModel,
          embeddingDimension,
          vector: vector.map(Number)
        });
      }
    }
    if (rows.length === 0) {
      return { ok: true, tableName: tableNameFor(writeOptions.generationId), vectorCount: 0 };
    }
    fs.mkdirSync(dir, { recursive: true });
    const db = await openDb();
    const activeTableName = tableNameFor(writeOptions.generationId);
    await db.createTable(activeTableName, rows, { mode: 'overwrite' });
    return { ok: true, tableName: activeTableName, vectorCount: rows.length };
  }

  async function search(queryEmbedding = [], searchOptions = {}) {
    const vector = Array.isArray(queryEmbedding) ? queryEmbedding : [];
    const hashes = Array.from(new Set((searchOptions.candidateContentHashes || []).map(String).filter(Boolean)));
    if (vector.length !== embeddingDimension) return { ok: false, reason: 'embedding_dimension_mismatch', rows: [] };
    if (hashes.length === 0) return { ok: true, rows: [], mode: 'vector' };
    const db = await openDb();
    const activeTableName = String(searchOptions.tableName || tableNameFor(searchOptions.generationId));
    const table = await db.openTable(activeTableName);
    const limit = Math.max(1, Math.min(50, Number(searchOptions.limit || 10) || 10));
    const filter = `contentHash IN (${hashes.map(quoteSql).join(', ')})`;
    let query = table.vectorSearch(vector).distanceType('cosine').where(filter).limit(limit);
    const rows = await query.toArray();
    return {
      ok: true,
      tableName: activeTableName,
      mode: 'vector',
      rows: (Array.isArray(rows) ? rows : []).filter((row) => hashes.includes(String(row.contentHash)))
    };
  }

  async function searchText(text = '', searchOptions = {}) {
    if (typeof embedTexts !== 'function') return { ok: false, mode: 'sql_only', reason: 'embedding_unavailable', rows: [] };
    try {
      const vectors = await embedTexts([text]);
      const vector = vectors[0];
      if (!Array.isArray(vector)) return { ok: false, mode: 'sql_only', reason: 'embedding_failed', rows: [] };
      return search(vector, searchOptions);
    } catch (error) {
      return { ok: false, mode: 'sql_only', reason: `embedding_failed:${error.message}`, rows: [] };
    }
  }

  async function close() {
    dbPromise = null;
  }

  return { close, dir, embeddingDimension, embeddingModel, search, searchText, tableName: tablePrefix, tableNameFor, writeDocuments };
}

module.exports = {
  EMBEDDING_BATCH_SIZE,
  createMaimaiVectorIndex,
  normalizeName
};
