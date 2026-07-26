'use strict';

const config = require('../../../config');
const memeStore = require('../../../utils/memeStore');
const { getAssetAnalysisModel } = require('./model-config');
const { analyzeMemeAsset } = require('./asset-analysis-runtime');

const reindexQueue = [];

const reindexQueueSet = new Set();

const reindexState = {
  running: false,
  activeTask: null,
  processed: 0,
  failed: 0,
  lastError: '',
  lastStartedAt: 0,
  lastFinishedAt: 0
};

function getReindexTaskKey(categoryName = '', assetId = '') {
  return `${String(categoryName || '').trim()}::${String(assetId || '').trim()}`;
}

function getReindexStatus() {
  return {
    queued: reindexQueue.length,
    running: reindexState.running,
    activeTask: reindexState.activeTask ? { ...reindexState.activeTask } : null,
    processed: reindexState.processed,
    failed: reindexState.failed,
    lastError: reindexState.lastError,
    lastStartedAt: reindexState.lastStartedAt,
    lastFinishedAt: reindexState.lastFinishedAt
  };
}

function enqueueReindexTasks(tasks = []) {
  let enqueued = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const categoryName = String(task?.categoryName || '').trim();
    const assetId = String(task?.assetId || '').trim();
    if (!categoryName || !assetId) continue;
    const key = getReindexTaskKey(categoryName, assetId);
    if (reindexQueueSet.has(key)) continue;
    reindexQueue.push({ categoryName, assetId });
    reindexQueueSet.add(key);
    enqueued += 1;
  }
  void drainReindexQueue();
  return enqueued;
}

async function processReindexTask(task = {}) {
  const categoryName = String(task.categoryName || '').trim();
  const assetId = String(task.assetId || '').trim();
  const now = Date.now();
  try {
    const analysisResult = await analyzeMemeAsset({ categoryName, assetId });
    memeStore.updateAssetAnalysis(categoryName, assetId, {
      status: 'ready',
      version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
      analyzedAt: now,
      model: analysisResult.model,
      lastError: '',
      auto: analysisResult.parsed
    });
    reindexState.processed += 1;
    return { ok: true };
  } catch (error) {
    memeStore.updateAssetAnalysis(categoryName, assetId, {
      status: 'failed',
      version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
      analyzedAt: now,
      model: getAssetAnalysisModel(),
      lastError: error?.message || String(error)
    });
    reindexState.failed += 1;
    reindexState.lastError = error?.message || String(error);
    return { ok: false, error };
  }
}

async function drainReindexQueue() {
  if (reindexState.running) return;
  reindexState.running = true;
  reindexState.lastStartedAt = Date.now();
  try {
    while (reindexQueue.length > 0) {
      const task = reindexQueue.shift();
      const key = getReindexTaskKey(task?.categoryName, task?.assetId);
      reindexQueueSet.delete(key);
      reindexState.activeTask = task ? { ...task } : null;
      await processReindexTask(task);
    }
  } finally {
    reindexState.activeTask = null;
    reindexState.running = false;
    reindexState.lastFinishedAt = Date.now();
  }
}

module.exports = {
  getReindexTaskKey,
  getReindexStatus,
  enqueueReindexTasks,
  processReindexTask,
  drainReindexQueue
};
