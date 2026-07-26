'use strict';

const config = require('../../../config');

function ensureChatCompletionsUrl(url) {
  const raw = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

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

module.exports = {
  ensureChatCompletionsUrl,
  getSelectorBaseUrl,
  getSelectorApiKey,
  getSelectorModel,
  getAssetAnalysisBaseUrl,
  getAssetAnalysisApiKey,
  getAssetAnalysisModel
};
