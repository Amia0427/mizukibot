function createMemoryContextPromptSegmentHelpers(deps = {}) {
  const {
    clampPromptMessage,
    getPromptTokenLimit,
    limitPromptText
  } = deps;

  function buildPromptTexts(input = {}) {
    const {
      dailyJournalTimestamp,
      promptDailyJournalText,
      promptGroupMemoryText,
      promptLongTermProfileSourceText,
      promptRetrievedMemorySourceText,
      styleSignalText,
      taskMemoryText
    } = input;
    const promptRetrievedMemoryText = limitPromptText(
      promptRetrievedMemorySourceText,
      getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420),
      'tail'
    );
    const promptStyleSignalsText = limitPromptText(
      styleSignalText,
      getPromptTokenLimit('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80),
      'tail'
    );
    const promptTaskMemoryText = limitPromptText(
      taskMemoryText,
      getPromptTokenLimit('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160),
      'tail'
    );
    const promptGroupMemoryTrimmedText = limitPromptText(
      promptGroupMemoryText,
      getPromptTokenLimit('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160),
      'tail'
    );
    const dailyJournalTokenLimit = dailyJournalTimestamp
      ? Math.max(
        getPromptTokenLimit('MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', 160),
        getPromptTokenLimit('MAIN_PROMPT_TARGET_DAILY_JOURNAL_MAX_TOKENS', 420)
      )
      : getPromptTokenLimit('MAIN_PROMPT_DAILY_JOURNAL_MAX_TOKENS', 160);
    const dailyJournalTrimStrategy = dailyJournalTimestamp ? 'head' : 'tail';
    const promptDailyJournalTrimmedText = limitPromptText(
      promptDailyJournalText,
      dailyJournalTokenLimit,
      dailyJournalTrimStrategy
    );
    const promptLongTermProfileText = limitPromptText(
      promptLongTermProfileSourceText,
      getPromptTokenLimit('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220),
      'tail'
    );

    return {
      dailyJournalTokenLimit,
      dailyJournalTrimStrategy,
      promptDailyJournalTrimmedText,
      promptGroupMemoryTrimmedText,
      promptLongTermProfileText,
      promptRetrievedMemoryText,
      promptStyleSignalsText,
      promptTaskMemoryText
    };
  }

  function buildPromptSegments(texts = {}) {
    const {
      dailyJournalTokenLimit,
      dailyJournalTrimStrategy,
      promptDailyJournalTrimmedText,
      promptGroupMemoryTrimmedText,
      promptLongTermProfileText,
      promptRetrievedMemoryText,
      promptStyleSignalsText,
      promptTaskMemoryText
    } = texts;

    return {
      retrievedMemory: clampPromptMessage('RetrievedMemory', promptRetrievedMemoryText, getPromptTokenLimit('MAIN_PROMPT_RETRIEVED_MEMORY_MAX_TOKENS', 420), 'tail'),
      dailyJournal: clampPromptMessage('DailyJournal', promptDailyJournalTrimmedText, dailyJournalTokenLimit, dailyJournalTrimStrategy),
      taskMemory: clampPromptMessage('TaskMemory', promptTaskMemoryText, getPromptTokenLimit('MAIN_PROMPT_TASK_MEMORY_MAX_TOKENS', 160), 'tail'),
      groupMemory: clampPromptMessage('GroupMemory', promptGroupMemoryTrimmedText, getPromptTokenLimit('MAIN_PROMPT_GROUP_MEMORY_MAX_TOKENS', 160), 'tail'),
      styleSignals: clampPromptMessage('StyleSignals', promptStyleSignalsText, getPromptTokenLimit('MAIN_PROMPT_STYLE_SIGNALS_MAX_TOKENS', 80), 'tail'),
      longTermProfile: clampPromptMessage('LongTermProfile', promptLongTermProfileText, getPromptTokenLimit('MAIN_PROMPT_LONG_TERM_PROFILE_MAX_TOKENS', 220), 'tail')
    };
  }

  return {
    buildPromptSegments,
    buildPromptTexts
  };
}

module.exports = {
  createMemoryContextPromptSegmentHelpers
};
