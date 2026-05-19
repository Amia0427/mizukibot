function createMemoryContextProfilePayloadHelpers(deps = {}) {
  const {
    buildStableProfileText,
    config,
    getUserAffinityState,
    getUserImpression,
    getUserProfile,
    getUserSummary,
    sanitizeText
  } = deps;

  function buildProfilePayload(userId, question = '', options = {}) {
    const profile = getUserProfile(userId);
    const stableProfile = buildStableProfileText(userId, {
      question,
      includeWeakForProfileQuery: true,
      disableStableProfile: options.disableStableProfile,
      forceStableProfile: options.forceStableProfile,
      legacyFallbackEnabled: options.legacyProfileFallbackEnabled
    });
    const profilePersona = stableProfile.persona && typeof stableProfile.persona === 'object'
      ? stableProfile.persona
      : {};
    const profileDisabled = stableProfile.disabled === true;
    const injectPersonaBlocks = config.MEMORY_PROFILE_INJECT_PERSONA_BLOCKS === true
      || options.injectPersonaProfileBlocks === true;
    const effectiveSummary = profileDisabled || !injectPersonaBlocks
      ? ''
      : sanitizeText(profilePersona.summary || (stableProfile.legacyFallbackUsed ? stableProfile.summary : ''));
    const effectiveImpression = profileDisabled || !injectPersonaBlocks
      ? ''
      : sanitizeText(profilePersona.impression || (stableProfile.legacyFallbackUsed ? stableProfile.impression : ''));

    return {
      affinityState: getUserAffinityState(userId, options),
      effectiveImpression,
      effectiveSummary,
      profile,
      profilePersona,
      stableProfile
    };
  }

  return {
    buildProfilePayload
  };
}

module.exports = {
  createMemoryContextProfilePayloadHelpers
};
