const config = require('../../config');
const {
  getUserProfile,
  getUserSummary,
  getUserImpression,
  getUserMemories,
  memories
} = require('../memory');
const { sanitizeText } = require('./commandParser');
const { sanitizePreviewText } = require('./text');

function getProfileResult(userId) {
  return {
    profile: getUserProfile(userId) || {},
    summary: getUserSummary(userId) || '',
    impression: getUserImpression(userId) || '',
    facts: Array.isArray(memories[userId]?.facts) ? memories[userId].facts : []
  };
}

function profileArrayHits(field, values = [], score = 0.6, title = '') {
  return (Array.isArray(values) ? values : [])
    .map((value, index) => {
      const text = sanitizeText(value);
      if (!text) return null;
      return {
        ref: `mc_ref:profile:${field}:${index}`,
        source: 'profile',
        type: field,
        id: `${field}:${index}`,
        logicalId: `${field}:${index}`,
        title: title || `Profile ${field}`,
        preview: sanitizePreviewText(text, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
        text,
        score,
        updatedAt: 0,
        confidence: 0.82,
        tier: 'A',
        matchMode: 'fallback'
      };
    })
    .filter(Boolean);
}

function buildProfileSearchCandidates(userId) {
  const result = getProfileResult(userId);
  const profile = result.profile || {};
  return [
    {
      ref: 'mc_ref:profile:summary',
      source: 'profile',
      type: 'summary',
      id: 'summary',
      logicalId: 'summary',
      title: 'Profile summary',
      preview: sanitizePreviewText(result.summary, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(result.summary || ''),
      score: 0.6,
      updatedAt: 0,
      confidence: 0.9,
      tier: 'A',
      matchMode: 'lexical'
    },
    {
      ref: 'mc_ref:profile:impression',
      source: 'profile',
      type: 'impression',
      id: 'impression',
      logicalId: 'impression',
      title: 'User impression',
      preview: sanitizePreviewText(result.impression, config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(result.impression || ''),
      score: 0.64,
      updatedAt: 0,
      confidence: 0.9,
      tier: 'S',
      matchMode: 'lexical'
    },
    {
      ref: 'mc_ref:profile:facts',
      source: 'profile',
      type: 'facts',
      id: 'facts',
      logicalId: 'facts',
      title: 'Known facts',
      preview: sanitizePreviewText(getUserMemories(userId), config.MEMORY_CLI_RESULT_PREVIEW_CHARS),
      text: String(getUserMemories(userId) || ''),
      score: 0.58,
      updatedAt: 0,
      confidence: 0.8,
      tier: 'B',
      matchMode: 'lexical'
    },
    ...profileArrayHits('identities', profile.identities, 0.66, 'Identities'),
    ...profileArrayHits('likes', profile.likes, 0.7, 'Likes'),
    ...profileArrayHits('dislikes', profile.dislikes, 0.68, 'Dislikes'),
    ...profileArrayHits('goals', profile.goals, 0.69, 'Goals'),
    ...profileArrayHits('recent_topics', profile.recent_topics, 0.62, 'Recent topics'),
    ...profileArrayHits('hobbies', profile.hobbies, 0.66, 'Hobbies')
  ].filter((item) => sanitizeText(item.text));
}

function truncateProfileForOpen(profileResult = {}) {
  const profile = profileResult.profile || {};
  const maxItems = Math.max(1, Number(config.MEMORY_CLI_PROFILE_FIELD_MAX_ITEMS || 4));
  const limitList = (values) => (Array.isArray(values) ? values : []).slice(0, maxItems).map((item) => sanitizePreviewText(item, 160)).filter(Boolean);
  return {
    profile: {
      identities: limitList(profile.identities),
      personality_traits: limitList(profile.personality_traits),
      hobbies: limitList(profile.hobbies),
      likes: limitList(profile.likes),
      dislikes: limitList(profile.dislikes),
      goals: limitList(profile.goals),
      recent_topics: limitList(profile.recent_topics),
      relation_stage: sanitizePreviewText(profile.relation_stage, 80)
    },
    summary: sanitizePreviewText(profileResult.summary, 1000),
    impression: sanitizePreviewText(profileResult.impression, 1000),
    facts: (Array.isArray(profileResult.facts) ? profileResult.facts : []).slice(0, maxItems).map((item) => sanitizePreviewText(item, 180))
  };
}

module.exports = {
  buildProfileSearchCandidates,
  getProfileResult,
  profileArrayHits,
  truncateProfileForOpen
};
