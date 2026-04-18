const { resolveShortTermSessionKey } = require('../utils/shortTermMemory');

function sanitizeSubagentContextSnippet(text = '') {
  return String(text || '')
    .replace(/\[CQ:[^\]]+\]/g, ' ')
    .replace(/\b(?:group|groupId|user|userId|session|sessionId)\s*[:=]\s*[A-Za-z0-9:_-]+\b/gi, ' ')
    .replace(/\b\d{5,}\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clipSubagentContextSummary(text = '', maxLength = 220) {
  const normalized = sanitizeSubagentContextSnippet(text);
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trim()}...`;
}

function buildDirectedConversationSummary(directedContext = {}, { maxLength = 220 } = {}) {
  const context = directedContext && typeof directedContext === 'object' ? directedContext : {};
  const lines = [];
  if (String(context.scene || '').trim()) lines.push(`Scene: ${String(context.scene || '').trim()}`);
  const addressee = context.addressee && typeof context.addressee === 'object' ? context.addressee : {};
  const addresseeText = String(
    addressee.senderName
    || addressee.userId
    || addressee.kind
    || ''
  ).trim();
  if (addresseeText) lines.push(`Current message to: ${addresseeText}`);
  const quote = context.quote && typeof context.quote === 'object' ? context.quote : null;
  if (quote) {
    const quoteFrom = String(quote.senderName || quote.senderId || '').trim();
    if (String(quote.origin || '').trim()) lines.push(`Quoted origin: ${String(quote.origin || '').trim()}`);
    if (quoteFrom) lines.push(`Quoted message from: ${quoteFrom}`);
    if (quote.hasImage === true) lines.push('Quoted message has image');
    if (String(quote.text || '').trim()) lines.push(`Quoted text: ${String(quote.text || '').trim()}`);
  }
  const quotePriority = context.quotePriority && typeof context.quotePriority === 'object' ? context.quotePriority : null;
  if (quotePriority?.enabled) {
    if (String(quotePriority.mode || '').trim()) lines.push(`Quote priority mode: ${String(quotePriority.mode || '').trim()}`);
    if (String(quotePriority.reason || '').trim()) lines.push(`Quote priority reason: ${String(quotePriority.reason || '').trim()}`);
    if (String(quotePriority.quoteAnchoredText || '').trim()) lines.push(`Quote anchored text: ${String(quotePriority.quoteAnchoredText || '').trim()}`);
  }
  if (context.activePair?.userA && context.activePair?.userB) {
    lines.push(`Active pair: ${context.activePair.userA}<->${context.activePair.userB}`);
  }
  return clipSubagentContextSummary(lines.join('\n'), maxLength);
}

function prefersQuotedImage(cleanText = '') {
  const text = String(cleanText || '').trim();
  if (!text) return false;
  return /(上面那张|引用那张|前面那张|回复那张|那张图|引用图片|上面这张图|前面这张图)/i.test(text);
}

function prefersCurrentImage(cleanText = '') {
  const text = String(cleanText || '').trim();
  if (!text) return false;
  return /(我发的这张|我这张|看我这张|我贴这张|我这图|这张图|这张图片)/i.test(text);
}

function resolveVisualInputFromContinuousMetaCore(continuousMeta = null, directedContext = null, cleanText = '') {
  const meta = continuousMeta && typeof continuousMeta === 'object' ? continuousMeta : null;
  if (!meta) return null;
  const selected = String(meta.selectedImageUrl || '').trim();
  const replyImages = Array.isArray(meta.replyContext?.imageUrls) ? meta.replyContext.imageUrls : [];
  const quotePriority = directedContext?.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
  const quoteWantsQuotedImage = quotePriority?.enabled
    && quotePriority?.quoteFocus?.hasImage === true
    && (
      String(quotePriority.mode || '').trim() === 'anchored_rewrite'
      || prefersQuotedImage(cleanText)
    );
  const currentImageRef = prefersCurrentImage(cleanText);

  if (selected && !quoteWantsQuotedImage) return selected;
  if (selected && currentImageRef) return selected;
  for (const item of replyImages) {
    const url = String(item || '').trim();
    if (url) return url;
  }
  if (selected) return selected;
  return null;
}

function resolveVisualInputFromContinuousMeta(continuousMeta = null) {
  return resolveVisualInputFromContinuousMetaCore(continuousMeta, null, '');
}

function uniqueVisualItems(items = []) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    const url = String(item?.url || '').trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({
      url,
      source: String(item?.source || '').trim() || 'current',
      label: String(item?.label || '').trim()
    });
  }
  return out;
}

function buildVisualImageCollection(continuousMeta = null, directedContext = null, cleanText = '', options = {}) {
  const meta = continuousMeta && typeof continuousMeta === 'object' ? continuousMeta : {};
  const quotePriority = directedContext?.quotePriority && typeof directedContext.quotePriority === 'object'
    ? directedContext.quotePriority
    : null;
  const maxImages = Math.max(1, Math.min(8, Number(options.maxImages || 8) || 8));

  const currentImages = Array.isArray(meta.imageUrls)
    ? meta.imageUrls.map((url, index) => ({
        url: String(url || '').trim(),
        source: 'current',
        label: `current_${index + 1}`
      }))
    : [];
  const replyImages = Array.isArray(meta.replyContext?.imageUrls)
    ? meta.replyContext.imageUrls.map((url, index) => ({
        url: String(url || '').trim(),
        source: 'reply',
        label: `reply_${index + 1}`
      }))
    : [];
  const forwardImages = Array.isArray(meta.forwardImageUrls)
    ? meta.forwardImageUrls.map((url, index) => ({
        url: String(url || '').trim(),
        source: 'forward',
        label: `forward_${index + 1}`
      }))
    : [];

  const quoteWantsReplyFirst = quotePriority?.enabled
    && quotePriority?.quoteFocus?.hasImage === true
    && (
      String(quotePriority.mode || '').trim() === 'anchored_rewrite'
      || prefersQuotedImage(cleanText)
    );

  const ordered = quoteWantsReplyFirst
    ? uniqueVisualItems([...replyImages, ...currentImages, ...forwardImages])
    : uniqueVisualItems([...currentImages, ...replyImages, ...forwardImages]);

  return ordered.slice(0, maxImages);
}

function createMessageVisualContext(deps = {}) {
  const {
    chatHistory
  } = deps;

  function getLastAssistantReplyForSession(senderId = '', groupId = '') {
    const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
    const historyStore = chatHistory || {};
    const history = Array.isArray(historyStore[sessionKey]) ? historyStore[sessionKey] : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      if (String(item?.role || '').trim() === 'assistant' && String(item?.content || '').trim()) {
        return String(item.content || '').trim();
      }
    }
    return '';
  }

  function getLastUserMessageForSession(senderId = '', groupId = '') {
    const sessionKey = resolveShortTermSessionKey(senderId, { groupId });
    const historyStore = chatHistory || {};
    const history = Array.isArray(historyStore[sessionKey]) ? historyStore[sessionKey] : [];
    for (let i = history.length - 1; i >= 0; i -= 1) {
      const item = history[i];
      if (String(item?.role || '').trim() === 'user' && String(item?.content || '').trim()) {
        return String(item.content || '').trim();
      }
    }
    return '';
  }

  function buildSubagentContextSummary(senderId = '', groupId = '', { maxLength = 220, directedContext = null } = {}) {
    const lastUserText = getLastUserMessageForSession(senderId, groupId);
    const lastAssistantReply = getLastAssistantReplyForSession(senderId, groupId);
    const lines = [];
    const directedSummary = buildDirectedConversationSummary(directedContext, { maxLength });
    if (directedSummary) lines.push(directedSummary);
    if (lastUserText) lines.push(`Previous user: ${lastUserText}`);
    if (lastAssistantReply) lines.push(`Previous assistant: ${lastAssistantReply}`);
    return clipSubagentContextSummary(lines.join('\n'), maxLength);
  }

  return {
    buildVisualImageCollection,
    buildSubagentContextSummary,
    getLastAssistantReplyForSession,
    getLastUserMessageForSession
  };
}

module.exports = {
  buildVisualImageCollection,
  buildDirectedConversationSummary,
  clipSubagentContextSummary,
  createMessageVisualContext,
  resolveVisualInputFromContinuousMeta,
  resolveVisualInputFromContinuousMetaCore,
  sanitizeSubagentContextSnippet
};
