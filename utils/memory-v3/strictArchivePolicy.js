'use strict';

const crypto = require('crypto');
const { canonicalizeText, normalizeText } = require('./helpers');

const STRICT_ARCHIVE_POLICY_VERSION = 'strict-v1';
const ACTIVE_STATUS = new Set(['', 'active']);
const VALID_SCOPE_TYPES = new Set(['personal', 'group', 'task', 'working', 'session']);
const PLACEHOLDER_VALUES = new Set([
  '-',
  '...',
  'n/a',
  'na',
  'null',
  'undefined',
  'todo',
  'tbd',
  'placeholder',
  '占位符',
  '待补充'
]);

const PROMPT_POLLUTION_PATTERNS = [
  /<\/?(?:system|assistant|developer|tool|function)(?:\s[^>]*)?>/i,
  /\[(?:system|developer|tool)(?:\s+message)?\]/i,
  /\b(?:root_)?system_prompt\b/i,
  /\bignore (?:all |any )?(?:previous|prior|above) instructions?\b/i,
  /\b(?:reveal|print|show) (?:the )?(?:hidden|system|developer) (?:prompt|instructions?)\b/i,
  /(?:忽略|无视)(?:以上|之前|先前|所有)?(?:的)?(?:指令|规则|提示词)/,
  /(?:系统|开发者|工具)(?:提示词|指令|调用参数)(?:如下|是|为|内容)/,
  /\btool_calls?\b.*\b(?:arguments?|function)\b/i
];

const ASSISTANT_REPLY_PATTERNS = [
  /^(?:抱歉|对不起|很遗憾)[，,。\s]*(?:我)?(?:无法|不能|没法|未能)/,
  /^(?:i(?:'m| am) sorry|sorry)[,\s]+(?:but\s+)?i (?:cannot|can't|could not|was unable)/i,
  /^(?:我)?(?:无法|不能|未能)(?:完成|执行|处理|回答|访问|获取|调用)/,
  /^(?:作为|身为)(?:一个)?(?:ai|人工智能|语言模型)/i,
  /^(?:请求|任务|工具调用|执行)(?:失败|出错|超时)/
];

function stableHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeStatus(node = {}) {
  return normalizeText(node.status || 'active').toLowerCase();
}

function isActiveNode(node = {}) {
  return ACTIVE_STATUS.has(normalizeStatus(node));
}

function normalizedCanonical(node = {}) {
  return canonicalizeText(node.canonicalKey || node.canonicalText || node.text);
}

function normalizedScopeType(node = {}) {
  return normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
}

function duplicateGroupKey(node = {}) {
  const canonical = normalizedCanonical(node);
  if (!canonical) return '';
  const scopeType = normalizedScopeType(node);
  const scopeId = scopeType === 'group'
    ? normalizeText(node.groupId)
    : scopeType === 'session'
      ? `${normalizeText(node.userId)}|${normalizeText(node.sessionKey || node.sessionId)}`
      : normalizeText(node.userId);
  if (!scopeId) return '';
  return [
    scopeType,
    scopeId,
    normalizeText(node.type || node.memoryKind || 'fact').toLowerCase(),
    normalizeText(node.semanticSlot || node.fieldKey).toLowerCase(),
    canonical
  ].join('|');
}

function nodeRank(node = {}) {
  const sourceKind = normalizeText(node.sourceKind || node.source).toLowerCase();
  return [
    sourceKind === 'explicit' || sourceKind === 'manual' ? 1 : 0,
    Number(node.confidence || 0) || 0,
    Number(node.importance || 0) || 0,
    Number(node.evidenceCount || 0) || 0,
    Number(node.updatedAt || node.createdAt || node.ts || 0) || 0
  ];
}

function compareDuplicateWinners(left = {}, right = {}) {
  const leftRank = nodeRank(left);
  const rightRank = nodeRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    if (rightRank[index] !== leftRank[index]) return rightRank[index] - leftRank[index];
  }
  return normalizeText(left.id || left.nodeId).localeCompare(normalizeText(right.id || right.nodeId));
}

function findDuplicateLosers(nodes = []) {
  const groups = new Map();
  for (const node of Array.isArray(nodes) ? nodes : []) {
    if (!node || !isActiveNode(node)) continue;
    const key = duplicateGroupKey(node);
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(node);
  }

  const losers = new Map();
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const ordered = group.slice().sort(compareDuplicateWinners);
    const winnerId = normalizeText(ordered[0].id || ordered[0].nodeId);
    for (const node of ordered.slice(1)) {
      const sourceId = normalizeText(node.id || node.nodeId);
      if (sourceId) losers.set(sourceId, { duplicateKey: key, winnerId });
    }
  }
  return losers;
}

function hasPromptPollution(node = {}) {
  const text = normalizeText(node.text);
  return text ? PROMPT_POLLUTION_PATTERNS.some((pattern) => pattern.test(text)) : false;
}

function isAssistantReplyPollution(node = {}) {
  const role = normalizeText(
    node.sourceRole
    || node.role
    || node.speaker
    || node.meta?.sourceRole
    || node.payload?.sourceRole
  ).toLowerCase();
  const sourceKind = normalizeText(node.sourceKind || node.source).toLowerCase();
  const assistantSource = role === 'assistant'
    || ['assistant', 'assistant_reply', 'model', 'llm_response'].includes(sourceKind);
  if (!assistantSource) return false;
  const text = normalizeText(node.text);
  return text ? ASSISTANT_REPLY_PATTERNS.some((pattern) => pattern.test(text)) : false;
}

function isPlaceholder(node = {}) {
  const text = normalizeText(node.text).toLowerCase();
  return !text || PLACEHOLDER_VALUES.has(text);
}

function hasInvalidScope(node = {}) {
  const scopeType = normalizedScopeType(node);
  if (!VALID_SCOPE_TYPES.has(scopeType)) return true;
  if (scopeType === 'group') return !normalizeText(node.groupId);
  if (scopeType === 'session') {
    return !normalizeText(node.userId) || !normalizeText(node.sessionKey || node.sessionId);
  }
  return !normalizeText(node.userId);
}

function buildDecision(node = {}, reason = '', evidence = {}) {
  const sourceId = normalizeText(node.id || node.nodeId);
  const evidencePayload = {
    policyVersion: STRICT_ARCHIVE_POLICY_VERSION,
    reason,
    sourceId,
    canonicalKey: normalizedCanonical(node),
    scopeType: normalizedScopeType(node),
    evidence
  };
  return {
    node,
    sourceId,
    reason,
    previousStatus: normalizeStatus(node) || 'active',
    evidence,
    evidenceHash: stableHash(evidencePayload)
  };
}

function classifyStrictArchiveCandidates(nodes = []) {
  const activeNodes = (Array.isArray(nodes) ? nodes : []).filter((node) => node && isActiveNode(node));
  const byId = new Map(activeNodes.map((node) => [normalizeText(node.id || node.nodeId), node]));
  const duplicateLosers = findDuplicateLosers(activeNodes);
  const decisions = [];

  for (const node of activeNodes) {
    const sourceId = normalizeText(node.id || node.nodeId);
    if (!sourceId) continue;
    const duplicate = duplicateLosers.get(sourceId);
    if (duplicate) {
      decisions.push(buildDecision(node, 'deterministic_duplicate_loser', duplicate));
      continue;
    }
    const supersededBy = normalizeText(node.supersededBy || node.payload?.supersededBy);
    const successor = supersededBy ? byId.get(supersededBy) : null;
    if (successor && supersededBy !== sourceId && isActiveNode(successor)) {
      decisions.push(buildDecision(node, 'valid_superseded_reference', { supersededBy }));
      continue;
    }
    if (hasPromptPollution(node)) {
      decisions.push(buildDecision(node, 'prompt_instruction_pollution', { canonicalKey: normalizedCanonical(node) }));
      continue;
    }
    if (isAssistantReplyPollution(node)) {
      decisions.push(buildDecision(node, 'assistant_reply_misattributed_as_user_fact', {
        sourceRole: normalizeText(node.sourceRole || node.role || node.speaker || node.meta?.sourceRole),
        sourceKind: normalizeText(node.sourceKind || node.source)
      }));
      continue;
    }
    if (isPlaceholder(node)) {
      decisions.push(buildDecision(node, 'empty_or_placeholder_content', { normalizedText: normalizeText(node.text).toLowerCase() }));
      continue;
    }
    if (hasInvalidScope(node)) {
      decisions.push(buildDecision(node, 'definitively_invalid_scope', {
        scopeType: normalizedScopeType(node),
        userId: normalizeText(node.userId),
        groupId: normalizeText(node.groupId),
        sessionKey: normalizeText(node.sessionKey || node.sessionId)
      }));
    }
  }

  return decisions.sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

function buildStrictArchiveInputHash(nodes = []) {
  const stableNodes = (Array.isArray(nodes) ? nodes : [])
    .filter(Boolean)
    .map((node) => ({
      id: normalizeText(node.id || node.nodeId),
      userId: normalizeText(node.userId),
      groupId: normalizeText(node.groupId),
      sessionKey: normalizeText(node.sessionKey || node.sessionId),
      scopeType: normalizedScopeType(node),
      type: normalizeText(node.type || node.memoryKind),
      semanticSlot: normalizeText(node.semanticSlot || node.fieldKey),
      canonicalKey: normalizedCanonical(node),
      status: normalizeStatus(node),
      supersededBy: normalizeText(node.supersededBy || node.payload?.supersededBy),
      sourceKind: normalizeText(node.sourceKind || node.source),
      sourceRole: normalizeText(node.sourceRole || node.role || node.speaker || node.meta?.sourceRole),
      text: normalizeText(node.text),
      confidence: Number(node.confidence || 0) || 0,
      importance: Number(node.importance || 0) || 0,
      evidenceCount: Number(node.evidenceCount || 0) || 0,
      updatedAt: Number(node.updatedAt || node.createdAt || node.ts || 0) || 0
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return stableHash(stableNodes);
}

module.exports = {
  STRICT_ARCHIVE_POLICY_VERSION,
  buildStrictArchiveInputHash,
  classifyStrictArchiveCandidates,
  createStrictArchiveDecision: buildDecision,
  hasInvalidScope,
  hasPromptPollution,
  isAssistantReplyPollution,
  isPlaceholder
};
