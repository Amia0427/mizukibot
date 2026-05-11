function buildQzoneDailySharePromptFromPlan({ payload, plan, memoryBlock = '', retryNote = '' }) {
  return [
    typeof payload.buildPrompt === 'function'
      ? payload.buildPrompt({
        variationProfile: plan.variationProfile || {},
        recentHistory: require('./qzoneGenerationState').getRecentQzoneHistory()
      })
      : payload.prompt,
    buildPlanPrompt(plan, { type: payload.type || '' }),
    memoryBlock,
    retryNote
  ].filter(Boolean).join('\n\n');
}

function buildDailyShareVariantNote(variantType = '') {
  const normalized = String(variantType || '').trim().toLowerCase();
  if (normalized === 'edge_variant') {
    return '这个候选允许一点坏劲和反差，但仍然要像真人会发圈，不要攻击人。';
  }
  if (normalized === 'image_variant') {
    return '这个候选优先增强画面、动作和可截图感。';
  }
  return '这个候选优先像真人会随手发的状态碎片，自然、不装、能截图。';
}

function advanceWindowPointer(targetConfig, stateEntry, windowKey) {
  const sequence = Array.isArray(targetConfig?.sequences?.[windowKey]) ? targetConfig.sequences[windowKey] : [];
  if (!sequence.length) return 0;
  const next = (Math.max(0, Number(stateEntry?.sequencePointers?.[windowKey] || 0) || 0) + 1) % sequence.length;
  stateEntry.sequencePointers[windowKey] = next;
  return next;
}

function trimReplyText(value, maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function classifyDailyShareGenerationFailure(error = null) {
  const message = normalizeReplyText(error?.message || error || '');
  const explicitFailureType = normalizeReplyText(error?.dailyShareFailureType || '');
  const replyFailure = classifyReplyFailure(message);
  const replyFailureType = explicitFailureType || replyFailure.type;
  const isPureToolMarkupBlocked = /tool call markup was returned without executing any tool/i.test(message);
  return {
    message,
    replyFailureType,
    isPureToolMarkupBlocked,
    shouldCooldownWindow: isPureToolMarkupBlocked
      || new Set(['tool_error', 'provider_auth', 'provider_blocked']).has(replyFailureType)
  };
}

function detectQzoneTerminalReplyFailureType(text = '') {
  const message = normalizeReplyText(text);
  if (!message) return '';
  const replyFailure = classifyReplyFailure(message);
  if (replyFailure.type === 'provider_auth' || replyFailure.type === 'provider_blocked') {
    return replyFailure.type;
  }
  if (/^(?:sorry[\s,]+)?i can(?:'|’)t\b/i.test(message)) {
    return 'provider_blocked';
  }
  return '';
}

function createDailyShareAbortError(message = '', failureType = '') {
  const error = new Error(message || failureType || 'daily-share-aborted');
  if (failureType) error.dailyShareFailureType = failureType;
  return error;
}

function getDailyShareFailureCooldownMs(targetConfig = {}, error = null) {
  const configuredMinutes = Math.max(
    1,
    Number(
      targetConfig?.failureCooldownMinutes
      || config.DAILY_SHARE_FAILURE_COOLDOWN_MINUTES
      || 30
    ) || 30
  );
  const baseMs = configuredMinutes * 60 * 1000;
  const message = normalizeReplyText(error?.message || error || '');
  if (/tool call markup was returned without executing any tool/i.test(message)) {
    return Math.max(baseMs, 60 * 60 * 1000);
  }
  return baseMs;
}

function summarizeRecentShares(stateEntry, maxItems = 3) {
  return (Array.isArray(stateEntry?.recentShares) ? stateEntry.recentShares : [])
    .slice(-Math.max(1, Number(maxItems) || 3))
    .map((item) => `${item.type}: ${trimReplyText(item.summary || '', 80)}`)
    .filter(Boolean)
    .join('\n');
}

function safeJsonParse(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

function sanitizeMemoryQueryText(value = '', maxChars = 180) {
  let text = String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[<>`|;&]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';
  const limit = Math.max(32, Number(maxChars) || 180);
  return text.length > limit ? text.slice(0, limit).trim() : text;
}

function stripCodeFences(text = '') {
  return String(text || '')
    .replace(/^```[a-zA-Z0-9_-]*\s*/u, '')
    .replace(/\s*```$/u, '')
    .trim();
}

function extractAssistantText(response) {
  if (typeof response === 'string') return response;
  return String(response?.content || '');
}

function parsePlannerQueryResponse(response) {
  const raw = stripCodeFences(extractAssistantText(response));
  if (!raw) return '';
  const direct = safeJsonParse(raw);
  if (direct && typeof direct.query === 'string') return sanitizeMemoryQueryText(direct.query);
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return '';
  const parsed = safeJsonParse(match[0]);
  if (!parsed || typeof parsed.query !== 'string') return '';
  return sanitizeMemoryQueryText(parsed.query);
}

function buildQzoneDailyShareMemoryFallbackQuery({
  type,
  windowKey,
  topicLabel,
  recentShareSummaries
} = {}) {
  const pieces = [
    'qzone daily share',
    String(type || '').trim().toLowerCase(),
    String(windowKey || '').trim().toLowerCase(),
    trimReplyText(topicLabel || '', 48),
    trimReplyText(recentShareSummaries || '', 72)
  ].filter(Boolean);
  return sanitizeMemoryQueryText(pieces.join(' '), 180) || 'qzone daily share mood';
}

