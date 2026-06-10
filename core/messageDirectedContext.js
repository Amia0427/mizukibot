const config = require('../config');
const { postWithRetry } = require('../api/httpClient');
const { extractMessageContent, extractJsonSafely } = require('../api/parser');
const { getRecentMessages } = require('../utils/groupAwarenessState');
const { inferActivePair, resolveEdge } = require('../utils/socialContextRuntime');

function normalizeText(value, maxChars = 240) {
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

function containsBotCue(text = '') {
  const t = normalizeText(text).toLowerCase();
  if (!t) return false;
  return /(?:bot|瑞希|机器人|ai|模型|napcat|回复|插件|接入|说话|在吗|还在|出来)/i.test(t);
}

function containsGroupCue(text = '') {
  const t = normalizeText(text);
  if (!t) return false;
  return /(?:大家|你们|谁|有人|哪位|有没有|有无|懂|知道|会不会|能不能)/i.test(t);
}

function containsQuestionSignal(text = '') {
  const t = normalizeText(text);
  if (!t) return false;
  return /[?？]|(?:怎么|如何|是不是|能不能|会不会|为什么|咋|啥意思)/i.test(t);
}

function createQuoteFromReplyContext(replyContext = {}) {
  if (!replyContext || typeof replyContext !== 'object') return null;
  const messageId = normalizeText(replyContext.messageId || replyContext.message_id || '');
  const senderId = normalizeText(replyContext.senderId || replyContext.sender_id || '');
  const senderName = normalizeText(replyContext.senderName || replyContext.sender_name || '');
  const origin = normalizeText(replyContext.origin || '', 40) || 'reply_quote';
  const text = normalizeText(replyContext.text || '', 300);
  const hasImage = Boolean(replyContext.hasImage) || (Array.isArray(replyContext.imageUrls) && replyContext.imageUrls.length > 0);
  if (!messageId && !senderId && !senderName && !origin && !text && !hasImage) return null;
  return {
    messageId,
    senderId,
    senderName,
    origin,
    hasImage,
    text
  };
}

function normalizeRecentMessages(recentMessages = []) {
  return (Array.isArray(recentMessages) ? recentMessages : []).map((item) => ({
    senderId: normalizeText(item?.sender_id || item?.senderId || ''),
    senderName: normalizeText(item?.sender_name || item?.senderName || '', 80),
    text: normalizeText(item?.text || '', 240),
    timestamp: Number(item?.timestamp || 0) || 0
  })).filter((item) => item.senderId || item.senderName || item.text);
}

function formatAddresseeText(addressee = {}) {
  const kind = String(addressee?.kind || 'unknown').trim() || 'unknown';
  const name = normalizeText(addressee?.senderName || '', 80);
  const userId = normalizeText(addressee?.userId || '', 80);
  if (kind === 'bot') return 'bot';
  if (kind === 'group') return 'the whole group';
  if (kind === 'user') return name || userId || 'another user';
  return 'unclear';
}

function createDefaultQuotePriority() {
  return {
    enabled: false,
    mode: 'none',
    reason: '',
    quoteAnchoredText: '',
    quoteFocus: null
  };
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const text = normalizeText(value, 300);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function extractForwardSummaryFromRawText(rawText = '') {
  const raw = String(rawText || '').trim();
  if (!raw || !raw.includes('[转发消息]')) return '';
  const afterMarker = raw.split('[转发消息]').slice(1).join('[转发消息]').trim();
  if (!afterMarker) return '';
  const stopIndex = afterMarker.search(/\n\s*(?:\[转发图片\]|\[CQ:image,)/i);
  const candidate = stopIndex >= 0 ? afterMarker.slice(0, stopIndex) : afterMarker;
  return normalizeText(candidate, 1000);
}

function createForwardContext(input = {}) {
  const meta = input?.continuousMeta && typeof input.continuousMeta === 'object'
    ? input.continuousMeta
    : {};
  const summaryText = normalizeText(
    meta.forwardSummaryText || input.forwardSummaryText || extractForwardSummaryFromRawText(input.rawText || input.cleanText || ''),
    1000
  );
  const forwardIds = uniqueStrings(meta.forwardIds || input.forwardIds || []);
  const imageUrls = uniqueStrings(meta.forwardImageUrls || input.forwardImageUrls || []);
  if (!summaryText && forwardIds.length === 0 && imageUrls.length === 0) return null;
  return {
    source: 'current_message_forward',
    ids: forwardIds,
    summaryText,
    imageUrls,
    imageCount: imageUrls.length
  };
}

function charLength(text = '') {
  return Array.from(String(text || '').trim()).length;
}

function hasStrongShortFollowupCue(text = '') {
  const t = normalizeText(text, 160);
  if (!t) return false;
  return /(为什么|为啥|然后呢|然后|咋办|怎么办|继续|细说|展开|怎么做|怎么看|啥意思|什么意思|详细说说|说下去|接着呢|再然后|然后怎么|接下来呢)/i.test(t);
}

function hasPronounReferenceCue(text = '') {
  const t = normalizeText(text, 160);
  if (!t) return false;
  return /(这个|这条|上面|前面|那条|它|这里|这个意思|这啥意思|这是什么意思|这张图|图里|引用那条|引用那张|上面那张|上面这张|前面那张|前面这张)/i.test(t);
}

function hasImageFollowupCue(text = '') {
  const t = normalizeText(text, 160);
  if (!t) return false;
  return /(这张图|图里|图上|图片里|图片上|这图|这图片|上面那张图|引用那张图|图什么意思|看图|图中|图中这个|图中这块)/i.test(t);
}

function refersToCurrentImage(text = '') {
  const t = normalizeText(text, 160);
  if (!t) return false;
  return /(我发的这张|我这张|看我这张|这张图|这张图片|我发这张|我贴这张|我这图)/i.test(t);
}

function refersToQuotedImage(text = '') {
  const t = normalizeText(text, 160);
  if (!t) return false;
  return /(上面那张|引用那张|前面那张|回复那张|那张图|上面这张图|前面这张图|引用图片|回复图片)/i.test(t);
}

function isSemanticallyCompleteRequest(text = '') {
  const t = normalizeText(text, 200);
  if (!t) return false;
  if (charLength(t) >= 18) return true;
  if (/[，。；：.!?？]/.test(t) && charLength(t) >= 10) return true;
  if (/(请|帮我|帮忙|给我|告诉我|解释|总结|分析|查询|搜索|看看|列出|写一个|做一个|生成|制定|推荐)/i.test(t) && charLength(t) >= 8) {
    return true;
  }
  return false;
}

function buildQuoteFocus(quote = null) {
  if (!quote || typeof quote !== 'object') return null;
  const text = normalizeText(quote.text || '', 180);
  const senderName = normalizeText(quote.senderName || quote.senderId || '', 80);
  const origin = normalizeText(quote.origin || '', 40);
  const hasImage = quote.hasImage === true;
  if (!text && !senderName && !origin && !hasImage) return null;
  return {
    text,
    hasImage,
    senderName,
    origin
  };
}

function buildQuoteAnchoredText({ cleanText = '', quote = null, reason = '' } = {}) {
  const userText = normalizeText(cleanText, 200);
  const quoteText = normalizeText(quote?.text || '', 180);
  const quoteHasImage = quote?.hasImage === true;
  if (!userText) return '';
  if (reason === 'reply_image_followup' && quoteHasImage) {
    if (quoteText) return `围绕引用图片“${quoteText}”：${userText}`;
    return `围绕引用图片：${userText}`;
  }
  if (quoteText) return `基于引用内容“${quoteText}”，${userText}`;
  if (quoteHasImage) return `基于引用图片，${userText}`;
  return '';
}

function resolveQuotePriority({ cleanText = '', resolved = null, quote = null } = {}) {
  const defaultPriority = createDefaultQuotePriority();
  if (!quote || !resolved || !['reply_to_bot', 'reply_to_user'].includes(String(resolved.scene || '').trim())) {
    return defaultPriority;
  }

  const text = normalizeText(cleanText, 200);
  const quoteFocus = buildQuoteFocus(quote);
  const shortText = charLength(text) > 0 && charLength(text) <= 14;
  const strongFollowup = hasStrongShortFollowupCue(text);
  const pronounFollowup = hasPronounReferenceCue(text);
  const imageFollowup = quote.hasImage === true && hasImageFollowupCue(text);
  const semanticallyComplete = isSemanticallyCompleteRequest(text);

  let mode = 'context_bias';
  let reason = 'reply_context_bias';
  if (imageFollowup) {
    mode = 'anchored_rewrite';
    reason = 'reply_image_followup';
  } else if (pronounFollowup) {
    mode = 'anchored_rewrite';
    reason = 'reply_pronoun_reference';
  } else if (shortText && (strongFollowup || !semanticallyComplete)) {
    mode = 'anchored_rewrite';
    reason = strongFollowup ? 'reply_short_followup' : 'reply_context_incomplete';
  } else if (!semanticallyComplete && charLength(text) <= 20) {
    mode = 'anchored_rewrite';
    reason = 'reply_context_incomplete';
  }

  return {
    enabled: true,
    mode,
    reason,
    quoteAnchoredText: mode === 'anchored_rewrite'
      ? buildQuoteAnchoredText({ cleanText: text, quote, reason })
      : '',
    quoteFocus
  };
}

function buildPromptSnippet(resolved = {}) {
  const addresseeText = formatAddresseeText(resolved.addressee);
  const forwardContext = resolved.forwardContext && typeof resolved.forwardContext === 'object'
    ? resolved.forwardContext
    : null;
  const lines = [
    '[CurrentConversation]',
    `scene=${normalizeText(resolved.scene || 'unclear', 40) || 'unclear'}`,
    `current_message_to=${addresseeText}`
  ];
  if (resolved.quote) {
    const quoteFrom = normalizeText(resolved.quote.senderName || resolved.quote.senderId || '', 80);
    if (resolved.quote.origin) lines.push(`quoted_message_origin=${normalizeText(resolved.quote.origin, 40)}`);
    if (quoteFrom) lines.push(`quoted_message_from=${quoteFrom}`);
    if (resolved.quote.hasImage) lines.push('quoted_message_has_image=true');
    if (resolved.quote.text) lines.push(`quoted_message_text=${normalizeText(resolved.quote.text, 180)}`);
  }
  if (resolved.activePair?.userA && resolved.activePair?.userB) {
    lines.push(`active_pair=${resolved.activePair.userA}<->${resolved.activePair.userB}`);
  }
  if (forwardContext) {
    lines.push(`forward_context_source=${normalizeText(forwardContext.source || 'current_message_forward', 60) || 'current_message_forward'}`);
    if (Array.isArray(forwardContext.ids) && forwardContext.ids.length) {
      lines.push(`forwarded_message_ids=${forwardContext.ids.map((item) => normalizeText(item, 60)).filter(Boolean).join(',')}`);
    }
    const imageCount = Math.max(0, Number(forwardContext.imageCount || forwardContext.imageUrls?.length || 0) || 0);
    if (imageCount > 0) lines.push(`forwarded_message_image_count=${imageCount}`);
    if (forwardContext.summaryText) lines.push(`forwarded_message_text=${normalizeText(forwardContext.summaryText, 900)}`);
    lines.push('instruction=Treat forwarded_message_text from the current turn as visible conversation context, not as missing memory.');
    lines.push('instruction=When the user asks what a quoted sentence or reaction referred to, check forwarded_message_text before saying the prior context is unknown.');
  }
  const quotePriority = resolved.quotePriority && typeof resolved.quotePriority === 'object'
    ? resolved.quotePriority
    : createDefaultQuotePriority();
  lines.push(`quote_priority_mode=${normalizeText(quotePriority.mode || 'none', 40) || 'none'}`);
  if (quotePriority.reason) lines.push(`quote_priority_reason=${normalizeText(quotePriority.reason, 80)}`);
  if (quotePriority.quoteFocus?.text) lines.push(`quote_focus_text=${normalizeText(quotePriority.quoteFocus.text, 180)}`);
  if (quotePriority.quoteFocus?.hasImage === true) lines.push('quote_focus_has_image=true');
  if (quotePriority.quoteAnchoredText) lines.push(`quote_anchored_text=${normalizeText(quotePriority.quoteAnchoredText, 220)}`);
  lines.push(`instruction=Treat the current message as primarily directed to ${addresseeText}.`);
  if (quotePriority.enabled) {
    lines.push('instruction=Interpret the current message as operating on the quoted message first.');
  }
  return lines.join('\n');
}

function buildRouteSummary(resolved = {}, historySummary = '', maxChars = 320) {
  const parts = [buildPromptSnippet(resolved), normalizeText(historySummary, maxChars)];
  const text = parts.filter(Boolean).join('\n');
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 3)).trim()}...`;
}

function resolveFromReply({ quote, senderId, botQQ }) {
  if (!quote) return null;
  const targetSenderId = normalizeText(quote.senderId || '');
  const targetSenderName = normalizeText(quote.senderName || '', 80);
  const botId = normalizeText(botQQ || config.BOT_QQ || '');
  if (targetSenderId && botId && targetSenderId === botId) {
    return {
      scene: 'reply_to_bot',
      addressee: {
        kind: 'bot',
        userId: targetSenderId,
        senderName: targetSenderName,
        confidence: 1,
        reason: 'reply_quote_to_bot'
      }
    };
  }
  if (targetSenderId && targetSenderId !== normalizeText(senderId || '')) {
    return {
      scene: 'reply_to_user',
      addressee: {
        kind: 'user',
        userId: targetSenderId,
        senderName: targetSenderName,
        confidence: 1,
        reason: 'reply_quote_to_user'
      }
    };
  }
  if (targetSenderName) {
    return {
      scene: 'reply_to_user',
      addressee: {
        kind: 'user',
        userId: targetSenderId,
        senderName: targetSenderName,
        confidence: 0.95,
        reason: 'reply_quote_to_named_user'
      }
    };
  }
  return null;
}

function resolveFromActivePair({ recentMessages, senderId, groupId }) {
  const pair = inferActivePair(recentMessages);
  if (!pair) return null;
  const normalizedSenderId = normalizeText(senderId || '');
  if (![pair.userA, pair.userB].includes(normalizedSenderId)) return { pair, resolution: null };
  const otherUserId = pair.userA === normalizedSenderId ? pair.userB : pair.userA;
  const edgeForward = resolveEdge(groupId, normalizedSenderId, otherUserId);
  const edgeBackward = resolveEdge(groupId, otherUserId, normalizedSenderId);
  const pairStrength = Number(edgeForward.strength || 0) + Number(edgeBackward.strength || 0);
  if (pairStrength < 8) return { pair, resolution: null };
  const otherName = normalizeText(
    recentMessages
      .slice()
      .reverse()
      .find((item) => normalizeText(item.sender_id || item.senderId || '') === otherUserId)?.sender_name
    || '',
    80
  );
  return {
    pair,
    resolution: {
      scene: 'human_pair_chat',
      addressee: {
        kind: 'user',
        userId: otherUserId,
        senderName: otherName,
        confidence: 0.82,
        reason: 'active_pair'
      }
    }
  };
}

function buildDirectedContextBase(input = {}, recentMessages = []) {
  const quote = createQuoteFromReplyContext(input.replyContext || input.continuousMeta?.replyContext || null);
  const forwardContext = createForwardContext(input);
  const base = {
    scene: 'unclear',
    addressee: {
      kind: 'unknown',
      userId: '',
      senderName: '',
      confidence: 0,
      reason: 'unresolved'
    },
    quote,
    forwardContext,
    quotePriority: createDefaultQuotePriority(),
    signals: {
      hasReplyQuote: Boolean(quote),
      hasForwardContext: Boolean(forwardContext),
      hasForwardImages: Boolean(forwardContext?.imageCount),
      hasAtBot: Boolean(input.isAtBot),
      hasBotCue: containsBotCue(input.cleanText || input.rawText || ''),
      hasGroupCue: containsGroupCue(input.cleanText || input.rawText || ''),
      hasActivePair: Boolean(inferActivePair(recentMessages))
    },
    activePair: null,
    promptSnippet: '',
    routeSummary: '',
    fallbackUsed: false
  };
  return base;
}

function buildFallbackPayload({ cleanText, rawText, botQQ, quote, forwardContext, signals, recentMessages }) {
  return {
    currentMessage: {
      rawText: normalizeText(rawText, 400),
      cleanText: normalizeText(cleanText, 300),
      botQQ: normalizeText(botQQ, 80)
    },
    quote: quote || null,
    forwardContext: forwardContext
      ? {
          source: normalizeText(forwardContext.source || 'current_message_forward', 60),
          summaryText: normalizeText(forwardContext.summaryText || '', 500),
          imageCount: Math.max(0, Number(forwardContext.imageCount || 0) || 0)
        }
      : null,
    signals,
    recentMessages: recentMessages.slice(-6).map((item) => ({
      senderId: item.senderId,
      senderName: item.senderName,
      text: item.text
    })),
    outputSchema: {
      scene: 'reply_to_bot|reply_to_user|address_bot|group_question|human_pair_chat|broadcast|unclear',
      addressee: {
        kind: 'bot|user|group|unknown',
        userId: 'string',
        senderName: 'string',
        confidence: '0-1',
        reason: 'string'
      }
    }
  };
}

async function resolveByLlmFallback(input = {}, base = {}, recentMessages = []) {
  const baseUrl = ensureChatCompletionsUrl(config.PASSIVE_AWARENESS_API_BASE_URL);
  const apiKey = String(config.PASSIVE_AWARENESS_API_KEY || '').trim();
  const model = String(config.PASSIVE_AWARENESS_MODEL || '').trim();
  if (!baseUrl || !apiKey || !model) return null;
  try {
    const response = await postWithRetry(
      baseUrl,
      {
        model,
        temperature: 0,
        top_p: 0.2,
        messages: [
          {
            role: 'system',
            content: [
              'You classify who the current QQ group message is primarily directed to.',
              'Return JSON only.',
              'Do not explain.',
              'Prefer explicit reply and @ signals over text guesswork.'
            ].join('\n')
          },
          {
            role: 'user',
            content: JSON.stringify(buildFallbackPayload({
              cleanText: input.cleanText,
              rawText: input.rawText,
              botQQ: input.botQQ,
              quote: base.quote
                ? {
                    ...base.quote,
                    text: normalizeText(base.quote.text, 180)
                  }
                : null,
              forwardContext: base.forwardContext,
              signals: base.signals,
              recentMessages
            }))
          }
        ],
        max_tokens: 220,
        stream: false,
        __timeoutMs: Math.max(1000, Number(config.PASSIVE_AWARENESS_TIMEOUT_MS || 15000))
      },
      0,
      apiKey
    );
    const msg = extractMessageContent(response);
    const parsed = extractJsonSafely(String(msg?.content || '').trim());
    if (!parsed || typeof parsed !== 'object') return null;
    const addressee = parsed.addressee && typeof parsed.addressee === 'object' ? parsed.addressee : {};
    const scene = normalizeText(parsed.scene || '', 40);
    const kind = normalizeText(addressee.kind || '', 20);
    if (!scene || !['reply_to_bot', 'reply_to_user', 'address_bot', 'group_question', 'human_pair_chat', 'broadcast', 'unclear'].includes(scene)) {
      return null;
    }
    if (!['bot', 'user', 'group', 'unknown'].includes(kind)) return null;
    return {
      scene,
      addressee: {
        kind,
        userId: normalizeText(addressee.userId || '', 80),
        senderName: normalizeText(addressee.senderName || '', 80),
        confidence: Math.max(0, Math.min(1, Number(addressee.confidence || 0) || 0)),
        reason: normalizeText(addressee.reason || 'llm_fallback', 80) || 'llm_fallback'
      }
    };
  } catch (_) {
    return null;
  }
}

async function resolveMessageDirectedContext(input = {}) {
  const groupId = normalizeText(input.groupId || input.effectiveMsg?.group_id || input.msg?.group_id || '');
  const senderId = normalizeText(input.senderId || input.effectiveMsg?.user_id || input.msg?.user_id || '');
  const recentMessages = normalizeRecentMessages(
    Array.isArray(input.recentMessages) && input.recentMessages.length
      ? input.recentMessages
      : (groupId ? getRecentMessages(groupId) : [])
  );
  const base = buildDirectedContextBase(input, recentMessages);
  const historySummary = normalizeText(input.historySummary || '', 320);
  let resolved = null;

  resolved = resolveFromReply({
    quote: base.quote,
    senderId,
    botQQ: input.botQQ
  });

  if (!resolved && base.signals.hasAtBot) {
    resolved = {
      scene: 'address_bot',
      addressee: {
        kind: 'bot',
        userId: normalizeText(input.botQQ || config.BOT_QQ || '', 80),
        senderName: 'bot',
        confidence: 1,
        reason: 'at_bot'
      }
    };
  }

  if (!resolved && base.signals.hasBotCue) {
    resolved = {
      scene: 'address_bot',
      addressee: {
        kind: 'bot',
        userId: normalizeText(input.botQQ || config.BOT_QQ || '', 80),
        senderName: 'bot',
        confidence: 0.88,
        reason: 'bot_cue'
      }
    };
  }

  if (!resolved) {
    const pairResult = resolveFromActivePair({
      recentMessages,
      senderId,
      groupId
    });
    base.activePair = pairResult?.pair || null;
    if (pairResult?.resolution) resolved = pairResult.resolution;
  }

  if (!resolved && base.signals.hasGroupCue && containsQuestionSignal(input.cleanText || input.rawText || '')) {
    resolved = {
      scene: 'group_question',
      addressee: {
        kind: 'group',
        userId: '',
        senderName: 'group',
        confidence: 0.85,
        reason: 'group_cue_question'
      }
    };
  }

  if (!resolved) {
    const llmResolved = await resolveByLlmFallback(input, base, recentMessages);
    if (llmResolved) {
      resolved = llmResolved;
      base.fallbackUsed = true;
    }
  }

  if (!resolved && containsQuestionSignal(input.cleanText || input.rawText || '')) {
    resolved = {
      scene: 'broadcast',
      addressee: {
        kind: 'group',
        userId: '',
        senderName: 'group',
        confidence: 0.45,
        reason: 'broadcast_question_fallback'
      }
    };
  }

  const finalResult = {
    ...base,
    ...(resolved || {}),
    activePair: base.activePair
  };
  finalResult.quotePriority = resolveQuotePriority({
    cleanText: input.cleanText || input.rawText || '',
    resolved: finalResult,
    quote: finalResult.quote
  });
  finalResult.promptSnippet = buildPromptSnippet(finalResult);
  finalResult.routeSummary = buildRouteSummary(finalResult, historySummary, 320);
  return finalResult;
}

module.exports = {
  buildPromptSnippet,
  buildRouteSummary,
  containsBotCue,
  containsGroupCue,
  containsQuestionSignal,
  createQuoteFromReplyContext,
  resolveMessageDirectedContext
};
