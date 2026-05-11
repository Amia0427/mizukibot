function getPresenceConfig() {
  return {
    waitTurns: Math.max(1, Number(config.PASSIVE_AWARENESS_WAIT_TURNS || 2)),
    waitMinMs: Math.max(0, Number(config.PASSIVE_AWARENESS_WAIT_MIN_MS || 15000)),
    followUpWindowMs: Math.max(0, Number(config.PASSIVE_AWARENESS_FOLLOW_UP_WINDOW_MS || 180000)),
    closedTtlMs: Math.max(0, Number(config.PASSIVE_AWARENESS_CLOSED_TTL_MS || 900000)),
    replyCooldownMs: Math.max(0, Number(config.PASSIVE_AWARENESS_REPLY_COOLDOWN_MS || 300000)),
    minIntervalMs: Math.max(0, Number(config.PASSIVE_AWARENESS_MIN_INTERVAL_MS || 180000)),
    globalMinIntervalMs: Math.max(0, Number(config.PASSIVE_AWARENESS_GLOBAL_MIN_INTERVAL_MS || 15000))
  };
}

function getSessionKeyForPresence(groupId, senderId) {
  return resolveShortTermSessionKey(senderId, { groupId });
}

function containsExitCue(text = '') {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return /(懂了|知道了|行|好|ok|okay|收到|谢谢|谢了|没事了|解决了|先这样|晚安|睡了)/i.test(t);
}

function hasStrongBotCue(addressee) {
  return ['bot_presence_check', 'bot_direct'].includes(String(addressee || ''));
}

function hasBotTopicCue(addressee) {
  return ['bot_presence_check', 'bot_direct', 'group_bot_topic'].includes(String(addressee || ''));
}

function countHumanMessagesSince(messages = [], timestamp = 0, botSenderId = '') {
  const afterTs = Number(timestamp || 0) || 0;
  const botId = String(botSenderId || '').trim();
  return (Array.isArray(messages) ? messages : []).reduce((count, item) => {
    const itemTs = Number(item?.timestamp || 0) || 0;
    const senderId = String(item?.sender_id || '').trim();
    if (itemTs <= afterTs) return count;
    if (botId && senderId === botId) return count;
    return count + 1;
  }, 0);
}

function shouldAllowClosedReset({ groupPresence, addressee, now, cfg }) {
  if (hasStrongBotCue(addressee)) return true;
  if (String(groupPresence?.state || '') !== 'closed') return true;
  const closedAt = Number(groupPresence?.closed_at || 0) || 0;
  if (!closedAt) return true;
  return (now - closedAt) >= cfg.closedTtlMs;
}

function derivePresenceStateByAction(action, currentState) {
  switch (String(action || '')) {
    case 'wait':
      return currentState === 'observing' ? 'considering' : 'waiting';
    case 'reply':
    case 'follow_up':
      return 'interjecting';
    case 'exit':
      return 'closed';
    default:
      return normalizePresenceState(currentState, 'observing');
  }
}

function buildPresenceSnapshot({ groupPresence, sessionPresence }) {
  return {
    group: {
      state: normalizePresenceState(groupPresence?.state, 'observing'),
      lastAction: normalizePresenceAction(groupPresence?.last_action, 'no_reply'),
      waitingSince: Number(groupPresence?.waiting_since || 0) || 0,
      lastBotReplyAt: Number(groupPresence?.last_bot_reply_at || 0) || 0,
      lastPresenceAckAt: Number(groupPresence?.last_presence_ack_at || 0) || 0,
      lastTrivialPresenceReplyAt: Number(groupPresence?.last_trivial_presence_reply_at || 0) || 0,
      lastTrivialPresenceReplyText: String(groupPresence?.last_trivial_presence_reply_text || '').trim(),
      humanTurnsSinceBotReply: Math.max(0, Number(groupPresence?.human_turns_since_bot_reply || 0) || 0),
      coolingUntil: Number(groupPresence?.cooling_until || 0) || 0,
      closedAt: Number(groupPresence?.closed_at || 0) || 0,
      lastAddressee: String(groupPresence?.last_addressee || '').trim()
    },
    session: {
      state: normalizePresenceState(sessionPresence?.state, 'observing'),
      lastAction: normalizePresenceAction(sessionPresence?.lastAction, 'no_reply'),
      waitingSince: Number(sessionPresence?.waitingSince || 0) || 0,
      lastHumanInboundAt: Number(sessionPresence?.lastHumanInboundAt || 0) || 0,
      lastBotReplyAt: Number(sessionPresence?.lastBotReplyAt || 0) || 0,
      humanTurnsSinceBotReply: Math.max(0, Number(sessionPresence?.humanTurnsSinceBotReply || 0) || 0),
      closedAt: Number(sessionPresence?.closedAt || 0) || 0
    }
  };
}

function advancePresenceBeforeDecision({
  groupPresence,
  sessionPresence,
  addressee,
  now,
  recentMessages,
  botSenderId,
  currentStateHint
}) {
  const nextGroup = {
    ...groupPresence,
    state: normalizePresenceState(groupPresence?.state, currentStateHint || 'observing'),
    last_action: normalizePresenceAction(groupPresence?.last_action, 'no_reply'),
    last_inbound_at: now,
    human_turns_since_bot_reply: countHumanMessagesSince(
      recentMessages,
      groupPresence?.last_bot_reply_at,
      botSenderId
    ),
    last_addressee: String(addressee || '').trim()
  };
  const nextSession = {
    ...sessionPresence,
    state: normalizePresenceState(sessionPresence?.state, currentStateHint || 'observing'),
    lastAction: normalizePresenceAction(sessionPresence?.lastAction, 'no_reply'),
    lastInboundAt: now,
    lastHumanInboundAt: now,
    humanTurnsSinceBotReply: countHumanMessagesSince(
      recentMessages,
      sessionPresence?.lastBotReplyAt,
      botSenderId
    )
  };

  return {
    groupPresence: nextGroup,
    sessionPresence: nextSession
  };
}

function decidePresenceAction({
  text,
  score,
  addressee,
  gate,
  localAnalysis,
  groupPresence,
  sessionPresence,
  recentMessages,
  botSenderId,
  now,
  cfg
}) {
  const groupState = normalizePresenceState(groupPresence?.state, 'observing');
  const sessionState = normalizePresenceState(sessionPresence?.state, 'observing');
  const scoreMin = Number(config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60);
  const strongCue = hasStrongBotCue(addressee);
  const topicCue = hasBotTopicCue(addressee);
  const waitingSince = Number(groupPresence?.waiting_since || 0) || 0;
  const waitingElapsed = waitingSince > 0 ? now - waitingSince : 0;
  const humanTurnsSinceWaiting = waitingSince > 0
    ? countHumanMessagesSince(recentMessages, waitingSince, botSenderId)
    : 0;

  if (gate?.shouldSkip) {
    return { action: 'no_reply', state: groupState, reason: gate.reason || 'local-gate-skip' };
  }

  if (!shouldAllowClosedReset({ groupPresence, addressee, now, cfg })) {
    return { action: 'no_reply', state: groupState, reason: 'closed-without-cue' };
  }

  if (containsExitCue(text) && (Number(groupPresence?.last_bot_reply_at || 0) > 0 || Number(sessionPresence?.lastBotReplyAt || 0) > 0)) {
    return { action: 'exit', state: 'closed', reason: 'explicit-exit-cue' };
  }

  const withinFollowUpWindow = Number(sessionPresence?.lastBotReplyAt || 0) > 0
    && (now - Number(sessionPresence.lastBotReplyAt || 0)) <= cfg.followUpWindowMs;
  const followUpAllowed = withinFollowUpWindow
    && ['interjecting', 'waiting'].includes(sessionState)
    && Number(sessionPresence?.humanTurnsSinceBotReply || 0) <= 2
    && topicCue;

  if (followUpAllowed) {
    return { action: 'follow_up', state: 'interjecting', reason: `session-follow-up:${addressee}` };
  }

  if (groupState === 'cooling' && !strongCue) {
    const turns = Math.max(
      Number(groupPresence?.human_turns_since_bot_reply || 0),
      Number(sessionPresence?.humanTurnsSinceBotReply || 0)
    );
    if (turns >= 3) {
      return { action: 'exit', state: 'closed', reason: 'cooling-turn-limit' };
    }
    return { action: 'no_reply', state: 'cooling', reason: 'cooling-no-cue' };
  }

  if (groupState === 'closed' && !strongCue) {
    return { action: 'no_reply', state: 'closed', reason: 'closed-no-cue' };
  }

  const minLength = Math.max(1, Number(config.PASSIVE_AWARENESS_MIN_MESSAGE_LENGTH || 6));
  if (String(text || '').length < minLength || isNoiseText(text) || (!strongCue && score < scoreMin)) {
    return { action: 'no_reply', state: groupState, reason: score < scoreMin ? 'score-too-low' : 'noise-or-too-short' };
  }

  if (strongCue) {
    return { action: 'reply', state: 'interjecting', reason: `direct-cue:${addressee}` };
  }

  if (['group_bot_topic', 'group_open_question'].includes(addressee)) {
    const waitingSatisfied = (
      humanTurnsSinceWaiting >= cfg.waitTurns
      || (waitingSince > 0 && waitingElapsed >= cfg.waitMinMs && Boolean(localAnalysis?.botTopicContinuity))
      || strongCue
    );

    if (['considering', 'waiting'].includes(groupState) && waitingSatisfied) {
      return { action: 'reply', state: 'interjecting', reason: `waiting-satisfied:${addressee}` };
    }

    if (groupState === 'observing') {
      return { action: 'wait', state: 'considering', reason: `observe-topic:${addressee}` };
    }

    return { action: 'wait', state: 'waiting', reason: `continue-wait:${addressee}` };
  }

  return { action: 'no_reply', state: groupState, reason: 'no-presence-trigger' };
}

function shouldCheckReplyIntervals(action) {
  return ['reply', 'follow_up'].includes(String(action || ''));
}

function applyPresenceDecision({
  groupId,
  sessionKey,
  groupPresence,
  sessionPresence,
  action,
  nextState,
  addressee,
  replyText = '',
  now,
  cfg
}) {
  const normalizedAction = normalizePresenceAction(action, 'no_reply');
  const targetState = derivePresenceStateByAction(normalizedAction, nextState);

  const nextGroup = updateGroupPresence(groupId, (current) => {
    const updated = {
      ...current,
      state: targetState,
      last_action: normalizedAction,
      state_updated_at: now,
      last_inbound_at: now,
      human_turns_since_bot_reply: Math.max(
        0,
        Number(groupPresence?.human_turns_since_bot_reply || current.human_turns_since_bot_reply || 0)
      ),
      last_addressee: String(addressee || '').trim()
    };

    if (normalizedAction === 'wait') {
      updated.waiting_since = Number(current.waiting_since || 0) || now;
      updated.closed_at = 0;
    }
    if (normalizedAction === 'reply' || normalizedAction === 'follow_up') {
      updated.state = 'cooling';
      updated.last_bot_reply_at = now;
      if (isPresenceAckReply('', addressee)) {
        updated.last_presence_ack_at = now;
      }
      if (isTrivialPresenceReply(replyText, addressee, '')) {
        updated.last_trivial_presence_reply_at = now;
        updated.last_trivial_presence_reply_text = normalizeText(replyText);
      }
      updated.human_turns_since_bot_reply = 0;
      updated.waiting_since = Number(groupPresence?.waiting_since || 0) || now;
      updated.cooling_until = now + cfg.replyCooldownMs;
      updated.closed_at = 0;
    }
    if (normalizedAction === 'exit') {
      updated.state = 'closed';
      updated.closed_at = now;
      updated.cooling_until = 0;
      updated.waiting_since = 0;
    }
    if (normalizedAction === 'no_reply' && hasStrongBotCue(addressee)) {
      updated.state = 'observing';
      updated.closed_at = 0;
    }

    return updated;
  });

  const nextSession = updateShortTermPresence(sessionKey, shortTermMemory, {}, (current) => {
    const updated = {
      ...current,
      state: targetState,
      lastAction: normalizedAction,
      stateUpdatedAt: now,
      lastInboundAt: now,
      humanTurnsSinceBotReply: Math.max(
        0,
        Number(sessionPresence?.humanTurnsSinceBotReply || current.humanTurnsSinceBotReply || 0)
      )
    };

    if (normalizedAction === 'wait') {
      updated.state = 'waiting';
      updated.waitingSince = Number(current.waitingSince || 0) || now;
      updated.closedAt = 0;
    }
    if (normalizedAction === 'reply' || normalizedAction === 'follow_up') {
      updated.state = 'waiting';
      updated.lastBotReplyAt = now;
      updated.humanTurnsSinceBotReply = 0;
      updated.waitingSince = now;
      updated.closedAt = 0;
    }
    if (normalizedAction === 'exit') {
      updated.state = 'closed';
      updated.closedAt = now;
      updated.waitingSince = 0;
    }
    if (normalizedAction === 'no_reply' && hasStrongBotCue(addressee)) {
      updated.state = 'observing';
      updated.closedAt = 0;
    }

    return updated;
  });

  return {
    groupPresence: nextGroup,
    sessionPresence: nextSession
  };
}

