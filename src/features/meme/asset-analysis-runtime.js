'use strict';

const fs = require('fs');
const config = require('../../../config');
const httpClient = require('../../../api/httpClient');
const { extractJsonSafely } = require('../../../api/parser');
const { buildRuntimePrompt } = require('../../../utils/runtimePrompts');
const memeStore = require('../../../utils/memeStore');
const {
  ensureChatCompletionsUrl,
  getAssetAnalysisApiKey,
  getAssetAnalysisBaseUrl,
  getAssetAnalysisModel
} = require('./model-config');
const { extractSelectorResponseText } = require('./context');

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

function toInlineImagePart(absolutePath, mime = '') {
  const data = fs.readFileSync(absolutePath);
  return {
    type: 'input_image',
    media_type: String(mime || memeStore.inferMimeFromExt(absolutePath) || 'image/jpeg').trim() || 'image/jpeg',
    data: data.toString('base64')
  };
}

function buildAssetAnalyzerPrompt() {
  return buildRuntimePrompt('meme-asset-analyzer');
}

function getAssetAnalysisResolvedFields(asset = {}) {
  const analysis = asset?.analysis && typeof asset.analysis === 'object' ? asset.analysis : {};
  const auto = analysis.auto && typeof analysis.auto === 'object'
    ? analysis.auto
    : memeStore.defaultResolvedAssetAnalysis();
  const overrides = analysis.overrides && typeof analysis.overrides === 'object' ? analysis.overrides : {};
  const resolved = { ...auto };
  for (const field of ASSET_ANALYSIS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, field)) continue;
    const value = overrides[field];
    const hasValue = Array.isArray(value) ? value.length > 0 : String(value || '').trim() !== '' || typeof value === 'number';
    if (hasValue) resolved[field] = value;
  }
  return resolved;
}

function resolveAssetAnalysis(asset = {}) {
  return {
    status: String(asset?.analysis?.status || 'pending').trim() || 'pending',
    version: Math.max(1, Number(asset?.analysis?.version) || 1),
    analyzedAt: Math.max(0, Number(asset?.analysis?.analyzedAt) || 0),
    model: String(asset?.analysis?.model || '').trim(),
    lastError: String(asset?.analysis?.lastError || '').trim(),
    resolved: getAssetAnalysisResolvedFields(asset),
    overrides: asset?.analysis?.overrides && typeof asset.analysis.overrides === 'object' ? asset.analysis.overrides : {},
    auto: asset?.analysis?.auto && typeof asset.analysis.auto === 'object' ? asset.analysis.auto : memeStore.defaultResolvedAssetAnalysis()
  };
}

function buildAssetAnalysisRequestContent(asset = {}, absolutePath = '') {
  return [
    { type: 'text', text: 'Analyze this meme asset for follow-up meme selection.' },
    { type: 'text', text: `assetId=${String(asset?.id || '').trim() || 'unknown'}` },
    toInlineImagePart(absolutePath, asset?.mime || '')
  ];
}

async function analyzeMemeAsset({ categoryName = '', assetId = '' } = {}) {
  if (!config.MEME_MANAGER_ASSET_ANALYSIS_ENABLED) {
    throw new Error('asset-analysis-disabled');
  }
  const category = String(categoryName || '').trim();
  const asset = memeStore.getAsset(category, assetId);
  if (!asset) throw new Error('Asset not found.');

  const absolutePath = memeStore.getAssetAbsolutePath(category, assetId);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new Error('Asset file not found.');
  }

  const apiBaseUrl = ensureChatCompletionsUrl(getAssetAnalysisBaseUrl());
  const model = getAssetAnalysisModel();
  if (!apiBaseUrl || !model) {
    throw new Error('asset-analysis-model-missing');
  }

  const response = await httpClient.postWithRetry(
    apiBaseUrl,
    {
      model,
      temperature: 0.1,
      max_tokens: 600,
      stream: false,
      messages: [
        { role: 'system', content: buildAssetAnalyzerPrompt() },
        {
          role: 'user',
          content: buildAssetAnalysisRequestContent(asset, absolutePath)
        }
      ],
      __timeoutMs: Math.max(1000, Number(config.MEME_MANAGER_ASSET_ANALYSIS_TIMEOUT_MS || 20000)),
      __trace: {
        source: 'meme_manager',
        phase: 'asset_analysis',
        purpose: 'meme_asset_analysis',
        routePolicyKey: 'meme/asset-analysis',
        topRouteType: 'vision'
      }
    },
    1,
    getAssetAnalysisApiKey()
  );

  const rawText = extractSelectorResponseText(response);
  const parsed = extractJsonSafely(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid-asset-analysis-json');
  }
  return {
    model,
    parsed: memeStore.normalizeAssetAnalysisPayload(parsed),
    rawText
  };
}

module.exports = {
  toInlineImagePart,
  buildAssetAnalyzerPrompt,
  getAssetAnalysisResolvedFields,
  resolveAssetAnalysis,
  buildAssetAnalysisRequestContent,
  analyzeMemeAsset
};
