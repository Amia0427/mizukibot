const {
  chatHistory,
  getUserAffinityState,
  getUserImpression,
  getUserMemories,
  getUserProfile,
  getUserSummary
} = require('../../utils/memory');
const { getRecentDailySummaries } = require('../../utils/dailyJournal');
const { getSessionContextSummaryStoreSnapshot } = require('../../utils/sessionContextSummaryStore');

function clampText(value, maxChars) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return Array.from(text).slice(0, Math.max(1, Number(maxChars) || 1)).join('');
}

function normalizePrivateHistory(userId, limit = 16) {
  const items = Array.isArray(chatHistory[`direct:${userId}`]) ? chatHistory[`direct:${userId}`] : [];
  return items.slice(-Math.max(1, Number(limit) || 1)).map((item) => ({
    role: String(item?.role || '').trim() === 'assistant' ? 'assistant' : 'user',
    content: clampText(item?.content, 320)
  })).filter((item) => item.content);
}

function getRecentGroupSummaries(userId, now, limit = 2) {
  const cutoff = now - (48 * 60 * 60 * 1000);
  const snapshot = getSessionContextSummaryStoreSnapshot();
  return Object.values(snapshot.sessions || {})
    .flatMap((items) => Array.isArray(items) ? items : [])
    .filter((item) => (
      String(item?.userId || '').trim() === String(userId || '').trim()
      && String(item?.groupId || '').trim()
      && Number(item?.createdAt || 0) >= cutoff
    ))
    .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0))
    .slice(0, Math.max(1, Number(limit) || 1))
    .map((item) => ({
      groupId: String(item.groupId || '').trim(),
      createdAt: Number(item.createdAt || 0) || 0,
      summary: clampText(item.summary, 600)
    }));
}

function buildLongTermMemory(userId) {
  const profile = getUserProfile(userId) || {};
  return {
    summary: clampText(getUserSummary(userId), 800),
    impression: clampText(getUserImpression(userId), 500),
    facts: clampText(getUserMemories(userId), 1200),
    profile: {
      identities: Array.isArray(profile.identities) ? profile.identities.slice(-8) : [],
      personalityTraits: Array.isArray(profile.personality_traits) ? profile.personality_traits.slice(-8) : [],
      hobbies: Array.isArray(profile.hobbies) ? profile.hobbies.slice(-8) : [],
      likes: Array.isArray(profile.likes) ? profile.likes.slice(-8) : [],
      dislikes: Array.isArray(profile.dislikes) ? profile.dislikes.slice(-8) : [],
      goals: Array.isArray(profile.goals) ? profile.goals.slice(-8) : [],
      recentTopics: Array.isArray(profile.recent_topics) ? profile.recent_topics.slice(-8) : []
    }
  };
}

function createPrivateProactiveContextProvider(options = {}) {
  const historyLimit = Math.max(1, Number(options.historyLimit || 16) || 16);
  return async function buildPrivateProactiveContext(userId, userState, now = Date.now()) {
    const affinity = getUserAffinityState(userId) || {};
    const journal = getRecentDailySummaries(userId, 3);
    return {
      userId: String(userId || '').trim(),
      currentTime: new Date(now).toISOString(),
      privateHistory: normalizePrivateHistory(userId, historyLimit),
      relationship: {
        relationship: clampText(affinity.relationship || affinity.level, 80),
        attitude: clampText(affinity.attitude, 120),
        trustScore: Number(affinity.trust_score || 0) || 0
      },
      longTermMemory: buildLongTermMemory(userId),
      dailyJournal: clampText(journal?.text, 1800),
      groupSummaries: getRecentGroupSummaries(userId, now, 2),
      proactiveNarratives: (Array.isArray(userState?.narratives) ? userState.narratives : [])
        .slice(-6)
        .map((item) => ({ at: Number(item.at || 0) || 0, messages: item.messages }))
    };
  };
}

module.exports = {
  buildLongTermMemory,
  clampText,
  createPrivateProactiveContextProvider,
  getRecentGroupSummaries,
  normalizePrivateHistory
};
