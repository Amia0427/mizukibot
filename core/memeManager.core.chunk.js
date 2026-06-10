const fs = require('fs');
const path = require('path');
const axios = require('axios');
const config = require('../config');
const httpClient = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../api/parser');
const { getApiProvider } = require('../utils/modelProvider');
const { buildRuntimePrompt } = require('../utils/runtimePrompts');
const memeStore = require('../utils/memeStore');
const { classifyReplyFailure } = require('../utils/replyFailure');
const { getRecentMessages } = require('../utils/groupAwarenessState');
const { normalizeResponseIntent } = require('./routeSchema');
const { isAdmin } = require('./router');
const { assertSafeHttpUrl } = require('../utils/networkSafety');

const uploadSessions = new Map();
const followupRuntime = new Map();
let runtimeStoreCache = { groups: {}, assets: {} };
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

const MOOD_ALIASES = new Map([
  ['praise', 'praise'],
  ['夸奖', 'praise'],
  ['认同', 'praise'],
  ['表扬', 'praise'],
  ['playful', 'playful'],
  ['调皮', 'playful'],
  ['玩笑', 'playful'],
  ['可爱', 'playful'],
  ['轻松', 'playful'],
  ['confused', 'confused'],
  ['疑惑', 'confused'],
  ['装傻', 'confused'],
  ['没懂', 'confused'],
  ['comfort', 'comfort'],
  ['安慰', 'comfort'],
  ['难过', 'comfort'],
  ['伤心', 'comfort'],
  ['annoyed', 'annoyed'],
  ['嫌弃', 'annoyed'],
  ['生气', 'annoyed'],
  ['不爽', 'annoyed'],
  ['none', 'none']
]);

const INTENSITY_ALIASES = new Map([
  ['low', 'low'],
  ['低', 'low'],
  ['medium', 'medium'],
  ['中', 'medium'],
  ['high', 'high'],
  ['高', 'high']
]);

function ensureChatCompletionsUrl(url) {
  const raw = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

const ASSET_ANALYSIS_FIELDS = Object.freeze([
  'summary',
  'primaryMood',
  'secondaryMoods',
  'intensity',
  'confidence',
  'expressionTags',
  'sceneTags',
  'styleTags',
  'subjectTags',
  'textContent',
  'textTags',
  'preferredContexts',
  'avoidContexts'
]);

function getSelectorBaseUrl() {
  return String(config.AI_ROUTER_BASE_URL || config.API_BASE_URL || '').trim();
}

function getSelectorApiKey() {
  return String(config.AI_ROUTER_API_KEY || config.API_KEY || '').trim() || null;
}

function getSelectorModel() {
  return String(config.AI_ROUTER_MODEL || config.AI_MODEL || '').trim() || 'gpt-5.4';
}

function getAssetAnalysisBaseUrl() {
  return String(config.IMAGE_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getAssetAnalysisApiKey() {
  return String(config.IMAGE_API_KEY || config.API_KEY || '').trim() || null;
}

function getAssetAnalysisModel() {
  return String(config.MEME_MANAGER_ASSET_ANALYSIS_MODEL || config.IMAGE_MODEL || '').trim();
}

function ensureRuntimeStoreShape(input = {}) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const groupsInput = source.groups && typeof source.groups === 'object' ? source.groups : {};
  const assetsInput = source.assets && typeof source.assets === 'object' ? source.assets : {};
  const groups = {};
  const assets = {};

  for (const [groupId, state] of Object.entries(groupsInput)) {
    groups[String(groupId || '').trim()] = {
      lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0),
      recentAssetIds: (Array.isArray(state?.recentAssetIds) ? state.recentAssetIds : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
      recentCategoryNames: (Array.isArray(state?.recentCategoryNames) ? state.recentCategoryNames : [])
        .map((item) => String(item || '').trim())
        .filter(Boolean),
      lastMood: String(state?.lastMood || '').trim()
    };
  }

  for (const [assetId, state] of Object.entries(assetsInput)) {
    assets[String(assetId || '').trim()] = {
      sentCount: Math.max(0, Number(state?.sentCount) || 0),
      lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0)
    };
  }

  return { groups, assets };
}

function safeReadRuntimeStore() {
  try {
    if (!fs.existsSync(config.MEME_MANAGER_RUNTIME_FILE)) {
      return ensureRuntimeStoreShape();
    }
    const raw = fs.readFileSync(config.MEME_MANAGER_RUNTIME_FILE, 'utf8').trim();
    if (!raw) return ensureRuntimeStoreShape();
    return ensureRuntimeStoreShape(JSON.parse(raw));
  } catch (error) {
    console.error('[meme-manager] failed to read runtime store:', error?.message || String(error));
    return ensureRuntimeStoreShape();
  }
}

function persistRuntimeStore() {
  const serialized = JSON.stringify(runtimeStoreCache, null, 2);
  const target = config.MEME_MANAGER_RUNTIME_FILE;
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, serialized, 'utf8');
  fs.renameSync(temp, target);
}

function loadRuntimeStore() {
  runtimeStoreCache = safeReadRuntimeStore();
  return runtimeStoreCache;
}

