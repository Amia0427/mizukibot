const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { embedTexts } = require('../../../utils/memoryEmbeddingClient');
const { createMaimaiCatalogStore } = require('./catalog-store');
const { createMaimaiPlayerStore } = require('./player-store');
const { createMaimaiSourceClient } = require('./source-client');
const { createSummaryGenerator } = require('./summary');
const { createModelSummaryPolisher } = require('./summary-polisher');
const { createMaimaiVectorIndex } = require('./vector-index');
const { createMaimaiRetrievalService } = require('./retrieval-service');
const { createMaimaiSyncWorker } = require('./sync-worker');
const { createMaimaiSyncScheduler } = require('./sync-scheduler');

let runtime = null;

function isMaimaiEnabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.MAIMAI_ENABLED || '').trim());
}

function createMaimaiRuntime(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || process.env.DATA_DIR || config.DATA_DIR));
  const maimaiDir = path.join(dataDir, 'maimai');
  fs.mkdirSync(maimaiDir, { recursive: true });
  const catalog = options.catalog || createMaimaiCatalogStore({ dbFile: path.join(maimaiDir, 'catalog.sqlite') });
  const playerStore = options.playerStore || createMaimaiPlayerStore({
    dbFile: path.join(maimaiDir, 'player.sqlite'),
    masterKey: process.env.MAIMAI_CREDENTIAL_MASTER_KEY
  });
  const vectorIndex = options.vectorIndex || createMaimaiVectorIndex({
    dir: path.join(maimaiDir, 'lancedb'),
    embeddingModel: process.env.MAIMAI_EMBEDDING_MODEL || 'BAAI/bge-m3',
    embeddingModelVersion: process.env.MAIMAI_EMBEDDING_MODEL_VERSION || 'bge-m3-v1',
    embeddingDimension: Number(process.env.MAIMAI_EMBEDDING_DIMENSION || 1024),
    embedTexts
  });
  const retrieval = options.retrieval || createMaimaiRetrievalService({ catalog, vectorIndex, playerStore, embedTexts });
  const sourceClient = options.sourceClient || createMaimaiSourceClient();
  let summaryGenerator = options.summaryGenerator;
  if (!summaryGenerator) {
    const summaryModel = process.env.MAIMAI_SUMMARY_MODEL || config.MEMORY_MODEL || config.AI_MODEL;
    const summaryModelVersion = process.env.MAIMAI_SUMMARY_MODEL_VERSION || summaryModel || 'deterministic';
    const polish = createModelSummaryPolisher({
      apiBaseUrl: process.env.MAIMAI_SUMMARY_API_BASE_URL || config.MEMORY_API_BASE_URL || config.API_BASE_URL,
      apiKey: process.env.MAIMAI_SUMMARY_API_KEY || config.MEMORY_API_KEY || config.API_KEY,
      model: summaryModel
    });
    summaryGenerator = createSummaryGenerator({
      polish,
      modelVersion: polish ? summaryModelVersion : 'deterministic',
      cache: {
        get: (key) => catalog.getSummaryCache(key),
        set: (key, value) => catalog.setSummaryCache(key, value)
      }
    });
  }
  const syncWorker = options.syncWorker || createMaimaiSyncWorker({ catalog, sourceClient, vectorIndex, summaryGenerator });
  const syncScheduler = options.syncScheduler || createMaimaiSyncScheduler({
    catalog,
    worker: syncWorker,
    timezone: process.env.MAIMAI_SYNC_TIMEZONE || 'Asia/Shanghai'
  });
  return { catalog, playerStore, retrieval, sourceClient, summaryGenerator, syncWorker, syncScheduler, vectorIndex };
}

function getMaimaiRuntime() {
  if (!isMaimaiEnabled()) return null;
  if (!runtime) runtime = createMaimaiRuntime();
  return runtime;
}

function peekMaimaiRuntime() {
  return runtime;
}

function setMaimaiRuntimeForTests(nextRuntime) {
  runtime = nextRuntime || null;
}

function closeMaimaiRuntime() {
  if (!runtime) return;
  runtime.catalog?.close?.();
  runtime.playerStore?.close?.();
  runtime.vectorIndex?.close?.();
  runtime = null;
}

module.exports = {
  closeMaimaiRuntime,
  createMaimaiRuntime,
  getMaimaiRuntime,
  peekMaimaiRuntime,
  isMaimaiEnabled,
  setMaimaiRuntimeForTests
};
