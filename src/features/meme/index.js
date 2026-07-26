'use strict';

const { analyzeMemeAsset, resolveAssetAnalysis } = require('./asset-analysis-runtime');
const {
  cleanupExpiredSessions,
  consumePendingUploadFromMessage,
  handleAdminCommand,
  isSurfaceEnabled,
  parseMemeCommand,
  runMemeTest,
  startUploadSession
} = require('./admin-runtime');
const { evaluateMemeGate } = require('./gate');
const { initializeMemeManager } = require('./lifecycle');
const { maybeSendMemeFollowup } = require('./followup');
const { drainReindexQueue, getReindexStatus } = require('./reindex-runtime');
const { pickBestAssetForSelection, selectCategory } = require('./selector-runtime');

module.exports = {
  analyzeMemeAsset,
  cleanupExpiredSessions,
  consumePendingUploadFromMessage,
  drainReindexQueue,
  getReindexStatus,
  handleAdminCommand,
  initializeMemeManager,
  isSurfaceEnabled,
  maybeSendMemeFollowup,
  parseMemeCommand,
  pickBestAssetForSelection,
  resolveAssetAnalysis,
  runMemeTest,
  selectCategory,
  startUploadSession,
  evaluateMemeGate
};
