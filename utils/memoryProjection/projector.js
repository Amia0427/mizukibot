const config = require('../../config');
const { getMemoryItems } = require('../vectorMemory');
const {
  LEGACY_MEMORY_LIMITS,
  defaultFavorite,
  defaultMemory,
  defaultProfile,
  normalizeUniqueStringList,
  safeReadJson,
  sanitizeText
} = require('./common');
const {
  buildConflictGroups,
  chooseConflictWinner,
  dedupeAndSort
} = require('./conflicts');

function projectUserProfile(userId, items = [], favorite = null) {
  const profile = defaultProfile();
  const memory = defaultMemory();
  memory.profile = profile;

  const activeItems = dedupeAndSort(
    items.filter((item) => String(item?.status || '').toLowerCase() !== 'archived')
  );

  const conflictGroups = buildConflictGroups(activeItems);
  const suppressedIds = new Set();
  for (const group of conflictGroups.values()) {
    const winner = chooseConflictWinner(group);
    for (const item of group) {
      if (!winner || String(item.id) !== String(winner.id)) suppressedIds.add(String(item.id));
    }
  }

  for (const item of activeItems) {
    if (suppressedIds.has(String(item.id))) continue;
    const type = String(item.type || '').trim().toLowerCase();
    const text = sanitizeText(item.text || item.canonicalText || '', LEGACY_MEMORY_LIMITS.factLength);
    if (!text) continue;

    if (type === 'summary' && !memory.summary) {
      memory.summary = sanitizeText(text, LEGACY_MEMORY_LIMITS.summaryLength);
      continue;
    }
    if (type === 'impression' && !memory.impression) {
      memory.impression = sanitizeText(text, LEGACY_MEMORY_LIMITS.impressionLength);
      continue;
    }
    if (type === 'identity') {
      profile.identities = normalizeUniqueStringList([...profile.identities, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'personality') {
      profile.personality_traits = normalizeUniqueStringList([...profile.personality_traits, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'hobby') {
      profile.hobbies = normalizeUniqueStringList([...profile.hobbies, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'like') {
      profile.likes = normalizeUniqueStringList([...profile.likes, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'dislike') {
      profile.dislikes = normalizeUniqueStringList([...profile.dislikes, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'goal') {
      profile.goals = normalizeUniqueStringList([...profile.goals, text], LEGACY_MEMORY_LIMITS.profileItems, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }
    if (type === 'topic') {
      profile.recent_topics = normalizeUniqueStringList([...profile.recent_topics, text], LEGACY_MEMORY_LIMITS.recentTopics, LEGACY_MEMORY_LIMITS.profileItemLength);
      continue;
    }

    memory.facts = normalizeUniqueStringList(
      [...memory.facts, text],
      LEGACY_MEMORY_LIMITS.facts,
      LEGACY_MEMORY_LIMITS.factLength
    );
  }

  if (favorite && typeof favorite === 'object') {
    profile.relation_stage = sanitizeText(
      favorite.relationship || favorite.level || profile.relation_stage || '陌生人',
      LEGACY_MEMORY_LIMITS.relationStageLength
    ) || '陌生人';
  }

  return memory;
}

function buildProjection() {
  const items = getMemoryItems();
  const favorites = safeReadJson(config.DATA_FILE, {});
  const users = new Set([
    ...Object.keys(favorites || {}),
    ...items.map((item) => String(item.userId || '').trim()).filter(Boolean)
  ]);

  const projection = {
    version: 1,
    generatedAt: Date.now(),
    users: {},
    favorites: {}
  };

  for (const userId of users) {
    const userItems = items.filter((item) => String(item.userId || '').trim() === userId);
    const favorite = favorites[userId] && typeof favorites[userId] === 'object'
      ? { ...defaultFavorite(), ...favorites[userId] }
      : defaultFavorite();
    projection.users[userId] = projectUserProfile(userId, userItems, favorite);
    projection.favorites[userId] = favorite;
  }

  return projection;
}

module.exports = {
  buildProjection,
  projectUserProfile
};
