'use strict';

const config = require('../../../config');
const {
  hashText,
  normalizeArray,
  normalizeObject,
  normalizeText
} = require('./normalization');

const DYNAMIC_CONTEXT_PLAN_VERSION = 'dynamic_context_plan_v2';
const MEMORY_RECALL_PROMPT_MIN_BUDGET_MS = 6000;
const MEMORY_RECALL_QUERY_RE = /(昨日|前天|大前天|昨天.{0,12}(?:聊|说|讲|提|做|打|玩|听|看|刷|发|买|吃|喝|练|测|试|去)|(?:今天|今日|最近).{0,12}(?:和你|我们|我).{0,12}(?:聊|说|讲|提|做|打|玩|听|看|刷|发|买|吃|喝|练|测|试|去)|刚才|刚刚|上次|之前|前面|前几天|那天|聊了什么|聊过什么|聊到哪|说了什么|讲了什么|还记得|记得|记不记得|回忆|想起来|忘了|不记得|记不得|不认识我|不认得我|你认识我吗|你认得我吗|你知道我是谁吗|往日种种|我们的过去|我们之间|接着|继续|断片|失忆|\byesterday\b|\bremember\b|\blast time\b|\bearlier\b|what did we talk|where did we leave|where did (?:i|we) put)/i;

function getConfig() {
  try {
    return require('../../../config');
  } catch (_) {
    return config;
  }
}

function resolveMainReplyAdminPromptContext(input = {}) {
  const options = normalizeObject(input.options, {});
  const routeMeta = normalizeObject(input.routeMeta || options.routeMeta, {});
  if (input.isAdmin === true || options.isAdmin === true || routeMeta.isAdmin === true || routeMeta.admin === true) return true;
  const userId = normalizeText(
    input.userId
    || options.userId
    || options.user_id
    || routeMeta.userId
    || routeMeta.user_id
    || routeMeta.senderId
    || routeMeta.sender_id
  );
  if (!userId) return false;
  const currentConfig = normalizeObject(input.config, getConfig());
  return normalizeArray(currentConfig.ADMIN_USER_IDS)
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .includes(userId);
}

function buildStableSystemPromptFingerprint(runtimeConfig = config) {
  const currentConfig = normalizeObject(runtimeConfig, config);
  const blockFingerprint = normalizeArray(currentConfig.SYSTEM_PROMPT_BLOCKS)
    .map((block) => [
      normalizeText(block?.id),
      normalizeText(block?.authority),
      normalizeText(block?.kind),
      normalizeText(block?.content),
      JSON.stringify(normalizeObject(block?.appliesWhen || block?.applies_when, {}))
    ].join('::'))
    .join('\n---\n');
  return hashText([
    normalizeText(currentConfig.SYSTEM_PROMPT),
    blockFingerprint
  ].join('\n===\n'));
}

function shouldForceMemoryContextForQuestion(question = '', options = {}) {
  if (options?.forceMemoryContext === true) return true;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  if (options?.intent?.needsMemory === true || routeMeta?.intent?.needsMemory === true) return true;
  const text = normalizeText(
    question
    || options?.cleanText
    || options?.rawText
    || routeMeta.cleanText
    || routeMeta.rawText
    || routeMeta.userText
  );
  if (!text || /^(查一下|搜索|搜一下|最新|新闻|官网|search|look up|google)\b/i.test(text)) return false;
  try {
    const { classifyMemoryNeed } = require('../../../utils/recallHeuristics');
    if (classifyMemoryNeed(text, {
      facets: options?.facets || routeMeta.facets || {},
      intent: options?.intent || routeMeta.intent || {},
      meta: routeMeta
    }).needsMemory) return true;
  } catch (_) {}
  return MEMORY_RECALL_QUERY_RE.test(text);
}

module.exports = {
  DYNAMIC_CONTEXT_PLAN_VERSION,
  MEMORY_RECALL_PROMPT_MIN_BUDGET_MS,
  MEMORY_RECALL_QUERY_RE,
  buildStableSystemPromptFingerprint,
  config,
  getConfig,
  resolveMainReplyAdminPromptContext,
  runtimeConfig: config,
  shouldForceMemoryContextForQuestion
};
