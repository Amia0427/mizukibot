async function forcePassiveGroupInterjection({
  msg,
  inboundContext,
  sendGroupReply,
  sendWithRetry,
  reason = 'forced-interjection',
  forceAtSender = null
} = {}) {
  const effectiveMsg = msg && typeof msg === 'object' ? msg : {};
  const context = inboundContext && typeof inboundContext === 'object' ? inboundContext : {};
  const groupId = String(effectiveMsg.group_id || context.groupId || '').trim();
  const senderId = String(effectiveMsg.user_id || context.senderId || '').trim();
  const senderName = getSenderName(effectiveMsg) || String(context.senderName || '').trim();
  const rawText = String(context.rawText || effectiveMsg.raw_message || '').trim();
  const directedContext = normalizeDirectedContext(
    context.directedContext
      || effectiveMsg.__directedContext
      || null
  );
  const text = getEffectivePassiveText(context, rawText, directedContext);
  const imageUrl = String(context.imageUrl || '').trim() || null;
  const visualInputs = collectPassiveVisualInputs(context, imageUrl);
  const now = Number(effectiveMsg?.__continuousMessageMeta?.firstTimestamp || Date.now());
  const sessionKey = getSessionKeyForPresence(groupId, senderId);

  if (!groupId || !senderId) {
    return { handled: false, reason: 'missing-group-or-sender' };
  }
  if (!text) {
    appendGroupMessage(groupId, {
      sender_id: senderId,
      sender_name: senderName,
      text: '',
      timestamp: now
    }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
    return { handled: false, reason: 'empty-text' };
  }

  appendGroupMessage(groupId, {
    sender_id: senderId,
    sender_name: senderName,
    text,
    timestamp: now
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);

  const recentMessages = getRecentMessages(groupId);
  const conversationWindow = buildConversationWindow({ recentMessages, now });
  const localAnalysis = analyzeConversationWindow({
    window: conversationWindow,
    senderId,
    text
  });
  const addressee = detectPassiveAddressee({
    text,
    analysis: localAnalysis,
    directedContext
  });
  const replyType = classifyPassiveReplyType({
    text,
    addressee,
    analysis: localAnalysis
  });
  const initialGroupPresence = getGroupPresence(groupId);
  const initialSessionPresence = getShortTermPresence(sessionKey, shortTermMemory, {});
  const cfg = getPresenceConfig();
  const presenceSnapshot = buildPresenceSnapshot({
    groupPresence: initialGroupPresence,
    sessionPresence: initialSessionPresence
  });

  if (!canCallReplyModel()) {
    return {
      handled: false,
      reason: 'missing-reply-model-config',
      addressee,
      replyType,
      localAnalysis
    };
  }

  let replyText = '';
  let passivePersonaMemoryState = null;
  let hasSafetyRestriction = false;
  try {
    const replyResult = await invokeReplyModel({
      groupId,
      senderId,
      senderName,
      recentMessages,
      text,
      rawText,
      imageUrl,
      visualInputs,
      score: Math.max(
        Number(config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60),
        scoreMessageTrigger(text, recentMessages)
      ),
      decisionReason: reason,
      localAnalysis,
      addressee,
      replyType,
      gate: {
        shouldSkip: false,
        reason,
        rhythm: String(localAnalysis?.rhythm || 'normal'),
        presenceSnapshot
      },
      presenceAction: 'reply',
      presenceState: 'interjecting',
      presenceReason: reason,
      directedContext,
      now
    });
    const normalizedReply = normalizePassiveReplyText(replyResult?.replyText || '', 80);
    replyText = normalizedReply.replyText;
    hasSafetyRestriction = normalizedReply.hasSafetyRestriction;
    passivePersonaMemoryState = replyResult?.personaMemoryState || null;
  } catch (error) {
    return {
      handled: false,
      reason: `reply-model-call-failed:${error?.message || error}`,
      addressee,
      replyType,
      localAnalysis
    };
  }

  if (!replyText) {
    return {
      handled: false,
      reason: 'empty-reply-text',
      addressee,
      replyType,
      localAnalysis
    };
  }

  const sent = await sendGroupReply({
    groupId,
    senderId,
    replyText,
    atSender: typeof forceAtSender === 'boolean'
      ? forceAtSender
      : Boolean(config.PASSIVE_AWARENESS_AT_SENDER),
    retries: 1,
    waitMs: 300
  });

  if (!sent) {
    return {
      handled: false,
      reason: 'send-failed',
      addressee,
      replyType,
      localAnalysis
    };
  }

  if (hasSafetyRestriction) {
    await markPassiveSafetyRestrictionEmoji({
      messageId: effectiveMsg.message_id,
      sendWithRetry
    }).catch(() => false);
  }

  const botSenderId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  appendGroupMessage(groupId, {
    sender_id: botSenderId,
    sender_name: '瑞希',
    text: replyText,
    timestamp: Date.now()
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
  recordReply(groupId, now);
  const applied = applyPresenceDecision({
    groupId,
    sessionKey,
    groupPresence: initialGroupPresence,
    sessionPresence: initialSessionPresence,
    action: 'reply',
    nextState: 'interjecting',
    addressee,
    replyText,
    now,
    cfg
  });
  await recordPersonaMemoryOutcome('passive_group_reply', {
    state: passivePersonaMemoryState,
    userId: String(senderId || '').trim(),
    sessionKey,
    groupId,
    request: {
      userId: String(senderId || '').trim(),
      question: text || '',
      routeMeta: { groupId, directedContext },
      routePolicyKey: 'passive-awareness/reply',
      topRouteType: 'chat'
    },
    activeTopic: text,
    recentReplyFrame: replyText,
    recentMessages: [
      { role: 'user', content: text },
      { role: 'assistant', content: replyText }
    ]
  }).catch(() => {});

  return {
    handled: true,
    reason,
    replyText,
    hasSafetyRestriction,
    addressee,
    replyType,
    localAnalysis,
    presenceState: applied.groupPresence.state,
    presenceAction: 'reply'
  };
}

module.exports = {
  forcePassiveGroupInterjection,
  handlePassiveGroupAwareness,
  isEnabledForGroup,
  getPresenceConfig,
  decidePresenceAction,
  scoreMessageTrigger,
  parseDecision,
  buildDecisionPrompt,
  buildReplyPrompt,
  buildPassiveReplySystemMessages,
  buildCompactPersonaPrompt,
  buildConversationWindow,
  analyzeConversationWindow,
  detectPassiveAddressee,
  classifyPassiveReplyType,
  shouldGatePassiveReply,
  shouldSuppressPresenceAck,
  shouldSuppressTrivialPresenceReply,
  cheapRuleGate,
  isNoiseText,
  trimReplyText
};







