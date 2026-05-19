const LEGACY_MEMORY_LIMITS = Object.freeze({
  facts: 30,
  factLength: 400,
  profileItems: 20,
  profileItemLength: 160,
  recentTopics: 12,
  summaryLength: 1200,
  impressionLength: 800,
  relationStageLength: 32,
  relationshipLength: 32,
  attitudeLength: 120,
  affinityReasonLength: 160
});

function clampText(value, maxLength) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const limit = Math.max(1, Number(maxLength) || 1);
  return text.length > limit ? text.slice(0, limit) : text;
}

function normalizeUniqueStringList(values, itemLimit, itemMaxLength) {
  const source = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();

  for (const raw of source) {
    const text = clampText(raw, itemMaxLength);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= itemLimit) break;
  }

  return out;
}

function clampNumber(value, min, max, fallback = 0) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, num));
}

function defaultFavorite() {
  return {
    points: 0,
    level: '陌生人',
    relationship: '陌生人',
    attitude: '中立、保持距离',
    trust_score: 0,
    last_affinity_reason: '',
    last_affinity_source: '',
    last_affinity_update_at: 0,
    scope: 'global',
    last_morning: '',
    last_night: '',
    group_id: '',
    last_group_seen_at: 0
  };
}

function defaultProfile() {
  return {
    identities: [],
    personality_traits: [],
    hobbies: [],
    likes: [],
    dislikes: [],
    goals: [],
    relation_stage: '陌生人',
    recent_topics: []
  };
}

function defaultMemory() {
  return {
    facts: [],
    profile: defaultProfile(),
    summary: '',
    impression: ''
  };
}

function sanitizeLegacyMemoryEntry(entry) {
  const old = entry && typeof entry === 'object' ? entry : {};
  const profile = old.profile && typeof old.profile === 'object' ? old.profile : {};

  return {
    facts: normalizeUniqueStringList(
      old.facts,
      LEGACY_MEMORY_LIMITS.facts,
      LEGACY_MEMORY_LIMITS.factLength
    ),
    profile: {
      ...defaultProfile(),
      identities: normalizeUniqueStringList(
        profile.identities,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      personality_traits: normalizeUniqueStringList(
        profile.personality_traits,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      hobbies: normalizeUniqueStringList(
        profile.hobbies,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      likes: normalizeUniqueStringList(
        profile.likes,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      dislikes: normalizeUniqueStringList(
        profile.dislikes,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      goals: normalizeUniqueStringList(
        profile.goals,
        LEGACY_MEMORY_LIMITS.profileItems,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      recent_topics: normalizeUniqueStringList(
        profile.recent_topics,
        LEGACY_MEMORY_LIMITS.recentTopics,
        LEGACY_MEMORY_LIMITS.profileItemLength
      ),
      relation_stage: clampText(profile.relation_stage || '陌生人', LEGACY_MEMORY_LIMITS.relationStageLength) || '陌生人'
    },
    summary: clampText(old.summary, LEGACY_MEMORY_LIMITS.summaryLength),
    impression: clampText(old.impression, LEGACY_MEMORY_LIMITS.impressionLength)
  };
}

module.exports = {
  LEGACY_MEMORY_LIMITS,
  clampText,
  normalizeUniqueStringList,
  clampNumber,
  defaultFavorite,
  defaultProfile,
  defaultMemory,
  sanitizeLegacyMemoryEntry
};
