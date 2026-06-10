function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function textFromContent(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return textFromContent(item.text || item.content || item.output_text || item.outputText || '');
    }).join('');
  }
  if (value && typeof value === 'object') {
    return textFromContent(value.text || value.content || value.output_text || value.outputText || '');
  }
  return '';
}

function splitTimestampPrefix(text = '') {
  const normalized = normalizeText(text);
  const match = normalized.match(/^(\[\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}\]\s*)([\s\S]*)$/);
  if (!match) return { prefix: '', body: normalized };
  return { prefix: match[1], body: normalizeText(match[2]) };
}

function parseJsonText(text = '') {
  const raw = normalizeText(text)
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch (_) {}
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(raw.slice(start, end + 1)); } catch (_) {}
  }
  return null;
}

function hasReasoningContentKey(value, depth = 0) {
  if (!value || typeof value !== 'object' || depth > 8) return false;
  if (Array.isArray(value)) return value.some((item) => hasReasoningContentKey(item, depth + 1));
  return Object.entries(value).some(([key, item]) => (
    key === 'reasoning_content'
    || key === 'reasoning'
    || hasReasoningContentKey(item, depth + 1)
  ));
}

function isProviderEnvelope(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const objectType = normalizeText(value.object).toLowerCase();
  const id = normalizeText(value.id).toLowerCase();
  return Array.isArray(value.choices)
    || objectType === 'chat.completion'
    || objectType === 'chat.completion.chunk'
    || id.startsWith('chatcmpl-')
    || hasReasoningContentKey(value);
}

function extractProviderVisibleText(value) {
  if (!value || typeof value !== 'object') return '';
  const choices = Array.isArray(value.choices) ? value.choices : [];
  for (const choice of choices) {
    const text = textFromContent(
      choice?.message?.content
      || choice?.delta?.content
      || choice?.text
      || ''
    );
    if (normalizeText(text)) return text;
  }
  return '';
}

function extractSummaryObjectText(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '';
  return textFromContent(
    value.summary
    || value.short_persist_summary
    || value.shortPersistSummary
    || value.recommended_prompt_context
    || value.recommendedPromptContext
    || value.output_text
    || value.text
    || value.content
    || ''
  );
}

function looksLikeRawProviderText(text = '') {
  return /"object"\s*:\s*"chat\.completion"/i.test(text)
    || /"choices"\s*:\s*\[/i.test(text)
    || /"reasoning_content"\s*:/i.test(text)
    || /\bchatcmpl-[A-Za-z0-9_-]+/i.test(text);
}

function cleanImageMemorySummary(value = '', options = {}) {
  const original = normalizeText(value);
  if (!original) return { summary: '', changed: false, rejected: false, reason: '' };
  const { prefix, body } = splitTimestampPrefix(original);
  const parsed = parseJsonText(body);
  if (parsed && typeof parsed === 'object') {
    if (isProviderEnvelope(parsed)) {
      const visibleText = normalizeText(extractProviderVisibleText(parsed));
      if (!visibleText) {
        return { summary: '', changed: true, rejected: true, reason: 'provider_envelope_without_visible_content' };
      }
      const nested = cleanImageMemorySummary(visibleText, { ...options, preserveTimestampPrefix: false });
      const summary = nested.summary ? `${options.preserveTimestampPrefix === false ? '' : prefix}${nested.summary}`.trim() : '';
      return {
        summary,
        changed: summary !== original,
        rejected: !summary,
        reason: nested.reason || 'provider_envelope_content'
      };
    }
    const summaryObjectText = normalizeText(extractSummaryObjectText(parsed));
    if (summaryObjectText && summaryObjectText !== body) {
      const nested = cleanImageMemorySummary(summaryObjectText, { ...options, preserveTimestampPrefix: false });
      const summary = nested.summary ? `${options.preserveTimestampPrefix === false ? '' : prefix}${nested.summary}`.trim() : '';
      return {
        summary,
        changed: summary !== original,
        rejected: !summary,
        reason: nested.reason || 'summary_object_content'
      };
    }
  }
  if (looksLikeRawProviderText(body)) {
    return { summary: '', changed: true, rejected: true, reason: 'raw_provider_response_text' };
  }
  const summary = prefix && options.preserveTimestampPrefix === false ? body : original;
  return { summary, changed: summary !== original, rejected: false, reason: '' };
}

module.exports = {
  cleanImageMemorySummary,
  looksLikeRawProviderText,
  normalizeText,
  splitTimestampPrefix
};
