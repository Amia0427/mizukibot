'use strict';

const { LONG_ABSENCE_MS, normalizeText } = require('./definitions');
const { formatCharacterState } = require('./format');

function buildVariablePromptContext(snapshot = {}) {
  const relationship = snapshot.relationship || {};
  const stage = normalizeText(relationship.stageLabel || '陌生人', 32) || '陌生人';
  const boundary = normalizeText(relationship.boundaryLabel || '保持边界', 32) || '保持边界';
  const attitude = normalizeText(relationship.attitude || '中立、保持距离', 72) || '中立、保持距离';
  const character = formatCharacterState(snapshot);
  const lastInteractionAt = Number(relationship.lastInteractionAt || snapshot.lastInteractionAt || 0) || 0;
  const longAbsent = lastInteractionAt > 0
    && Number(snapshot.asOf || Date.now()) - lastInteractionAt >= LONG_ABSENCE_MS;
  return [
    '[关系与角色状态]',
    `我们目前是${stage}，相处边界是${boundary}，对用户的稳定态度是${attitude}。`,
    `我现在${character}`,
    longAbsent ? '我们已经有一段时间没有联系，但既有关系没有因此改变。' : '',
    '根据这些状态自然调整语气、社交距离和主动性。'
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildVariablePromptContext
};
