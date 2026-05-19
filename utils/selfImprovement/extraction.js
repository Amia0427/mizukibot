function createSelfImprovementExtraction(deps = {}) {
  const {
    appendEvent,
    appendPerfEvent,
    clampNumber,
    config,
    derivePriority,
    ensureEnabled,
    extractMessageContent,
    getBackgroundPressureDelayMs,
    normalizeArray,
    normalizeKind,
    normalizeObject,
    normalizeRouteContext,
    postWithRetry,
    redactSensitiveText,
    sanitizeUntrustedContent,
    shouldBlockSelfImprovementText,
    trimText
  } = deps;

  function getExtractionApiBaseUrl() {
    return String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').trim();
  }

  function getExtractionApiKey() {
    if (String(config.MEMORY_API_BASE_URL || '').trim()) {
      return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
    }
    return String(config.API_KEY || '').trim();
  }

  function ensureChatCompletionsUrl(url) {
    const u = String(url || '').replace(/\/+$/, '');
    if (/\/chat\/completions$/i.test(u)) return u;
    if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
    return u;
  }

  function getExtractionModelName() {
    return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
  }

  function normalizeTextContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
    return String(content || '');
  }

  function extractJsonSafely(text = '') {
    const raw = String(text || '').trim();
    if (!raw) return null;
    const fenced = raw.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
    const candidate = fenced ? String(fenced[1] || '').trim() : raw;
    try {
      return JSON.parse(candidate);
    } catch (_) {
      const match = candidate.match(/\{[\s\S]*\}/);
      if (!match) return null;
      try {
        return JSON.parse(match[0]);
      } catch (_) {
        return null;
      }
    }
  }

  function buildExtractionPrompt() {
    return [
      'You extract reusable self-improvement events from a single successful assistant turn.',
      'Return JSON only with shape:',
      '{',
      '  "items": [',
      '    {',
      '      "kind": "error|correction|feature_request|strategy|knowledge_gap",',
      '      "pattern_key": "",',
      '      "summary": "",',
      '      "details": "",',
      '      "suggested_action": "",',
      '      "confidence": 0.0,',
      '      "priority": 0.0,',
      '      "evidence": ["", "", ""]',
      '    }',
      '  ]',
      '}',
      'Rules:',
      '- Prefer strategy when the turn demonstrates a reusable successful tactic.',
      '- Use knowledge_gap only for missing knowledge that limited quality.',
      '- Keep each summary short and generalizable.',
      '- At most 3 items.',
      '- If nothing reusable exists, return {"items":[]}.'
    ].join('\n');
  }

  function buildExtractionConversation(userText, botReply, options = {}) {
    const routeContext = normalizeRouteContext(options);
    const execLogs = normalizeArray(options.execLogs).slice(0, 6).map((item) => ({
      action: trimText(item.action || '', 80),
      purpose: redactSensitiveText(item.purpose || '', 120),
      ok: Boolean(item.ok),
      result: redactSensitiveText(item.result || '', 180),
      error: redactSensitiveText(item.error || '', 180)
    }));
    return [
      `User: ${redactSensitiveText(userText, 1200)}`,
      `Assistant: ${redactSensitiveText(botReply, 1600)}`,
      `RoutePolicyKey: ${routeContext.routePolicyKey}`,
      `TopRouteType: ${routeContext.topRouteType}`,
      `TaskType: ${routeContext.taskType}`,
      `ToolName: ${routeContext.toolName}`,
      `ExecLogs: ${JSON.stringify(execLogs)}`
    ].join('\n');
  }

  function storeExtractedSelfImprovementItems(userId, items = [], options = {}) {
    const uid = trimText(userId, 120);
    if (!uid) return [];
    const stored = [];
    for (const raw of normalizeArray(items).slice(0, 3)) {
      const item = normalizeObject(raw, {});
      const confidence = clampNumber(item.confidence, 0, 1, 0);
      if (confidence < Number(config.SELF_IMPROVEMENT_EXTRACT_MIN_CONFIDENCE || 0.78)) continue;
      const event = appendEvent({
        kind: item.kind,
        source: 'llm_extraction',
        status: 'open',
        patternKey: item.pattern_key || item.patternKey || options.taskType || options.routePolicyKey || 'strategy',
        priority: clampNumber(item.priority, 0, 1, derivePriority(normalizeKind(item.kind))),
        summary: sanitizeUntrustedContent(item.summary, 'self_improvement'),
        details: sanitizeUntrustedContent(item.details, 'self_improvement'),
        suggestedAction: sanitizeUntrustedContent(item.suggested_action || item.suggestedAction, 'self_improvement'),
        confidence,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        toolName: options.toolName,
        taskType: options.taskType,
        sessionId: options.sessionId,
        channelId: options.channelId,
        groupId: options.groupId,
        userId: uid,
        evidence: normalizeArray(item.evidence).map((entry) => ({ excerpt: sanitizeUntrustedContent(entry, 'self_improvement') }))
      });
      if (event) stored.push(event);
    }
    return stored;
  }

  async function learnSelfImprovement(userId, userText, botReply, options = {}) {
    if (!ensureEnabled() || !config.SELF_IMPROVEMENT_EXTRACTION_ENABLED) return [];
    const pressureDelayMs = getBackgroundPressureDelayMs();
    if (pressureDelayMs > 0) {
      appendPerfEvent({
        category: 'background_pressure',
        type: 'self_improvement_deferred',
        delayMs: pressureDelayMs,
        userId: trimText(userId, 120)
      });
      return [];
    }
    const uid = trimText(userId, 120);
    const question = trimText(userText, 2000);
    const answer = trimText(botReply, 3000);
    if (!uid || !question || !answer) return [];
    if (shouldBlockSelfImprovementText(`${question}\n${answer}`).blocked) return [];

    const apiBaseUrl = getExtractionApiBaseUrl();
    const apiKey = getExtractionApiKey();
    if (!apiBaseUrl || !apiKey) return [];

    try {
      const resp = await postWithRetry(
        ensureChatCompletionsUrl(apiBaseUrl),
        {
          model: getExtractionModelName(),
          temperature: 0.2,
          top_p: 0.9,
          messages: [
            { role: 'system', content: buildExtractionPrompt() },
            { role: 'user', content: buildExtractionConversation(question, answer, options) }
          ],
          max_tokens: 360,
          stream: false,
          __trace: {
            source: 'self_improvement',
            phase: 'extract',
            purpose: 'self_improvement_learning',
            userId: uid,
            routePolicyKey: trimText(options.routePolicyKey || '', 120),
            topRouteType: trimText(options.topRouteType || '', 80)
          }
        },
        1,
        apiKey
      );
      const msg = extractMessageContent(resp);
      const parsed = extractJsonSafely(normalizeTextContent(msg?.content));
      const items = normalizeArray(parsed?.items).slice(0, 3);
      return storeExtractedSelfImprovementItems(uid, items, options);
    } catch (error) {
      console.error('[self-improvement] async extraction failed:', error?.message || error);
      if (options.throwOnError) throw error;
      return [];
    }
  }

  return {
    learnSelfImprovement,
    storeExtractedSelfImprovementItems
  };
}

module.exports = {
  createSelfImprovementExtraction
};
