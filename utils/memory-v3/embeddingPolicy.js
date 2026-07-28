const { normalizeText } = require('./helpers');
const { isMemoryNotRecallable, lifecycleStatusOf } = require('./recallFilter');
const { isPollutedMemoryText } = require('../recallPollutionGuard');

const RAW_TYPES = new Set(['turn', 'raw_turn', 'user_turn', 'assistant_turn', 'model_reply', 'prompt', 'system_prompt']);
const ALLOWED_TYPES = new Set([
  'fact',
  'preference',
  'like',
  'dislike',
  'identity',
  'task',
  'relationship',
  'relationship_style',
  'style',
  'image',
  'image_visual_summary',
  'episode',
  'daily_journal',
  'daily_journal_segment',
  'daily_journal_monthly',
  'monthly',
  'turn_summary',
  'persona_summary',
  'persona_impression',
  'bot_persona'
]);

function isSummaryNode(node = {}) {
  const type = normalizeText(node.type || node.memoryKind).toLowerCase();
  const source = normalizeText(node.source || node.sourceKind).toLowerCase();
  return type.includes('summary')
    || type.includes('journal')
    || type === 'episode'
    || source.includes('journal')
    || source.includes('diary');
}

function shouldVectorizeMemoryNode(node = {}) {
  if (!node || typeof node !== 'object') return false;
  const text = normalizeText(node.text);
  if (!text || isPollutedMemoryText(text, { allowBenignContext: false })) return false;
  if (isMemoryNotRecallable(node)) return false;
  const status = normalizeText(node.status).toLowerCase();
  const lifecycle = lifecycleStatusOf(node);
  if (status === 'archived' || status === 'superseded' || status === 'suspect' || lifecycle === 'archived' || lifecycle === 'superseded' || lifecycle === 'suspect') return false;
  const type = normalizeText(node.type || node.memoryKind).toLowerCase();
  const source = normalizeText(node.source || node.sourceKind).toLowerCase();
  if (RAW_TYPES.has(type) || /(?:^|_)(?:raw|turn|reply|prompt)(?:$|_)/i.test(type)) return false;
  if (/(?:model[_ -]?reply|assistant[_ -]?reply|system[_ -]?prompt|user[_ -]?turn)/i.test(source)) return false;
  if (isSummaryNode(node)) return true;
  if (ALLOWED_TYPES.has(type)) return true;
  if (['explicit', 'extractor', 'image', 'post_reply_worker', 'passive_group_reply'].includes(source)) {
    const confidence = Number(node.confidence);
    return !Number.isFinite(confidence) || confidence >= 0.65;
  }
  const evidenceTier = normalizeText(node.evidenceTier).toLowerCase();
  return evidenceTier === 'strict' || evidenceTier === 'confirmed' || status === 'active';
}

module.exports = {
  shouldVectorizeMemoryNode
};
