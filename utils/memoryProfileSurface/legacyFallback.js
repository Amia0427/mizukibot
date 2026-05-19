function createLegacyProfileFallback(deps = {}) {
  const {
    formatLegacyProfile,
    getUserImpression,
    getUserProfile,
    getUserSummary,
    joinList,
    sanitizeText,
    shouldUseFullProfileSurface
  } = deps;

  function buildLegacyFallback(userId, options = {}) {
    const profile = getUserProfile(userId);
    const summary = sanitizeText(getUserSummary(userId));
    const impression = sanitizeText(getUserImpression(userId));
    const profileText = shouldUseFullProfileSurface(options)
      ? formatLegacyProfile(profile)
      : [
          profile?.relation_stage ? `关系阶段：${sanitizeText(profile.relation_stage)}` : '',
          joinList(profile?.identities) ? `身份信息：${joinList(profile.identities)}` : '',
          joinList(profile?.goals) ? `目标：${joinList(profile.goals)}` : ''
        ].filter(Boolean).join('\n');
    const includeSummary = options.includeLegacySummary === true;
    const lines = [
      profileText,
      includeSummary && summary ? `总体总结：${summary}` : '',
      includeSummary && impression ? `总体印象：${impression}` : ''
    ].filter(Boolean);
    return {
      text: lines.join('\n'),
      profile,
      summary,
      impression
    };
  }

  return {
    buildLegacyFallback
  };
}

module.exports = {
  createLegacyProfileFallback
};
