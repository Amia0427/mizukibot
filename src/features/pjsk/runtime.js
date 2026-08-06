const fs = require('fs');
const path = require('path');
const config = require('../../../config');
const { embedTexts } = require('../../../utils/memoryEmbeddingClient');
const { createPjskCatalogStore } = require('./catalog-store');
const { createPjskCoverCache } = require('./cover-cache');
const { isPjskEnabled } = require('./feature-flags');
const { createPjskRetrievalService } = require('./retrieval-service');
const { createPjskSourceClient } = require('./source-client');
const { createPjskSyncScheduler } = require('./sync-scheduler');
const { createPjskSyncWorker } = require('./sync-worker');
const { createPjskVectorIndex } = require('./vector-index');

let runtime = null;

function createPjskRuntime(options = {}) {
  const dataDir = path.resolve(String(options.dataDir || process.env.DATA_DIR || config.DATA_DIR));
  const pjskDir = path.join(dataDir, 'pjsk');
  fs.mkdirSync(pjskDir, { recursive: true });
  const catalog = options.catalog || createPjskCatalogStore({ dbFile: path.join(pjskDir, 'catalog.sqlite') });
  const vectorIndex = options.vectorIndex || createPjskVectorIndex({
    dir: path.join(pjskDir, 'lancedb'),
    embeddingModel: process.env.PJSK_EMBEDDING_MODEL || 'BAAI/bge-m3',
    embeddingModelVersion: process.env.PJSK_EMBEDDING_MODEL_VERSION || 'bge-m3-v1',
    embeddingDimension: Number(process.env.PJSK_EMBEDDING_DIMENSION || 1024),
    embedTexts
  });
  const sourceClient = options.sourceClient || createPjskSourceClient({
    susConcurrency: Number(process.env.PJSK_SUS_DOWNLOAD_CONCURRENCY || 8)
  });
  const retrieval = options.retrieval || createPjskRetrievalService({ catalog, vectorIndex });
  const syncWorker = options.syncWorker || createPjskSyncWorker({ catalog, sourceClient, vectorIndex });
  const syncScheduler = options.syncScheduler || createPjskSyncScheduler({ catalog, worker: syncWorker });
  const coverCache = options.coverCache || createPjskCoverCache({ dir: path.join(pjskDir, 'covers') });
  return { catalog, coverCache, retrieval, sourceClient, syncScheduler, syncWorker, vectorIndex };
}

function getPjskRuntime() {
  if (!isPjskEnabled()) return null;
  if (!runtime) runtime = createPjskRuntime();
  return runtime;
}

function peekPjskRuntime() {
  return runtime;
}

function setPjskRuntimeForTests(nextRuntime) {
  runtime = nextRuntime || null;
}

function closePjskRuntime() {
  if (!runtime) return;
  runtime.catalog?.close?.();
  runtime.vectorIndex?.close?.();
  runtime = null;
}

module.exports = {
  closePjskRuntime,
  createPjskRuntime,
  getPjskRuntime,
  isPjskEnabled,
  peekPjskRuntime,
  setPjskRuntimeForTests
};
