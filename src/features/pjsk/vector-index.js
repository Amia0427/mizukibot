const fs = require('fs');
const path = require('path');

const EMBEDDING_BATCH_SIZE = 16;

function normalizeName(value = '') {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'unknown';
}

function quoteSql(value = '') {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function createPjskVectorIndex(options = {}) {
  const dir = path.resolve(String(options.dir || '').trim());
  if (!dir) throw new Error('PJSK LanceDB dir is required');
  const embeddingModel = String(options.embeddingModel || 'BAAI/bge-m3');
  const embeddingDimension = Number(options.embeddingDimension || 0);
  if (!Number.isInteger(embeddingDimension) || embeddingDimension <= 0) throw new Error('PJSK embedding dimension is required');
  const modelVersion = String(options.embeddingModelVersion || embeddingModel);
  const tablePrefix = `pjsk_chart_documents_${normalizeName(embeddingModel)}_${embeddingDimension}_${normalizeName(modelVersion)}`;
  const tableNameFor = (generationId) => `${tablePrefix}_g${Math.max(0, Number(generationId) || 0)}`;
  const embedTexts = options.embedTexts;
  let dbPromise = null;

  async function openDb() {
    if (!dbPromise) {
      dbPromise = (options.lancedb ? Promise.resolve(options.lancedb) : import('@lancedb/lancedb'))
        .then((module) => module.connect(dir));
    }
    return dbPromise;
  }

  async function writeDocuments(documents = [], writeOptions = {}) {
    const rows = [];
    for (let offset = 0; offset < documents.length; offset += EMBEDDING_BATCH_SIZE) {
      const batch = documents.slice(offset, offset + EMBEDDING_BATCH_SIZE);
      if (typeof embedTexts !== 'function') return { ok: false, reason: 'embedding_unavailable', vectorCount: rows.length };
      const vectors = await embedTexts(batch.map((document) => document.text));
      for (let index = 0; index < batch.length; index += 1) {
        const document = batch[index];
        const vector = vectors[index];
        if (!Array.isArray(vector) || vector.length !== embeddingDimension) {
          return { ok: false, reason: 'embedding_dimension_mismatch', vectorCount: rows.length };
        }
        rows.push({
          id: document.id,
          generationId: Number(writeOptions.generationId || document.generationId || 0),
          chartKey: document.chartKey,
          contentHash: document.contentHash,
          documentHash: document.documentHash,
          segmentIndex: document.segmentIndex,
          kind: document.kind,
          text: document.text,
          embeddingModel,
          embeddingDimension,
          vector: vector.map(Number)
        });
      }
    }
    if (rows.length === 0) return { ok: true, tableName: tableNameFor(writeOptions.generationId), vectorCount: 0 };
    fs.mkdirSync(dir, { recursive: true });
    const db = await openDb();
    const tableName = tableNameFor(writeOptions.generationId);
    await db.createTable(tableName, rows, { mode: 'overwrite' });
    return { ok: true, tableName, vectorCount: rows.length };
  }

  async function searchText(text = '', searchOptions = {}) {
    if (typeof embedTexts !== 'function') return { ok: false, mode: 'sql_only', reason: 'embedding_unavailable', rows: [] };
    const generationId = Number(searchOptions.generationId || 0);
    const hashes = Array.from(new Set((searchOptions.candidateContentHashes || []).map(String).filter(Boolean)));
    if (!generationId || hashes.length === 0) return { ok: true, mode: 'vector', rows: [] };
    try {
      const vectors = await embedTexts([String(text || '')]);
      const vector = vectors[0];
      if (!Array.isArray(vector) || vector.length !== embeddingDimension) {
        return { ok: false, mode: 'sql_only', reason: 'embedding_dimension_mismatch', rows: [] };
      }
      const db = await openDb();
      const tableName = String(searchOptions.tableName || tableNameFor(generationId));
      const table = await db.openTable(tableName);
      const filter = `generationId = ${generationId} AND contentHash IN (${hashes.map(quoteSql).join(', ')})`;
      const rows = await table.vectorSearch(vector)
        .distanceType('cosine')
        .where(filter)
        .limit(Math.max(1, Math.min(50, Number(searchOptions.limit || 20) || 20)))
        .toArray();
      return {
        ok: true,
        mode: 'vector',
        tableName,
        rows: (rows || []).filter((row) => Number(row.generationId) === generationId && hashes.includes(String(row.contentHash)))
      };
    } catch (error) {
      return { ok: false, mode: 'sql_only', reason: `vector_failed:${error.message}`, rows: [] };
    }
  }

  function close() {
    dbPromise = null;
  }

  return { close, dir, embeddingDimension, embeddingModel, searchText, tableNameFor, writeDocuments };
}

module.exports = { EMBEDDING_BATCH_SIZE, createPjskVectorIndex, normalizeName };
