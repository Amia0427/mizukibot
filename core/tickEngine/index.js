const crypto = require('crypto');
const config = require('../../config');
const { postWithRetry } = require('../../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../../api/parser');
const { formatDateInTz, getDatePartsInTz } = require('../../utils/time');
const {
  favorites,
  getUserProfile,
  getUserSummary,
  getUserMemories,
  hasFreshGroupBinding
} = require('../../utils/memory');
const { shortTermMemory } = require('../../utils/memory');
const { normalizeShortTermState, resolveShortTermSessionKey } = require('../../utils/shortTermMemory');
const { loadBridgeStore } = require('../../utils/shortTermBridgeMemory');
const {
  composePersonaMemoryState,
  renderPersonaMemoryPrompt,
  recordPersonaMemoryOutcome
} = require('../../utils/personaMemoryState');
const {
  getDailyJournalRetrievalBundle,
  runDailyJournalSummaries,
  shouldRunDailySummaryNow
} = require('../../utils/dailyJournal');
const { getRecentMessages } = require('../../utils/groupAwarenessState');
const { recordSystemGroupSend } = require('../systemGroupReply');
const {
  acquireInitiativeLock,
  evaluateInitiativePolicy,
  isStrongCandidate,
  releaseInitiativeLock
} = require('../initiativePolicyEngine');
const { markInitiativeSent, setLastCycleKey } = require('../initiativeState');
const { getDailyShareEngine } = require('../dailyShareEngine');
const { getLifeSchedulerEngine } = require('../lifeSchedulerEngine');
const {
  getDailyState,
  loadTickState,
  saveTickState
} = require('./state');
const {
  computeWindowTriggerMinutes,
  formatWindowBucket,
  getDailyMax,
  getDailyShareScanIntervalMs,
  getIdleMs,
  getLifeSchedulerScanIntervalMs,
  getProactiveScanIntervalMs,
  getProactiveStartDelayMs,
  getRandomWindows,
  getReasonRepeatMs,
  getSignatureRepeatMs,
  getTouchMinGapMs,
  getWindowByCurrentTime,
  isWindowReadyForUser,
  shouldTriggerFallbackGreeting
} = require('./schedule');

function trimText(value, maxChars = 180) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

function ensureChatCompletionsUrl(url) {
  const raw = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(raw)) return raw;
  if (/\/v\d+$/i.test(raw)) return `${raw}/chat/completions`;
  return raw;
}

function parseBooleanLike(value) {
  if (typeof value === 'boolean') return value;
  const normalized = String(value || '').trim().toLowerCase();
  if (['true', '1', 'yes'].includes(normalized)) return true;
  if (['false', '0', 'no'].includes(normalized)) return false;
  return null;
}

function canCallInitiativeDecisionModel() {
  if (!config.INITIATIVE_DECISION_ENABLED) return false;
  const baseUrl = ensureChatCompletionsUrl(config.INITIATIVE_DECISION_API_BASE_URL);
  const apiKey = String(config.INITIATIVE_DECISION_API_KEY || '').trim();
  const model = String(config.INITIATIVE_DECISION_MODEL || '').trim();
  return Boolean(baseUrl && apiKey && model);
}

function buildInitiativeDecisionPrompt({
  groupId = '',
  userId = '',
  candidateReason = '',
  source = '',
  promptPayload = {},
  recentMessages = [],
  policy = {},
  now = Date.now()
} = {}) {
  const contextLines = (Array.isArray(recentMessages) ? recentMessages : [])
    .slice(-12)
    .map((item) => {
      const name = String(item?.sender_name || item?.sender_id || 'unknown').trim() || 'unknown';
      return `${name}: ${trimText(item?.text || '', 90) || '(empty)'}`;
    });
  return [
    'You are deciding whether a proactive QQ group reply should be sent now.',
    'Do not write the reply itself.',
    'Return JSON only.',
    'Required schema: {"send":boolean,"reason":string,"style":"resume_open_loop|light_touch|scheduled_greeting|broadcast_share","urgency":"low|medium|high","atSender":boolean}',
    `group_id: ${String(groupId || '').trim()}`,
    `user_id: ${String(userId || '').trim()}`,
    `source: ${String(source || '').trim()}`,
    `candidate_reason: ${String(candidateReason || '').trim()}`,
    `strong_candidate: ${isStrongCandidate(candidateReason) ? 'true' : 'false'}`,
    `policy_style: ${String(policy.style || 'light_touch').trim()}`,
    `policy_hot_chat: ${policy.hotChat ? 'true' : 'false'}`,
    `policy_recent_count: ${Number(policy.recentCount || 0)}`,
    `timestamp_ms: ${Number(now || Date.now())}`,
    '',
    `[PrimaryContext] ${trimText(promptPayload.primaryContext || '', 160) || 'none'}`,
    `[SecondaryContext] ${trimText(promptPayload.secondaryContext || '', 160) || 'none'}`,
    promptPayload.fallbackGreetingType ? `[FallbackType] ${String(promptPayload.fallbackGreetingType || '').trim()}` : '',
    '',
    '[RecentMessages]',
    contextLines.join('\n') || '(none)',
    '',
    'Prefer silence when timing is weak, repetitive, or intrusive.'
  ].filter(Boolean).join('\n');
}

function parseInitiativeDecision(rawText = '', fallbackStyle = 'light_touch', fallbackAtSender = false) {
  const obj = extractJsonSafely(String(rawText || '').trim());
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const send = parseBooleanLike(obj.send);
    if (send !== null) {
      const atSender = parseBooleanLike(obj.atSender);
      return {
        send,
        reason: String(obj.reason || '').trim() || (send ? 'allowed' : 'declined'),
        style: String(obj.style || fallbackStyle).trim() || fallbackStyle,
        urgency: String(obj.urgency || 'low').trim() || 'low',
        atSender: atSender === null ? Boolean(fallbackAtSender) : atSender
      };
    }
  }
  return {
    send: false,
    reason: 'invalid-json',
    style: fallbackStyle,
    urgency: 'low',
    atSender: Boolean(fallbackAtSender)
  };
}

async function invokeInitiativeDecisionModel(input = {}) {
  const fallbackStyle = String(input?.policy?.style || 'light_touch').trim() || 'light_touch';
  const fallbackAtSender = Boolean(input?.promptPayload?.atSender);
  if (!config.INITIATIVE_DECISION_ENABLED) {
    return { send: false, reason: 'decision-disabled', style: fallbackStyle, urgency: 'low', atSender: fallbackAtSender };
  }
  if (!canCallInitiativeDecisionModel()) {
    return { send: false, reason: 'missing-decision-model-config', style: fallbackStyle, urgency: 'low', atSender: fallbackAtSender };
  }
  const response = await postWithRetry(
    ensureChatCompletionsUrl(config.INITIATIVE_DECISION_API_BASE_URL),
    {
      model: String(config.INITIATIVE_DECISION_MODEL || '').trim(),
      temperature: Number(config.INITIATIVE_DECISION_TEMPERATURE || 0.2),
      top_p: Number(config.INITIATIVE_DECISION_TOP_P || 0.9),
      messages: [
        {
          role: 'system',
          content: 'You are a QQ proactive initiative decision model. Return JSON only with send, reason, style, urgency, atSender.'
        },
        {
          role: 'user',
          content: buildInitiativeDecisionPrompt(input)
        }
      ],
      max_tokens: Math.max(80, Number(config.INITIATIVE_DECISION_MAX_TOKENS || 220)),
      stream: false,
      __timeoutMs: Math.max(1000, Number(config.INITIATIVE_DECISION_TIMEOUT_MS || 4000))
    },
    Math.max(0, Number(config.INITIATIVE_DECISION_RETRIES || 1)),
    String(config.INITIATIVE_DECISION_API_KEY || '').trim()
  );
  const msg = extractMessageContent(response);
  return parseInitiativeDecision(String(msg?.content || ''), fallbackStyle, fallbackAtSender);
}

async function sendTickPayloadWithRetry(ws, payload, retries = 1, waitMs = 500, actionClient = null) {
  if (actionClient && typeof actionClient.callAction === 'function') {
    const maxRetry = Math.max(0, Number(retries) || 0);
    for (let i = 0; i <= maxRetry; i += 1) {
      try {
        await actionClient.callAction(payload.action, payload.params);
        return true;
      } catch (error) {
        if (i < maxRetry) await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
    return false;
  }

  const maxRetry = Math.max(0, Number(retries) || 0);
  for (let i = 0; i <= maxRetry; i += 1) {
    if (ws && typeof ws.send === 'function') {
      try {
        ws.send(JSON.stringify(payload));
        return true;
      } catch (_) {}
    }
    if (i < maxRetry) {
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
  return false;
}

function canTriggerProactiveReply(userId, data, state, today, now = Date.now()) {
  if (!config.PROACTIVE_REPLY_ENABLED) return false;
  if (!data || !hasFreshGroupBinding(data)) return false;

  const points = Number(data.points || 0);
  if (points <= Number(config.PROACTIVE_REPLY_MIN_POINTS || 150)) return false;

  const userState = getDailyState(state, userId, today);
  if (userState.proactive_count >= getDailyMax()) return false;

  const lastSeenAt = Number(data.last_seen_at || 0);
  if (lastSeenAt && now - lastSeenAt < getIdleMs()) return false;

  const lastProactiveAt = Number(userState.last_proactive_at || 0);
  if (lastProactiveAt && now - lastProactiveAt < getTouchMinGapMs()) return false;

  return true;
}

function resolveShortTermStateForUser(userId, groupId = '') {
  const uid = String(userId || '').trim();
  const gid = String(groupId || '').trim();
  const bridgeStore = loadBridgeStore();

  const preferredSessionKey = gid
    ? resolveShortTermSessionKey(uid, { groupId: gid })
    : '';
  const directSessionKey = resolveShortTermSessionKey(uid, {});

  const candidates = [preferredSessionKey, directSessionKey].filter(Boolean);
  for (const sessionKey of candidates) {
    if (shortTermMemory[sessionKey]) {
      return {
        sessionKey,
        state: normalizeShortTermState(shortTermMemory[sessionKey])
      };
    }
    const bridgeEntry = bridgeStore.sessions?.[sessionKey];
    if (bridgeEntry?.shortTermState) {
      return {
        sessionKey,
        state: normalizeShortTermState(bridgeEntry.shortTermState)
      };
    }
  }

  return {
    sessionKey: preferredSessionKey || directSessionKey,
    state: normalizeShortTermState({})
  };
}

function extractJournalSignal(bundle = {}) {
  const items = Array.isArray(bundle?.items) ? bundle.items : [];
  const prioritized = items.find((item) => item?.kind === 'daily_summary')
    || items.find((item) => item?.kind === 'four_day_rollup')
    || items[0];
  const text = trimText(prioritized?.text || '', 140);
  if (!text) return '';
  return text;
}

function getRecentTopic(profile = {}, shortTermState = {}) {
  const activeTopic = trimText(shortTermState.activeTopic || '', 80);
  if (activeTopic) return activeTopic;
  const recentTopics = Array.isArray(profile?.recent_topics)
    ? profile.recent_topics.map((item) => trimText(item, 80)).filter(Boolean)
    : [];
  return recentTopics[recentTopics.length - 1] || '';
}

function buildTouchSignature(reason = '', primaryContext = '') {
  const payload = `${String(reason || '').trim()}|${trimText(primaryContext, 120)}`;
  return crypto.createHash('sha1').update(payload).digest('hex').slice(0, 16);
}

function getErrorReason(error, fallback = 'touch-send-failed') {
  return String(error?.message || error || fallback).trim() || fallback;
}

function sendTouchWebSocketMessage(ws, payload) {
  if (!ws || typeof ws.send !== 'function') {
    throw new Error('websocket send unavailable');
  }
  if (typeof ws.readyState === 'number' && ws.readyState !== 1) {
    throw new Error(`websocket not open:${ws.readyState}`);
  }
  ws.send(JSON.stringify(payload));
}

async function recordTouchFailureOutcome({
  error,
  userId,
  groupId,
  candidateReason,
  source,
  promptPayload = {},
  text = ''
} = {}) {
  const reason = getErrorReason(error);
  try {
    await recordPersonaMemoryOutcome('touch_failed', {
      userId,
      groupId,
      reason,
      source,
      candidateReason,
      activeTopic: promptPayload.primaryContext || candidateReason,
      recentReplyFrame: text,
      request: {
        userId,
        question: candidateReason || reason,
        routeMeta: { groupId },
        routePolicyKey: 'proactive/default',
        topRouteType: 'proactive'
      }
    });
  } catch (recordError) {
    console.error('[tick] proactive touch failure record failed:', getErrorReason(recordError, 'record-failure-outcome-failed'));
  }
}

async function buildReasonAwarePrompt({
  touchReason = '',
  primaryContext = '',
  secondaryContext = '',
  fallbackGreetingType = '',
  userId = '',
  data = {}
} = {}) {
  const personaState = await composePersonaMemoryState({
    userId,
    question: `${touchReason || ''} ${primaryContext || ''} ${secondaryContext || ''}`.trim(),
    groupId: String(data.group_id || '').trim(),
    routeMeta: {
      groupId: String(data.group_id || '').trim()
    },
    topRouteType: 'proactive',
    routePolicyKey: 'proactive/default'
  }, {
    surface: 'proactive_touch',
    groupId: String(data.group_id || '').trim()
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'proactive_touch');
  const profile = getUserProfile(userId) || {};
  const summary = trimText(getUserSummary(userId), 220) || '暂无';
  const memories = trimText(getUserMemories(userId), 220) || '暂无';
  const relationStage = String(profile.relation_stage || data.level || '陌生人').trim() || '陌生人';
  const recentTopics = Array.isArray(profile.recent_topics)
    ? profile.recent_topics.slice(-4).map((item) => trimText(item, 40)).filter(Boolean).join('、')
    : '';

  const rules = fallbackGreetingType
    ? [
        '你在替机器人发一条固定时间兜底问候。',
        '只写 1 到 2 句，总长度不超过 35 个中文字符。',
        '不要写成模板客服语气，不要提“按时”“定时”“系统提醒”“突然想起”。',
        '如果是 morning，只能像自然的上午招呼；如果是 night，只能像自然的晚间收束。',
        '不要带列表、解释、规则说明，不要连续追问。'
      ]
    : [
        '你在替机器人发一条上下文驱动的主动轻触达消息。',
        '只写 1 到 2 句，总长度不超过 60 个中文字符。',
        '最多一个问号，不要列表，不要解释规则，不要模板开场。',
        'open loop 必须直接续接上次未完的话题，不能泛泛关心。',
        'topic 或 journal 只能轻轻续一个细节，不能把历史全抖出来。',
        'light care 不能写成早安晚安模板。'
      ];

  return {
    prompt: [
    ...rules,
    ...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean),
    `touchReason: ${touchReason || fallbackGreetingType || 'light_care_ping'}`,
    fallbackGreetingType ? `fallbackGreetingType: ${fallbackGreetingType}` : '',
    `[PrimaryContext] ${primaryContext || '暂无'}`,
    secondaryContext ? `[SecondaryContext] ${secondaryContext}` : '',
    `[Relation] ${relationStage}`,
    `[RecentTopics] ${recentTopics || '暂无'}`,
    `[UserSummary] ${summary}`,
    `[LongTermMemory] ${memories}`
  ].filter(Boolean).join('\n'),
    personaMemoryState: personaState
  };
}

async function buildProactivePrompt(userId, data, payload = {}) {
  return buildReasonAwarePrompt({
    userId,
    data,
    ...payload
  });
}

function shouldSendScheduledGreeting(data, type, today, runtimeConfig = config, userState = null) {
  if (!data || !hasFreshGroupBinding(data)) return false;
  if (runtimeConfig.PROACTIVE_GREETING_FALLBACK_ENABLED === false) return false;

  const minPoints = Number(runtimeConfig.SCHEDULED_GREETING_MIN_POINTS || 250);
  if (Number(data.points || 0) <= minPoints) return false;

  const proactiveCount = Number(userState?.proactive_count || 0) || 0;
  if (proactiveCount > 0) return false;

  if (type === 'morning') {
    if (String(data.last_morning || '').trim() === today) return false;
    if (String(userState?.last_morning_fallback_day || '').trim() === today) return false;
  }
  if (type === 'night') {
    if (String(data.last_night || '').trim() === today) return false;
    if (String(userState?.last_night_fallback_day || '').trim() === today) return false;
  }
  return true;
}

function selectTouchCandidate(userId, data, state, today, now = Date.now()) {
  const profile = getUserProfile(userId) || {};
  const { state: shortState } = resolveShortTermStateForUser(userId, data.group_id);
  const userState = getDailyState(state, userId, today);
  const idleMs = now - Number(data.last_seen_at || 0 || 0);
  const journalBundle = getDailyJournalRetrievalBundle(userId, {
    lookbackDays: 2,
    maxFourDayFiles: 1,
    maxMonthlyFiles: 0
  });
  const journalText = extractJournalSignal(journalBundle);
  const recentTopic = getRecentTopic(profile, shortState);

  const candidates = [
    {
      reason: 'carry_over_resume',
      primaryContext: trimText(shortState.carryOverUserTurn, 120),
      secondaryContext: recentTopic,
      idleMinutes: 45,
      atSender: true
    },
    {
      reason: 'open_loop_resume',
      primaryContext: trimText(
        shortState.openLoops[0] || shortState.assistantCommitments[0] || '',
        120
      ),
      secondaryContext: recentTopic,
      idleMinutes: 45,
      atSender: true
    },
    {
      reason: 'recent_topic_followup',
      primaryContext: recentTopic,
      secondaryContext: trimText(shortState.summary, 100),
      idleMinutes: 90,
      atSender: false
    },
    {
      reason: 'journal_followup',
      primaryContext: journalText,
      secondaryContext: recentTopic,
      idleMinutes: 120,
      atSender: false
    },
    {
      reason: 'light_care_ping',
      primaryContext: '',
      secondaryContext: recentTopic || journalText,
      idleMinutes: 180,
      atSender: false
    }
  ];

  for (const candidate of candidates) {
    if (idleMs < (candidate.idleMinutes * 60 * 1000)) continue;
    if (candidate.reason !== 'light_care_ping' && !candidate.primaryContext) continue;
    if (candidate.reason === 'light_care_ping' && (now - Number(userState.last_light_care_at || 0)) < getReasonRepeatMs(candidate.reason)) {
      continue;
    }
    const signature = buildTouchSignature(
      candidate.reason,
      candidate.primaryContext || candidate.secondaryContext || ''
    );
    if (
      signature
      && signature === String(userState.last_touch_signature || '').trim()
      && (now - Number(userState.last_touch_signature_at || 0)) < getSignatureRepeatMs()
    ) {
      continue;
    }
    if ((now - Number(userState.last_reason_at?.[candidate.reason] || 0)) < getReasonRepeatMs(candidate.reason)) {
      continue;
    }

    return {
      ...candidate,
      signature,
      journalBundle
    };
  }

  return null;
}

async function sendTouchMessage({
  ws,
  askAIByGraph,
  userId,
  data,
  userState,
  today,
  promptPayload,
  atSender = false,
  now = Date.now(),
  source = 'tick_touch'
}) {
  const groupId = String(data?.group_id || '').trim();
  const candidateReason = String(promptPayload.touchReason || promptPayload.fallbackGreetingType || '').trim();
  const policy = evaluateInitiativePolicy({
    source,
    groupId,
    userId,
    candidateReason,
    contextHints: {
      primaryContext: promptPayload.primaryContext || '',
      secondaryContext: promptPayload.secondaryContext || '',
      fallbackGreetingType: promptPayload.fallbackGreetingType || ''
    }
  }, now);
  if (!policy.allowed) {
    console.log('[initiative] skip', {
      initiative_source: source,
      initiative_candidate_reason: candidateReason,
      initiative_policy_reason: policy.reason,
      initiative_decision_called: false,
      initiative_reply_called: false,
      initiative_skip_due_to_lock_or_gap: ['min-gap-active', 'same-cycle-already-sent'].includes(policy.reason)
    });
    return {
      sent: false,
      text: '',
      reason: policy.reason,
      initiativePolicyReason: policy.reason,
      decisionModelCalled: false,
      replyModelCalled: false,
      decisionReason: ''
    };
  }

  const lockOwner = `${source}:${groupId}:${userId}:${candidateReason}`;
  const lock = acquireInitiativeLock({
    groupId,
    owner: lockOwner,
    now
  });
  if (!lock.acquired) {
    console.log('[initiative] skip', {
      initiative_source: source,
      initiative_candidate_reason: candidateReason,
      initiative_policy_reason: lock.reason,
      initiative_decision_called: false,
      initiative_reply_called: false,
      initiative_skip_due_to_lock_or_gap: true
    });
    return {
      sent: false,
      text: '',
      reason: lock.reason,
      initiativePolicyReason: lock.reason,
      decisionModelCalled: false,
      replyModelCalled: false,
      decisionReason: ''
    };
  }

  try {
    let decisionModelCalled = false;
    let replyModelCalled = false;
    let decision = {
      send: false,
      reason: 'decision-skipped',
      style: String(policy.style || 'light_touch').trim() || 'light_touch',
      urgency: 'low',
      atSender: Boolean(atSender)
    };
    try {
      decisionModelCalled = canCallInitiativeDecisionModel() || config.INITIATIVE_DECISION_ENABLED;
      decision = await invokeInitiativeDecisionModel({
        groupId,
        userId,
        candidateReason,
        source,
        promptPayload: {
          ...promptPayload,
          atSender
        },
        recentMessages: getRecentMessages(groupId),
        policy,
        now
      });
    } catch (error) {
      decision = {
        send: false,
        reason: `decision-call-failed:${error?.message || error}`,
        style: String(policy.style || 'light_touch').trim() || 'light_touch',
        urgency: 'low',
        atSender: Boolean(atSender)
      };
    }

    const strongCandidate = policy.strongCandidate;
    const fallbackAllowed = strongCandidate
      && (
        String(decision.reason || '').trim() === 'invalid-json'
        || String(decision.reason || '').trim() === 'missing-decision-model-config'
        || String(decision.reason || '').startsWith('decision-call-failed:')
      );
    if (!decision.send && !fallbackAllowed) {
      console.log('[initiative] skip', {
        initiative_source: source,
        initiative_candidate_reason: candidateReason,
        initiative_policy_reason: policy.reason,
        initiative_decision_called: decisionModelCalled,
        initiative_decision_result: String(decision.reason || '').trim(),
        initiative_reply_called: false,
        initiative_skip_due_to_lock_or_gap: false
      });
      return {
        sent: false,
        text: '',
        reason: String(decision.reason || 'decision-declined').trim() || 'decision-declined',
        initiativePolicyReason: policy.reason,
        decisionModelCalled,
        replyModelCalled: false,
        decisionReason: String(decision.reason || '').trim()
      };
    }

    let text = '';
    let proactivePersonaMemoryState = null;
    const effectiveAtSender = fallbackAllowed ? Boolean(atSender) : Boolean(decision.atSender);
    if (fallbackAllowed) {
      text = trimText(
        promptPayload.fallbackGreetingType
          ? (promptPayload.fallbackGreetingType === 'morning' ? '早呀，今天也慢慢来。' : '差不多该收一收尾巴了。')
          : (candidateReason === 'carry_over_resume' ? '你上次那件事，我还记着。' : candidateReason === 'open_loop_resume' ? '上次的话题还挂着。' : ''),
        promptPayload?.fallbackGreetingType ? 35 : 60
      );
    } else {
      const promptBundle = await buildProactivePrompt(userId, data, promptPayload);
      proactivePersonaMemoryState = promptBundle?.personaMemoryState || null;
      const prompt = String(promptBundle?.prompt || '').trim();
      replyModelCalled = true;
      const reply = await askAIByGraph(prompt, data, userId, prompt, null, {
        routePolicyKey: 'proactive/default',
        topRouteType: 'proactive',
        disableTools: true,
        disableStream: true,
        disableMemoryLearning: true,
        systemInitiated: true,
        routeMeta: {
          initiativeSource: source,
          initiativeReason: candidateReason
        }
      });
      text = trimText(reply, promptPayload?.fallbackGreetingType ? 35 : 60);
    }

    if (!text) {
      return {
        sent: false,
        text: '',
        reason: 'empty-reply-text',
        initiativePolicyReason: policy.reason,
        decisionModelCalled,
        replyModelCalled,
        decisionReason: String(decision.reason || '').trim()
      };
    }

    const prefix = effectiveAtSender ? `[CQ:at,qq=${userId}] ` : '';
    try {
      sendTouchWebSocketMessage(ws, {
        action: 'send_group_msg',
        params: {
          group_id: groupId,
          message: `${prefix}${text}`
        }
      });
      recordSystemGroupSend({
        groupId,
        senderId: effectiveAtSender ? userId : '',
        text,
        senderName: '瑞希',
        updatePresence: true,
        updateBotPresence: true,
        now,
        source,
        routePolicyKey: 'proactive/default'
      });
      await recordPersonaMemoryOutcome('proactive_touch', {
        state: proactivePersonaMemoryState,
        userId,
        groupId,
        request: {
          userId,
          question: candidateReason || '',
          routeMeta: { groupId },
          routePolicyKey: 'proactive/default',
          topRouteType: 'proactive'
        },
        activeTopic: promptPayload.primaryContext || candidateReason,
        recentReplyFrame: text,
        recentMessages: [{ role: 'assistant', content: text }]
      });
      markInitiativeSent(groupId, {
        source,
        reason: candidateReason,
        cycleKey: String(policy.cycleKey || '').trim()
      }, now);
      if (policy.cycleKey) {
        setLastCycleKey(groupId, policy.cycleKey, now);
      }

      userState.day = today;
      userState.proactive_count = Number(userState.proactive_count || 0) + 1;
      userState.last_proactive_at = now;
      userState.last_proactive_reason = candidateReason;

      if (promptPayload.windowKey) {
        userState.touched_windows = {
          ...(userState.touched_windows || {}),
          [formatWindowBucket(today, promptPayload.windowKey)]: now
        };
      }
      if (promptPayload.signature) {
        userState.last_touch_signature = promptPayload.signature;
        userState.last_touch_signature_at = now;
      }
      if (promptPayload.touchReason) {
        userState.last_reason_at = {
          ...(userState.last_reason_at || {}),
          [promptPayload.touchReason]: now
        };
        if (promptPayload.touchReason === 'light_care_ping') {
          userState.last_light_care_at = now;
        }
      }
      if (promptPayload.fallbackGreetingType === 'morning') {
        userState.last_morning_fallback_day = today;
        data.last_morning = today;
      }
      if (promptPayload.fallbackGreetingType === 'night') {
        userState.last_night_fallback_day = today;
        data.last_night = today;
      }

      console.log('[initiative] sent', {
        initiative_source: source,
        initiative_candidate_reason: candidateReason,
        initiative_policy_reason: policy.reason,
        initiative_decision_called: decisionModelCalled,
        initiative_decision_result: String(decision.reason || '').trim(),
        initiative_reply_called: replyModelCalled,
        initiative_skip_due_to_lock_or_gap: false
      });
      return {
        sent: true,
        text,
        reason: 'sent',
        initiativePolicyReason: policy.reason,
        decisionModelCalled,
        replyModelCalled,
        decisionReason: String(decision.reason || '').trim()
      };
    } catch (error) {
      const reason = getErrorReason(error);
      console.error('[tick] proactive touch send/status failed:', {
        groupId,
        userId,
        source,
        reason
      });
      await recordTouchFailureOutcome({
        error,
        userId,
        groupId,
        candidateReason,
        source,
        promptPayload,
        text
      });
      return {
        sent: false,
        text: '',
        reason,
        initiativePolicyReason: policy.reason,
        decisionModelCalled,
        replyModelCalled,
        decisionReason: String(decision.reason || '').trim()
      };
    }
  } finally {
    releaseInitiativeLock({
      groupId,
      owner: lockOwner,
      now: Date.now()
    });
  }
}

async function runRandomWindowTouches(ws, askAIByGraph, state, date = new Date()) {
  const today = formatDateInTz(date, config.TIMEZONE);
  const currentWindow = getWindowByCurrentTime(date, config.TIMEZONE);
  if (!currentWindow) return false;

  let touchedAny = false;
  const now = date.getTime();
  for (const [userId, data] of Object.entries(favorites || {})) {
    if (!isWindowReadyForUser(userId, today, currentWindow, date)) continue;
    if (!canTriggerProactiveReply(userId, data, state, today, now)) continue;

    const userState = getDailyState(state, userId, today);
    const bucket = formatWindowBucket(today, currentWindow.key);
    if (userState.touched_windows?.[bucket]) continue;

    const candidate = selectTouchCandidate(userId, data, state, today, now);
    if (!candidate) continue;

    const result = await sendTouchMessage({
      ws,
      askAIByGraph,
      userId,
      data,
      userState,
      today,
      now,
      atSender: candidate.atSender,
      promptPayload: {
        touchReason: candidate.reason,
        primaryContext: candidate.primaryContext || '暂无',
        secondaryContext: candidate.secondaryContext || '',
        windowKey: currentWindow.key,
        signature: candidate.signature
      },
      source: 'tick_touch'
    });
    if (!result.sent) continue;

    state[userId] = userState;
    saveTickState(state);
    touchedAny = true;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  return touchedAny;
}

async function runGreetingFallbacks(ws, askAIByGraph, state, date = new Date()) {
  if (!config.PROACTIVE_GREETING_FALLBACK_ENABLED) return false;

  const today = formatDateInTz(date, config.TIMEZONE);
  const now = date.getTime();
  let sentAny = false;
  const morningReady = shouldTriggerFallbackGreeting('morning', date, config.TIMEZONE);
  const nightReady = shouldTriggerFallbackGreeting('night', date, config.TIMEZONE);

  for (const [userId, data] of Object.entries(favorites || {})) {
    const userState = getDailyState(state, userId, today);

    if (morningReady && shouldSendScheduledGreeting(data, 'morning', today, config, userState)) {
      const result = await sendTouchMessage({
        ws,
        askAIByGraph,
        userId,
        data,
        userState,
        today,
        now,
        atSender: true,
        promptPayload: {
          fallbackGreetingType: 'morning',
          touchReason: 'fallback_morning_greeting',
          primaryContext: '上午时段的自然招呼',
          secondaryContext: '',
          signature: buildTouchSignature('fallback_morning_greeting', today)
        },
        source: 'fallback_greeting'
      });
      if (result.sent) {
        state[userId] = userState;
        saveTickState(state);
        sentAny = true;
        continue;
      }
    }

    if (nightReady && shouldSendScheduledGreeting(data, 'night', today, config, userState)) {
      const result = await sendTouchMessage({
        ws,
        askAIByGraph,
        userId,
        data,
        userState,
        today,
        now,
        atSender: true,
        promptPayload: {
          fallbackGreetingType: 'night',
          touchReason: 'fallback_night_greeting',
          primaryContext: '晚间收束式的自然问候',
          secondaryContext: '',
          signature: buildTouchSignature('fallback_night_greeting', today)
        },
        source: 'fallback_greeting'
      });
      if (result.sent) {
        state[userId] = userState;
        saveTickState(state);
        sentAny = true;
      }
    }
  }

  return sentAny;
}

async function runTickCycle(ws, askAIByGraph, state, date = new Date(), actionClient = null, shouldContinue = () => true) {
  if (!shouldContinue()) return false;
  if (shouldRunDailySummaryNow(date)) {
    await runDailyJournalSummaries();
  }

  if (!shouldContinue()) return false;
  await runRandomWindowTouches(ws, askAIByGraph, state, date);
  if (!shouldContinue()) return false;
  await runGreetingFallbacks(ws, askAIByGraph, state, date);
  if (!shouldContinue()) return false;
  await getDailyShareEngine().runDailyShareCycle({
    sendWithRetry: (payload, retries = 1, waitMs = 500) => sendTickPayloadWithRetry(ws, payload, retries, waitMs, actionClient),
    askAIByGraph,
    date
  });
  return true;
}

async function runDailyShareTick(ws, askAIByGraph, date = new Date(), actionClient = null) {
  await getDailyShareEngine().runDailyShareCycle({
    sendWithRetry: (payload, retries = 1, waitMs = 500) => sendTickPayloadWithRetry(ws, payload, retries, waitMs, actionClient),
    askAIByGraph,
    date
  });
}

async function runLifeSchedulerTick(ws, askAIByGraph, date = new Date(), actionClient = null) {
  await getLifeSchedulerEngine().runLifeCycle({
    sendWithRetry: (payload, retries = 1, waitMs = 500) => sendTickPayloadWithRetry(ws, payload, retries, waitMs, actionClient),
    askAIByGraph,
    date
  });
}

function startTickEngine(ws, askAIByGraph, actionClient = null) {
  const state = loadTickState();
  let stopped = false;
  const timers = {
    proactive: null,
    dailyShare: null,
    lifeScheduler: null
  };

  async function runOnce() {
    if (stopped) return;
    try {
      await runTickCycle(ws, askAIByGraph, state, new Date(), actionClient, () => !stopped);
    } catch (error) {
      console.error('[tick] execution failed:', error?.message || error);
    } finally {
      if (!stopped) scheduleProactiveTick(getProactiveScanIntervalMs());
    }
  }

  async function runDailyShareOnce() {
    if (stopped) return;
    try {
      await runDailyShareTick(ws, askAIByGraph, new Date(), actionClient);
    } catch (error) {
      console.error('[tick] daily share execution failed:', error?.message || error);
    } finally {
      if (!stopped) scheduleDailyShareTick(getDailyShareScanIntervalMs());
    }
  }

  async function runLifeSchedulerOnce() {
    if (stopped) return;
    try {
      await runLifeSchedulerTick(ws, askAIByGraph, new Date(), actionClient);
    } catch (error) {
      console.error('[tick] life scheduler execution failed:', error?.message || error);
    } finally {
      if (!stopped) scheduleLifeSchedulerTick(getLifeSchedulerScanIntervalMs());
    }
  }

  function armTimer(slot, delayMs, runner) {
    if (stopped) return;
    if (timers[slot]) {
      clearTimeout(timers[slot]);
      timers[slot] = null;
    }
    timers[slot] = setTimeout(() => {
      timers[slot] = null;
      if (stopped) return;
      void runner();
    }, Math.max(0, Number(delayMs) || 0));
    if (typeof timers[slot].unref === 'function') timers[slot].unref();
  }

  function scheduleProactiveTick(delayMs) {
    armTimer('proactive', delayMs, runOnce);
  }

  function scheduleDailyShareTick(delayMs) {
    armTimer('dailyShare', delayMs, runDailyShareOnce);
  }

  function scheduleLifeSchedulerTick(delayMs) {
    armTimer('lifeScheduler', delayMs, runLifeSchedulerOnce);
  }

  const startDelayMs = getProactiveStartDelayMs();
  const intervalMs = getProactiveScanIntervalMs();
  const dailyShareIntervalMs = getDailyShareScanIntervalMs();
  const lifeSchedulerIntervalMs = getLifeSchedulerScanIntervalMs();

  scheduleProactiveTick(startDelayMs);
  void runDailyShareOnce();
  void runLifeSchedulerOnce();

  console.log(
    `[tick] proactive scheduler armed: first scan in ${Math.floor(startDelayMs / 60000)}m, interval ${Math.floor(intervalMs / 60000)}m`
  );
  console.log(
    `[tick] daily share scheduler armed: immediate first scan, interval ${Math.floor(dailyShareIntervalMs / 60000)}m`
  );
  console.log(
    `[tick] life scheduler armed: immediate first scan, interval ${Math.floor(lifeSchedulerIntervalMs / 60000)}m`
  );

  return {
    stop() {
      stopped = true;
      for (const slot of Object.keys(timers)) {
        if (timers[slot]) {
          clearTimeout(timers[slot]);
          timers[slot] = null;
        }
      }
      console.log('[tick] scheduler stopped');
    }
  };
}

module.exports = {
  startTickEngine,
  loadTickState,
  getDailyState,
  getIdleMs,
  getDailyMax,
  canTriggerProactiveReply,
  buildProactivePrompt,
  getProactiveStartDelayMs,
  getProactiveScanIntervalMs,
  getDailyShareScanIntervalMs,
  getLifeSchedulerScanIntervalMs,
  getTouchMinGapMs,
  getRandomWindows,
  computeWindowTriggerMinutes,
  isWindowReadyForUser,
  selectTouchCandidate,
  shouldSendScheduledGreeting,
  shouldTriggerFallbackGreeting,
  runGreetingFallbacks,
  runDailyShareTick,
  runLifeSchedulerTick,
  runTickCycle
};
