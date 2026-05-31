const {
  canonicalizeText,
  normalizeText
} = require('../helpers');
const {
  BOT_PERSONA_FIELDS,
  RELATIONSHIP_STYLE_FIELDS
} = require('./fields');

function buildProfileConflictKey(node = {}) {
  if (node.conflictKey) return normalizeText(node.conflictKey).toLowerCase();
  const userId = normalizeText(node.userId);
  const scope = normalizeText(node.scopeType || 'personal').toLowerCase() || 'personal';
  const fieldKey = normalizeText(node.fieldKey).toLowerCase();
  const semanticSlot = normalizeText(node.semanticSlot || fieldKey).toLowerCase();
  const canonical = canonicalizeText(node.text);
  if (!userId || !canonical) return '';
  if (fieldKey === 'preference_like' || fieldKey === 'preference_dislike') {
    return `${userId}|${scope}|preference|${canonical}`;
  }
  if (fieldKey === 'identity') return `${userId}|${scope}|identity|${semanticSlot || 'identity'}`;
  if (fieldKey === 'goal') return `${userId}|${scope}|goal|${semanticSlot || 'goal'}`;
  if (RELATIONSHIP_STYLE_FIELDS.has(fieldKey)) return `${userId}|${scope}|relationship_style|${fieldKey}`;
  if (BOT_PERSONA_FIELDS.has(fieldKey)) return `${userId}|${scope}|bot_persona|${fieldKey}`;
  return '';
}

function rankProfileNode(node = {}) {
  const statusRank = node.status === 'active' ? 2 : 1;
  const sourceRank = node.sourceKind === 'explicit' ? 4 : (node.sourceKind === 'migration_bootstrap' ? 2 : 1);
  const tierRank = node.evidenceTier === 'strict' ? 3 : 1;
  const typeRank = String(node.type || '').toLowerCase() === 'dislike' ? 0.2 : 0;
  return (sourceRank * 1000)
    + (tierRank * 100)
    + (statusRank * 20)
    + (Number(node.stabilityScore || 0) * 10)
    + Number(node.confidence || 0)
    + typeRank;
}

function resolveProfileNodeConflicts(nodes = []) {
  const sorted = (Array.isArray(nodes) ? nodes : []).slice().sort((a, b) => {
    if (rankProfileNode(b) !== rankProfileNode(a)) return rankProfileNode(b) - rankProfileNode(a);
    return Number(b.updatedAt || 0) - Number(a.updatedAt || 0);
  });
  const winners = new Map();
  const selected = [];
  const conflicts = [];
  for (const node of sorted) {
    const key = buildProfileConflictKey(node);
    if (!key) {
      selected.push(node);
      continue;
    }
    if (!winners.has(key)) {
      winners.set(key, node);
      selected.push(node);
      continue;
    }
    const winner = winners.get(key);
    const winnerText = normalizeText(winner?.text || '');
    if (!winnerText) {
      selected.push(node);
      conflicts.push({
        userId: node.userId,
        conflictKey: key,
        fieldKey: node.fieldKey,
        canonicalKey: node.canonicalKey,
        id: node.id,
        text: node.text,
        suppressedBy: '',
        winnerText: '',
        winnerId: '',
        reason: 'profile_conflict_empty_winner_ignored'
      });
      continue;
    }
    node.suppressedBy = String(winner?.id || '');
    conflicts.push({
      userId: node.userId,
      conflictKey: key,
      fieldKey: node.fieldKey,
      canonicalKey: node.canonicalKey,
      id: node.id,
      text: node.text,
      suppressedBy: node.suppressedBy,
      winnerText,
      winnerId: winner?.id || '',
      reason: 'profile_conflict'
    });
  }
  return { selected, conflicts };
}

module.exports = {
  buildProfileConflictKey,
  rankProfileNode,
  resolveProfileNodeConflicts
};
