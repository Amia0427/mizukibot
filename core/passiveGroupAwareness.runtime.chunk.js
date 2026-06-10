async function handlePassiveGroupAwareness({
  msg,
  inboundContext,
  sendGroupReply,
  sendWithRetry
}) {
  const groupId = String(msg.group_id || '').trim();
  const senderId = String(msg.user_id || '').trim();
  const senderName = getSenderName(msg);
  const rawText = String(inboundContext?.rawText || msg.raw_message || '');
  // source-compat anchor: const text = normalizeText(inboundContext?.cleanText || rawText.replace(/\[CQ:[^\]]+\]/g, ' '));
  const directedContext = normalizeDirectedContext(
    inboundContext?.directedContext
      || msg?.__directedContext
      || null
  );
  const text = getEffectivePassiveText(inboundContext, rawText, directedContext);
  const imageUrl = String(inboundContext?.imageUrl || '').trim() || null;
  const visualInputs = collectPassiveVisualInputs(inboundContext, imageUrl);
  const now = Number(msg?.__continuousMessageMeta?.firstTimestamp || Date.now());
  const botSenderId = String(config.BOT_QQ || 'bot').trim() || 'bot';
  const sessionKey = getSessionKeyForPresence(groupId, senderId);
  const cfg = getPresenceConfig();

  if (!isEnabledForGroup(groupId)) return { handled: false, reason: 'group-disabled' };
  if (!text) {
    appendGroupMessage(groupId, { sender_id: senderId, sender_name: senderName, text, timestamp: now }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
    return { handled: false, reason: 'empty-text' };
  }

  appendGroupMessage(groupId, {
    sender_id: senderId,
    sender_name: senderName,
    text,
    timestamp: now
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);

  const minLength = Math.max(1, Number(config.PASSIVE_AWARENESS_MIN_MESSAGE_LENGTH || 6));
  if (text.length < minLength || isNoiseText(text)) {
    return { handled: false, reason: 'noise-or-too-short' };
  }

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
  const gate = shouldGatePassiveReply({
    addressee,
    analysis: localAnalysis
  });
  const gateWithSocialContext = applySocialContextGate({
    groupId,
    recentMessages,
    senderId,
    addressee,
    gate,
    directedContext
  });
  const score = scoreMessageTrigger(text, recentMessages);
  const initialGroupPresence = getGroupPresence(groupId);
  const initialSessionPresence = getShortTermPresence(sessionKey, shortTermMemory, {});
  const advancedPresence = advancePresenceBeforeDecision({
    groupPresence: initialGroupPresence,
    sessionPresence: initialSessionPresence,
    addressee,
    now,
    recentMessages,
    botSenderId,
    currentStateHint: hasStrongBotCue(addressee)
      ? 'observing'
      : normalizePresenceState(initialGroupPresence?.state, 'observing')
  });
  const groupPresence = advancedPresence.groupPresence;
  const sessionPresence = advancedPresence.sessionPresence;
  const presenceDecision = decidePresenceAction({
    text,
    score,
    addressee,
    gate: gateWithSocialContext,
    localAnalysis,
    groupPresence,
    sessionPresence,
    recentMessages,
    botSenderId,
    now,
    cfg
  });
  const presenceAction = normalizePresenceAction(presenceDecision.action, 'no_reply');
  const presenceState = normalizePresenceState(presenceDecision.state, groupPresence.state);
  const presenceReason = buildPresenceReason(presenceDecision.reason, addressee);
  const presenceSnapshot = buildPresenceSnapshot({ groupPresence, sessionPresence });
  const bypassReplyIntervals = presenceAction === 'follow_up';
  const baseResult = {
    score,
    localAnalysis,
    addressee,
    replyType,
    cheapGateReason: '',
    decisionReason: '',
    decisionModelCalled: false,
    replyModelCalled: false,
    decision: {
      shouldReply: shouldCheckReplyIntervals(presenceAction),
      confidence: shouldCheckReplyIntervals(presenceAction) ? 1 : 0,
      reason: presenceReason
    }
  };

  if (!shouldCheckReplyIntervals(presenceAction)) {
    const applied = applyPresenceDecision({
      groupId,
      sessionKey,
      groupPresence,
      sessionPresence,
      action: presenceAction,
      nextState: presenceState,
      addressee,
      now,
      cfg
    });
    return {
      handled: false,
      reason: presenceReason,
      presenceState: applied.groupPresence.state,
      presenceAction,
      presenceReason,
      presence: buildPresenceSnapshot(applied),
      ...baseResult
    };
  }

  const groupLastAwarenessAt = getLastAwarenessAt(groupId);
  const globalLastAwarenessAt = getGlobalLastAwarenessAt();
  if (!bypassReplyIntervals && groupLastAwarenessAt && now - groupLastAwarenessAt < cfg.minIntervalMs) {
    return {
      handled: false,
      reason: 'group-awareness-cooldown',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }
  if (!bypassReplyIntervals && globalLastAwarenessAt && now - globalLastAwarenessAt < cfg.globalMinIntervalMs) {
    return {
      handled: false,
      reason: 'global-awareness-cooldown',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  setLastAwarenessAt(groupId, now);
  const lastReplyAt = getLastReplyAt(groupId);
  if (!bypassReplyIntervals && lastReplyAt && now - lastReplyAt < cfg.replyCooldownMs) {
    return {
      handled: false,
      reason: 'reply-cooldown',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  if (!canReplyInHour(groupId, now, config.PASSIVE_AWARENESS_MAX_REPLIES_PER_HOUR)) {
    return {
      handled: false,
      reason: 'reply-hour-limit',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  const cheapGate = cheapRuleGate({
    gate,
    gateWithSocialContext,
    score,
    addressee,
    text,
    recentMessages,
    directedContext
  });
  const gateResult = {
    ...baseResult,
    cheapGateReason: cheapGate.reason || '',
    decisionReason: '',
    decisionModelCalled: false,
    replyModelCalled: false
  };

  if (cheapGate.level === 'drop') {
    return {
      handled: false,
      reason: cheapGate.reason || 'cheap-gate-drop',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult
    };
  }

  let decision = {
    shouldReply: false,
    confidence: 0,
    reason: 'decision-skipped'
  };
  let decisionModelCalled = canCallDecisionModel();
  try {
    decision = await invokeDecisionModel({
      groupId,
      senderId,
      senderName,
      recentMessages,
      text,
      rawText,
      imageUrl,
      visualInputs,
      score,
      localAnalysis,
      addressee,
      replyType,
      gate: {
        ...gate,
        presenceSnapshot
      },
      directedContext,
      now
    });
  } catch (error) {
    decision = {
      shouldReply: false,
      confidence: 0,
      reason: `decision-call-failed:${error?.message || error}`
    };
  }

  const allowDecisionFallback = cheapGate.level === 'strong_candidate'
    && config.PASSIVE_AWARENESS_STRONG_CUE_BYPASS_ON_DECISION_FAILURE
    && shouldUseLocalDecisionFallback({ decision, addressee, score });
  const forceStrongCueReply = cheapGate.level === 'strong_candidate'
    && shouldForceStrongCueReply({ decision, addressee, score });
  const decisionReason = normalizeText(decision.reason || '');
  if (!decision.shouldReply && !allowDecisionFallback && !forceStrongCueReply) {
    return {
      handled: false,
      reason: decisionReason || 'decision-declined',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult,
      decisionModelCalled,
      decisionReason,
      decision
    };
  }

  let replyText = allowDecisionFallback
    ? buildLocalReplyFallback({ addressee, replyType })
    : '';
  let passivePersonaMemoryState = null;
  let replyModelCalled = false;
  if (!replyText) {
    const shouldCallReplyModel = canCallReplyModel();
    try {
      if (shouldCallReplyModel) {
        replyModelCalled = true;
        const replyResult = await invokeReplyModel({
          groupId,
          senderId,
          senderName,
          recentMessages,
          text,
          rawText,
          imageUrl,
          visualInputs,
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
          now
        });
        replyText = trimReplyText(replyResult?.replyText || '', 80);
        passivePersonaMemoryState = replyResult?.personaMemoryState || null;
      }
    } catch (e) {
      console.error('[group-awareness] reply model call failed:', e.message);
      replyText = cheapGate.level === 'strong_candidate'
        ? buildLocalReplyFallback({ addressee, replyType })
        : '';
      if (!replyText) {
        return {
          handled: false,
          reason: 'reply-model-call-failed',
          presenceState,
          presenceAction,
          presenceReason,
          presence: presenceSnapshot,
          ...gateResult,
          decisionModelCalled,
          decisionReason,
          replyModelCalled
        };
      }
      console.warn('[group-awareness] reply fallback enabled after model failure', {
        groupId,
        senderId,
        addressee,
        replyType,
        fallbackText: replyText
      });
    }
  }

  if (!replyText) {
    replyText = cheapGate.level === 'strong_candidate'
      ? buildLocalReplyFallback({ addressee, replyType })
      : '';
    if (!replyText) {
      return {
        handled: false,
        reason: 'empty-reply-text',
        presenceState,
        presenceAction,
        presenceReason,
        presence: presenceSnapshot,
        ...gateResult,
        decisionModelCalled,
        decisionReason,
        replyModelCalled
      };
    }
    console.warn('[group-awareness] reply fallback enabled after empty reply', {
      groupId,
      senderId,
      addressee,
      replyType,
      fallbackText: replyText
    });
  }

  if (shouldSuppressPresenceAck({
    groupPresence,
    now,
    replyType,
    addressee
  })) {
    return {
      handled: false,
      reason: 'presence-ack-dedup',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult,
      decisionModelCalled,
      decisionReason,
      replyModelCalled
    };
  }

  if (shouldSuppressTrivialPresenceReply({
    groupPresence,
    now,
    replyText,
    addressee,
    replyType
  })) {
    return {
      handled: false,
      reason: 'trivial-presence-reply-dedup',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...gateResult,
      decisionModelCalled,
      decisionReason,
      replyModelCalled
    };
  }

  const sent = await sendGroupReply({
    groupId,
    senderId,
    replyText,
    atSender: Boolean(config.PASSIVE_AWARENESS_AT_SENDER),
    retries: 1,
    waitMs: 300
  });

  if (!sent) {
    return {
      handled: false,
      reason: 'send-failed',
      presenceState,
      presenceAction,
      presenceReason,
      presence: presenceSnapshot,
      ...baseResult
    };
  }

  await maybeSendMemeFollowup({
    surface: 'passive',
    groupId,
    senderId,
    sendWithRetry,
    routePolicyKey: 'passive-awareness/reply',
    topRouteType: 'chat',
    userText: text,
    replyText,
    rawMessage: rawText,
    routeMeta: {
      responseIntent: 'answer'
    },
    replyToMessageId: String(msg.message_id || '').trim(),
    recentMessagesOverride: recentMessages,
    passiveDecisionMeta: {
      presenceState,
      presenceAction,
      presenceReason,
      addressee
    }
  }).catch(() => {});

  appendGroupMessage(groupId, {
    sender_id: botSenderId,
    sender_name: '鐟炲笇',
    text: replyText,
    timestamp: Date.now()
  }, config.PASSIVE_AWARENESS_CONTEXT_SIZE);
  recordReply(groupId, now);
  const applied = applyPresenceDecision({
    groupId,
    sessionKey,
    groupPresence,
    sessionPresence,
    action: presenceAction,
    nextState: presenceState,
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
    reason: 'replied',
    presenceState: applied.groupPresence.state,
    presenceAction,
    presenceReason,
    presence: buildPresenceSnapshot(applied),
    replyText,
    ...gateResult,
    decisionModelCalled,
    decisionReason,
    replyModelCalled,
    decision
  };
}

