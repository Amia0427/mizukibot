function shouldUseLocalDecisionFallback({ decision, addressee, score }) {
  const reason = String(decision?.reason || '');
  if (!['invalid-json', 'missing-awareness-model-config'].includes(reason) && !reason.startsWith('decision-call-failed:')) return false;
  if (!['bot_presence_check', 'bot_direct'].includes(String(addressee || ''))) return false;
  return Number(score || 0) >= Math.max(60, Number(config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60));
}

function buildLocalReplyFallback({ addressee, replyType }) {
  return '';
}

function cheapRuleGate({ gate, gateWithSocialContext, score, addressee, text, recentMessages, directedContext }) {
  const hasDirectedBot = ['reply_to_bot', 'address_bot'].includes(normalizeText(directedContext?.scene));
  const hasReplyAnchor = ['reply_to_bot', 'reply_to_user'].includes(normalizeText(directedContext?.scene))
    && getQuotePriority(directedContext)?.enabled === true;
  const strongCue = hasStrongBotCue(addressee)
    || hasDirectedBot
    || hasReplyAnchor
    || startsWithBotCue(text)
    || containsBotPresenceCue(text)
    || (containsBotTopic(text) && /(?:你|你这|出来|还在|没反应|坏了|坏掉)/i.test(normalizeText(text)));
  const cheapGateMinScore = Math.max(
    1,
    Number(config.PASSIVE_AWARENESS_CHEAP_GATE_MIN_SCORE || config.PASSIVE_AWARENESS_MIN_TRIGGER_SCORE || 60)
  );
  const continuity = Boolean(
    containsBotTopic(text)
    || containsBotPresenceCue(text)
    || gateWithSocialContext?.reason === 'bot-cued-allow'
    || recentMessages.some((item) => containsBotTopic(item?.text) || containsBotPresenceCue(item?.text))
  );

  if (gateWithSocialContext?.shouldSkip) {
    return {
      level: 'drop',
      reason: gateWithSocialContext.reason || 'cheap-gate-social-lock',
      strongCue
    };
  }
  if (gate?.shouldSkip) {
    return {
      level: 'drop',
      reason: gate.reason || 'cheap-gate-local-skip',
      strongCue
    };
  }
  if (strongCue) {
    return {
      level: 'strong_candidate',
      reason: 'strong-bot-cue',
      strongCue: true
    };
  }
  if (!continuity && score < cheapGateMinScore) {
    return {
      level: 'drop',
      reason: 'cheap-score-too-low',
      strongCue: false
    };
  }
  return {
    level: 'candidate',
    reason: continuity ? 'bot-topic-continuity' : 'cheap-score-pass',
    strongCue: false
  };
}

async function invokeDecisionModel({
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
  if (!config.PASSIVE_AWARENESS_DECISION_ENABLED) {
    return {
      shouldReply: false,
      confidence: 0,
      reason: 'decision-disabled'
    };
  }
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    return {
      shouldReply: false,
      confidence: 0,
      reason: 'missing-awareness-model-config'
    };
  }

  const prompt = buildDecisionPrompt({
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
    gate,
    directedContext,
    now
  });
  const resp = await postWithRetry(
    baseUrl,
    {
      model,
      temperature: Number(config.PASSIVE_AWARENESS_TEMPERATURE || 0.4),
      top_p: Number(config.PASSIVE_AWARENESS_TOP_P || 0.9),
      messages: [
        { role: 'system', content: 'You are a QQ passive reply decision model. Return JSON only with should_reply, confidence, reason.' },
        { role: 'user', content: buildPassiveModelUserContent(prompt, visualInputs) }
      ],
      max_tokens: Math.max(120, Number(config.PASSIVE_AWARENESS_MAX_TOKENS || 300)),
      stream: false,
      __timeoutMs: Math.max(1000, Number(config.PASSIVE_AWARENESS_TIMEOUT_MS || 15000)),
      __trace: {
        source: 'passive_awareness',
        phase: 'awareness_decision',
        purpose: 'group_passive_should_reply',
        routePolicyKey: 'passive-awareness/decision',
        topRouteType: 'lookup',
        userId: ''
      }
    },
    Math.max(0, Number(config.PASSIVE_AWARENESS_RETRIES || 1)),
    apiKey
  );

  const msg = extractMessageContent(resp);
  const rawDecisionText = String(msg?.content || '');
  const parsed = parseDecision(rawDecisionText);
  if (parsed.reason === 'invalid-json') {
    console.warn('[group-awareness] decision model returned non-json output', {
      groupId: String(groupId || ''),
      senderName: normalizeText(senderName || ''),
      addressee: String(addressee || ''),
      score: Number(score || 0),
      rawPreview: trimReplyText(rawDecisionText, 160)
    });
  }
  return parsed;
}

async function invokeReplyModel({
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
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_REPLY_API_BASE_URL || config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_REPLY_API_KEY || config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_REPLY_MODEL || config.PASSIVE_AWARENESS_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) {
    return {
      replyText: '',
      personaMemoryState: null
    };
  }

  const promptBundle = await buildReplyPromptV2({
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
  const prompt = String(promptBundle?.prompt || '').trim();
  let sseState = { buffer: '' };
  let streamedText = '';
  let rawStreamText = '';

  await postStreamWithRetry(
    baseUrl,
    {
      model,
      temperature: Number(config.PASSIVE_AWARENESS_REPLY_TEMPERATURE || 0.9),
      top_p: Number(config.PASSIVE_AWARENESS_REPLY_TOP_P || 0.92),
      messages: [
        { role: 'system', content: 'You generate a final passive QQ group reply. Output only the reply text.' },
        { role: 'user', content: buildPassiveModelUserContent(prompt, visualInputs) }
      ],
      max_tokens: Math.max(160, Number(config.PASSIVE_AWARENESS_REPLY_MAX_TOKENS || 320)),
      stream: true,
      __timeoutMs: Math.max(1000, Number(config.PASSIVE_AWARENESS_REPLY_TIMEOUT_MS || 20000)),
      __trace: {
        source: 'passive_awareness',
        phase: 'awareness_reply',
        purpose: 'group_passive_reply_generation',
        routePolicyKey: 'passive-awareness/reply',
        topRouteType: 'chat',
        userId: ''
      }
    },
    {
      onData(chunk) {
        const chunkText = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
        rawStreamText += chunkText;
        const parsed = extractSSEEvents(sseState, chunkText);
        sseState = parsed.state;
        for (const event of parsed.events) {
          if (event?.delta) streamedText += event.delta;
        }
      }
    },
    Math.max(0, Number(config.PASSIVE_AWARENESS_REPLY_RETRIES || 1)),
    apiKey
  );

  for (const event of flushSSEState(sseState)) {
    if (event?.delta) streamedText += event.delta;
  }

  if (!streamedText && rawStreamText) {
    const fallbackMsg = extractMessageContent({ data: rawStreamText });
    streamedText = String(fallbackMsg?.content || '');
  }

  return {
    replyText: trimReplyText(streamedText, 80),
    personaMemoryState: promptBundle?.personaMemoryState || null
  };
}

