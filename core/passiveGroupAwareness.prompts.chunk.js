function getReplyTypeGuidance(replyType) {
  switch (String(replyType || '')) {
    case 'presence_ack':
      return 'Reply style: presence_ack. Briefly acknowledge that the bot is here.';
    case 'light_answer':
      return 'Reply style: light_answer. Give a short, light answer about the bot topic.';
    case 'light_tease':
      return 'Reply style: light_tease. A light self-teasing or playful response is acceptable.';
    case 'brief_clarify':
      return 'Reply style: brief_clarify. Ask at most one very light clarification.';
    case 'light_reaction':
    default:
      return 'Reply style: light_reaction. A short, natural reaction is enough.';
  }
}

function buildPassivePerceptionPrompt({
  groupId,
  senderId,
  senderName,
  text,
  rawText = '',
  imageUrl = null,
  directedContext,
  sessionPresence,
  now
}) {
  const perception = buildLlmPerception({
    groupId,
    senderId,
    rawText: rawText || text,
    cleanText: text,
    imageUrl,
    platform: 'qq',
    chatType: 'group',
    groupName: null,
    directedContext,
    sessionTiming: {
      currentInboundAt: Number(now || Date.now()) || Date.now(),
      previousHumanInboundAt: Number(sessionPresence?.lastHumanInboundAt || 0) || 0,
      previousBotReplyAt: Number(sessionPresence?.lastBotReplyAt || 0) || 0,
      humanTurnsSinceBotReply: Math.max(0, Number(sessionPresence?.humanTurnsSinceBotReply || 0) || 0),
      mergedSourceCount: 1,
      mergedSpanMs: 0
    },
    messageMeta: {
      senderName: senderName || '',
      groupName: ''
    }
  }, {
    passive: true,
    now,
    enableLunar: false,
    enableSolarTerm: false,
    enableAlmanac: false,
    includeGroupName: false
  });
  return String(perception?.text || '').trim();
}

function buildDecisionPrompt({
  groupId,
  senderId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  localAnalysis,
  addressee,
  replyType,
  gate,
  directedContext,
  now = Date.now()
}) {
  const contextLines = recentMessages
    .slice(-12)
    .map((item) => {
      const name = normalizeText(item.sender_name) || item.sender_id || 'unknown';
      const clean = sanitizePassivePromptContext(item.text, {
        replacement: '[omitted previous model self-identification/refusal text]'
      });
      return clean ? `${name}: ${normalizeText(clean)}` : '';
    })
    .filter(Boolean)
    .join('\n');
  const perceptionPrompt = buildPassivePerceptionPrompt({
    groupId,
    senderId,
    senderName,
    text,
    rawText,
    imageUrl,
    directedContext,
    sessionPresence: gate?.presenceSnapshot?.session,
    now
  });

  return [
    'You are deciding whether a passive QQ group reply should happen.',
    'Do not write the reply itself.',
    'Return JSON only.',
    'Prefer explicit reply, @bot, and direct bot-addressing cues over loose topic matching.',
    'If the message is clearly human-to-human, default to should_reply=false.',
    '',
    `group_id: ${String(groupId || '')}`,
    `sender_name: ${senderName || 'unknown'}`,
    `trigger_score: ${Number(score || 0)}`,
    '',
    '[LocalAnalysis]',
    formatLocalAnalysis({ addressee, replyType, analysis: localAnalysis, gate }),
    '',
    perceptionPrompt || '',
    perceptionPrompt ? '' : null,
    buildPassiveVisualPromptSection(visualInputs),
    visualInputs.length ? '' : null,
    directedContext ? buildDirectedContextPromptSnippet(directedContext) : '',
    directedContext ? '' : null,
    '[RecentContext]',
    contextLines || '(empty)',
    '',
    '[CurrentMessage]',
    text || '(empty)',
    '',
    'Output format:',
    '{"should_reply":false,"confidence":0.0,"reason":"..."}'
  ].filter((item) => item !== null).join('\n');
}

async function buildReplyPrompt({
  groupId,
  senderId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  decisionReason,
  localAnalysis,
  addressee,
  replyType,
  gate,
  directedContext,
  now = Date.now()
}) {
  const personaState = await composePersonaMemoryState({
    userId: String(senderId || '').trim(),
    question: text || '',
    groupId,
    routeMeta: { groupId }
  }, {
    surface: 'passive_group_reply',
    groupId,
    shortTermMemory,
    chatHistory
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'passive_group_reply');
  const livenessPrompt = buildChatLivenessDisciplinePrompt({
    surface: 'passive_group_reply',
    routeMeta: { groupId, directedContext },
    groupId,
    userId: senderId,
    question: text,
    personaMemoryState: personaState
  });
  const contextLines = recentMessages
    .slice(-12)
    .map((item) => {
      const name = normalizeText(item.sender_name) || item.sender_id || 'unknown';
      return `${name}: ${normalizeText(item.text)}`;
    })
    .filter(Boolean)
    .join('\n');
  const perceptionPrompt = buildPassivePerceptionPrompt({
    groupId,
    senderId,
    senderName,
    text,
    rawText,
    imageUrl,
    directedContext,
    sessionPresence: gate?.presenceSnapshot?.session,
    now
  });

  return {
    prompt: [
    'You are generating a natural passive QQ group reply.',
    'Reply with one short line only.',
    'Rules:',
    '1. Keep it short and casual.',
    '2. Do not explain rules or mention the system.',
    '3. Do not open a new large topic.',
    '4. Sound like a light interjection, not a formal answer.',
    '5. If the type is presence_ack, acknowledge briefly. If the type is brief_clarify, ask at most one very light clarification.',
    '',
    ...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean),
    livenessPrompt,
    '',
    `group_id: ${String(groupId || '')}`,
    `sender_name: ${senderName || 'unknown'}`,
    `trigger_score: ${Number(score || 0)}`,
    `decision_reason: ${normalizeText(decisionReason) || 'natural chance to chime in'}`,
    getReplyTypeGuidance(replyType),
    '',
    '[LocalAnalysis]',
    formatLocalAnalysis({ addressee, replyType, analysis: localAnalysis, gate }),
    '',
    perceptionPrompt || '',
    perceptionPrompt ? '' : null,
    buildPassiveVisualPromptSection(visualInputs),
    visualInputs.length ? '' : null,
    directedContext ? buildDirectedContextPromptSnippet(directedContext) : '',
    directedContext ? '' : null,
    '[RecentContext]',
    contextLines || '(empty)',
    '',
    '[CurrentMessage]',
    text || '(empty)',
    '',
    'Output only the final reply text.'
  ].filter((item) => item !== null).join('\n'),
    personaMemoryState: personaState
  };
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value;
  const raw = normalizeText(value);
  if (!raw) return null;
  const normalized = raw.toLowerCase();
  if (['true', '1', 'yes', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'n'].includes(normalized)) return false;
  return null;
}

function parseDecisionFromLooseText(text = '') {
  const raw = String(text || '').trim();
  if (!raw) return null;

  const shouldReplyMatch = raw.match(/should_reply\s*[:=]\s*(true|false|yes|no|1|0)/i);
  const shouldReply = parseBooleanLike(shouldReplyMatch?.[1]);
  if (shouldReply === null) return null;

  const confidenceMatch = raw.match(/confidence\s*[:=]\s*([01](?:\.\d+)?)/i);
  const reasonMatch = raw.match(/reason\s*[:=]\s*["'`]?([^\n\r}]+)/i);
  return {
    shouldReply,
    confidence: Number(confidenceMatch?.[1] || 0),
    reason: normalizeText(reasonMatch?.[1] || '')
  };
}

function parseDecision(rawText = '') {
  const obj = extractJsonSafely(String(rawText || '').trim());
  if (obj && typeof obj === 'object') {
    const shouldReply = parseBooleanLike(obj.should_reply);
    if (shouldReply !== null) {
      return {
        shouldReply,
        confidence: Number(obj.confidence || 0),
        reason: normalizeText(obj.reason || '')
      };
    }
  }

  const loose = parseDecisionFromLooseText(rawText);
  if (loose) return loose;

  return {
    shouldReply: false,
    confidence: 0,
    reason: 'invalid-json'
  };
}

async function buildReplyPromptV2({
  groupId,
  senderName,
  recentMessages,
  text,
  rawText = '',
  imageUrl = null,
  visualInputs = [],
  score,
  decisionReason,
  localAnalysis,
  addressee,
  replyType,
  gate,
  presenceAction,
  presenceState,
  presenceReason,
  directedContext,
  senderId,
  now = Date.now()
}) {
  const personaState = await composePersonaMemoryState({
    userId: String(senderId || '').trim(),
    question: text || '',
    groupId,
    routeMeta: { groupId, directedContext }
  }, {
    surface: 'passive_group_reply',
    groupId,
    shortTermMemory,
    chatHistory
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'passive_group_reply');
  const livenessPrompt = buildChatLivenessDisciplinePrompt({
    surface: 'passive_group_reply',
    routeMeta: { groupId, directedContext },
    groupId,
    userId: senderId,
    question: text,
    personaMemoryState: personaState
  });
  const memoryContext = personaState?.evidence?.memoryContext && typeof personaState.evidence.memoryContext === 'object'
    ? personaState.evidence.memoryContext
    : {};
  const socialSnippet = buildPassiveAwarenessSocialSnippet({
    groupId,
    recentMessages,
    addressee,
    directedContext
  });
  const contextLines = recentMessages
    .slice(-12)
    .map((item) => {
      const name = normalizeText(item.sender_name) || item.sender_id || 'unknown';
      return `${name}: ${normalizeText(item.text)}`;
    })
    .filter(Boolean)
    .join('\n');
  const perceptionPrompt = buildPassivePerceptionPrompt({
    groupId,
    senderId,
    senderName,
    text,
    rawText,
    imageUrl,
    directedContext,
    sessionPresence: gate?.presenceSnapshot?.session,
    now
  });

  const action = normalizePresenceAction(presenceAction, 'reply');
  const currentMessageText = sanitizePassivePromptContext(text, {
    replacement: '[current message quoted a previous model self-identification/refusal]'
  }) || text;
  const retrievedMemoryText = normalizeText(sanitizePassivePromptContext(memoryContext.promptRetrievedMemoryText || ''), 1200);
  const taskMemoryText = normalizeText(sanitizePassivePromptContext(memoryContext.taskMemoryText || ''), 700);
  const groupMemoryText = normalizeText(sanitizePassivePromptContext(memoryContext.groupMemoryText || ''), 700);
  const styleSignalText = normalizeText(sanitizePassivePromptContext(memoryContext.styleSignalText || ''), 500);
  const longTermProfileText = normalizeText(sanitizePassivePromptContext(memoryContext.promptLongTermProfileText || ''), 900);
  const dailyJournalText = normalizeText(sanitizePassivePromptContext(memoryContext.dailyJournalText || ''), 700);
  const impressionText = normalizeText(sanitizePassivePromptContext(memoryContext.impressionText || ''), 320);
  const summaryText = normalizeText(sanitizePassivePromptContext(memoryContext.promptSummaryText || ''), 320);
  return {
    prompt: [
    'You are generating a passive QQ group reply.',
    'The presence state machine already decided that replying is allowed.',
    'Write one short natural line only.',
    'Rules:',
    '1. Keep it under 50 Chinese characters.',
    '2. Do not explain rules or mention the state machine.',
    '3. Do not start a new big topic.',
    action === 'follow_up'
      ? '4. This is a follow_up. Continue only one point from the current mini-conversation.'
      : '4. This is a reply. Speak like a one-time natural interjection.',
    '',
    ...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean),
    livenessPrompt,
    '',
    `group_id: ${String(groupId || '')}`,
    `sender_name: ${senderName || 'unknown'}`,
    `trigger_score: ${Number(score || 0)}`,
    `decision_reason: ${normalizeText(decisionReason) || 'natural chance to chime in'}`,
    `presence_action: ${action}`,
    `presence_state: ${normalizePresenceState(presenceState, 'observing')}`,
    `presence_reason: ${normalizeText(presenceReason) || 'state-machine-allow'}`,
    getReplyTypeGuidance(replyType),
    '',
    retrievedMemoryText ? '[RetrievedMemory]' : null,
    retrievedMemoryText || null,
    retrievedMemoryText ? '' : null,
    longTermProfileText ? '[LongTermProfile]' : null,
    longTermProfileText || null,
    longTermProfileText ? '' : null,
    styleSignalText ? '[StyleSignals]' : null,
    styleSignalText || null,
    styleSignalText ? '' : null,
    taskMemoryText ? '[TaskMemory]' : null,
    taskMemoryText || null,
    taskMemoryText ? '' : null,
    groupMemoryText ? '[GroupMemory]' : null,
    groupMemoryText || null,
    groupMemoryText ? '' : null,
    dailyJournalText ? '[DailyJournal]' : null,
    dailyJournalText || null,
    dailyJournalText ? '' : null,
    summaryText ? '[Summary]' : null,
    summaryText || null,
    summaryText ? '' : null,
    impressionText ? '[Impression]' : null,
    impressionText || null,
    impressionText ? '' : null,
    '[LocalAnalysis]',
    formatLocalAnalysis({ addressee, replyType, analysis: localAnalysis, gate }),
    '',
    perceptionPrompt || '',
    perceptionPrompt ? '' : null,
    buildPassiveVisualPromptSection(visualInputs),
    visualInputs.length ? '' : null,
    directedContext ? buildDirectedContextPromptSnippet(directedContext) : '',
    directedContext ? '' : null,
    socialSnippet || '',
    socialSnippet ? '' : null,
    '[RecentContext]',
    contextLines || '(empty)',
    '',
    '[CurrentMessage]',
    currentMessageText || '(empty)',
    '',
    'Output only the final reply text.'
  ].filter((item) => item !== null).join('\n'),
    personaMemoryState: personaState
  };
}

