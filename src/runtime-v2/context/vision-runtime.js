'use strict';

const { trimTextByTokenBudget } = require('../../../utils/contextBudget');
const runtimeConfig = require('../../../config');

function normalizeVisionImageUrls(imageUrl = null, imageUrlsOrOptions = null) {
  const values = [];
  if (Array.isArray(imageUrl)) {
    values.push(...imageUrl);
  } else if (imageUrl) {
    values.push(imageUrl);
  }
  if (Array.isArray(imageUrlsOrOptions)) {
    values.push(...imageUrlsOrOptions);
  } else if (imageUrlsOrOptions && typeof imageUrlsOrOptions === 'object' && Array.isArray(imageUrlsOrOptions.imageUrls)) {
    values.push(...imageUrlsOrOptions.imageUrls);
  }

  const seen = new Set();
  return values
    .map((url) => String(url || '').trim())
    .filter((url) => {
      if (!url || seen.has(url)) return false;
      seen.add(url);
      return true;
    });
}

function buildVisionTextPart(question = '', imageCount = 0) {
  const rawUserText = String(question || '').trim();
  const userTextBudget = Math.max(256, Number(runtimeConfig.VISION_ROUTE_USER_TEXT_MAX_TOKENS || 6000) || 6000);
  const userText = rawUserText
    ? trimTextByTokenBudget(rawUserText, userTextBudget, 'tail')
    : '用户仅发送了图片。';
  const count = Math.max(1, Number(imageCount || 0) || 1);
  return [
    `用户原文：${userText}`,
    `图片数量：${count}`
  ].join('\n\n');
}

function normalizeVisionEvidenceText(text = '', tokenBudget = null) {
  const budget = Math.max(256, Number(tokenBudget || runtimeConfig.VISION_ROUTE_USER_TEXT_MAX_TOKENS || 6000) || 6000);
  return trimTextByTokenBudget(String(text || '').trim(), budget, 'tail');
}

function buildVisionLiteTextContent(question = '', imageCount = 0, tokenBudget = null) {
  return buildVisionTextPart(
    normalizeVisionEvidenceText(question, tokenBudget),
    imageCount
  );
}

function buildVisionMessageContent(...args) {
  const [question = '', imageUrl = null, imageUrlsOrOptions = null] = args;
  const imageUrls = normalizeVisionImageUrls(imageUrl, imageUrlsOrOptions);
  if (imageUrls.length === 0) return question || '';
  return [
    { type: 'text', text: buildVisionLiteTextContent(question, imageUrls.length) },
    ...imageUrls.map((url) => ({ type: 'image_url', image_url: { url } }))
  ];
}

function shouldBypassHumanizerForPolicy(policyKey = '') {
  const normalized = String(policyKey || '').trim().toLowerCase();
  return ['lookup/', 'transform/', 'plan/', 'act/', 'tool/'].some((prefix) => normalized.startsWith(prefix));
}

module.exports = {
  buildVisionLiteTextContent,
  buildVisionMessageContent,
  shouldBypassHumanizerForPolicy
};
