const DEFAULT_MIN_STREAM_CHUNK_CHARS = 4;
const DEFAULT_GROUP_CHAT_SINGLE_MESSAGE_CHARS = 72;
const DEFAULT_GROUP_CHAT_FIRST_MIN_CHARS = 20;
const DEFAULT_GROUP_CHAT_FIRST_MAX_CHARS = 88;
const DEFAULT_GROUP_CHAT_FOLLOWUP_MIN_CHARS = 36;
const DEFAULT_GROUP_CHAT_FOLLOWUP_MAX_CHARS = 150;

function findExplicitSegmentBreakIndex(text = '') {
  const input = String(text || '');
  if (!input) return -1;

  const matches = [...input.matchAll(/\r\n\r\n|\n\n/g)];
  for (const match of matches) {
    const index = Number(match.index);
    const end = index + match[0].length;
    if (isSafeStreamingSplitIndex(input, end)) return end;
  }
  return -1;
}

function getLineStartBefore(text = '', index = 0) {
  return Math.max(String(text || '').lastIndexOf('\n', Math.max(0, index - 1)) + 1, 0);
}

function getLineTextBeforeIndex(text = '', index = 0) {
  const input = String(text || '');
  return input.slice(getLineStartBefore(input, index), Math.max(0, index));
}

function isInsideFencedCodeBlock(text = '', index = 0) {
  const before = String(text || '').slice(0, Math.max(0, index));
  const fenceMatches = before.match(/(^|\n)\s*```/g);
  return Boolean(fenceMatches && fenceMatches.length % 2 === 1);
}

function isMarkdownStructuralLine(line = '') {
  return /^\s*(?:[-*+]\s+|\d+[.)]\s+|>\s*| {4,}|\t)/.test(String(line || ''));
}

function isSafeStreamingSplitIndex(text = '', index = 0) {
  const input = String(text || '');
  const splitIndex = Math.max(0, Math.min(input.length, Number(index) || 0));
  if (splitIndex <= 0 || splitIndex > input.length) return false;
  if (isInsideFencedCodeBlock(input, splitIndex)) return false;
  return true;
}

function isSafeNaturalSplitIndex(text = '', index = 0) {
  if (!isSafeStreamingSplitIndex(text, index)) return false;
  const line = getLineTextBeforeIndex(text, index);
  if (isMarkdownStructuralLine(line)) return false;
  return true;
}

function findNaturalSplitIndex(text = '', options = {}) {
  const input = String(text || '');
  if (!input) return -1;

  const minSegmentChars = Math.max(1, Number(options.minSegmentChars) || DEFAULT_MIN_STREAM_CHUNK_CHARS);
  const trimmedEnd = input.trimEnd().length;
  const strongStops = new Set(['\n', '.', '。', '!', '！', '?', '？', ';', '；', '~', '～', '…']);
  for (let i = 0; i < trimmedEnd; i += 1) {
    if (!strongStops.has(input[i])) continue;
    const splitIndex = i + 1;
    if (splitIndex >= trimmedEnd) continue;
    if (splitIndex < minSegmentChars) continue;
    if (!input.slice(splitIndex).trim()) continue;
    if (isSafeNaturalSplitIndex(input, splitIndex)) return splitIndex;
  }

  if (trimmedEnd >= 24) {
    const weakStops = new Set([',', '，', '、', ':', '：']);
    for (let i = 0; i < trimmedEnd; i += 1) {
      if (!weakStops.has(input[i])) continue;
      const splitIndex = i + 1;
      if (splitIndex >= trimmedEnd) continue;
      if (splitIndex < Math.max(24, minSegmentChars)) continue;
      if (!input.slice(splitIndex).trim()) continue;
      if (isSafeNaturalSplitIndex(input, splitIndex)) return splitIndex;
    }
  }

  return -1;
}

function normalizeChatType(options = {}) {
  return String(
    options.chatType
    || options.chat_type
    || options.channel
    || options.routeMeta?.chatType
    || options.routeMeta?.chat_type
    || ''
  ).trim().toLowerCase();
}

function isGroupChatStream(options = {}) {
  const chatType = normalizeChatType(options);
  if (chatType === 'group') return true;
  if (options.isGroup === true || options.isQqGroup === true) return true;
  return Boolean(options.groupId || options.group_id || options.routeMeta?.groupId || options.routeMeta?.group_id);
}

function clampNumber(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function collectSafeSplitCandidates(text = '', stops = new Set(), options = {}) {
  const input = String(text || '');
  const minChars = Math.max(1, Number(options.minChars) || 1);
  const maxChars = Math.max(minChars, Number(options.maxChars) || input.length);
  const trimmedEnd = input.trimEnd().length;
  const candidates = [];

  for (let i = 0; i < trimmedEnd; i += 1) {
    if (!stops.has(input[i])) continue;
    const splitIndex = i + 1;
    if (splitIndex >= trimmedEnd) continue;
    if (splitIndex < minChars || splitIndex > maxChars) continue;
    if (!input.slice(splitIndex).trim()) continue;
    if (isSafeNaturalSplitIndex(input, splitIndex)) candidates.push(splitIndex);
  }

  return candidates;
}

function findGroupChatSplitIndex(text = '', options = {}) {
  const input = String(text || '');
  if (!input) return -1;

  const trimmedEnd = input.trimEnd().length;
  if (!trimmedEnd) return -1;

  const singleMessageChars = clampNumber(
    options.singleMessageChars,
    DEFAULT_GROUP_CHAT_SINGLE_MESSAGE_CHARS,
    24,
    180
  );
  if (trimmedEnd <= singleMessageChars) return -1;

  const sentSegments = Math.max(0, Number(options.sentSegments || options.segmentIndex || 0) || 0);
  const isFirstSegment = sentSegments <= 0;
  const minChars = clampNumber(
    isFirstSegment ? options.firstMinChars : options.followupMinChars,
    isFirstSegment ? DEFAULT_GROUP_CHAT_FIRST_MIN_CHARS : DEFAULT_GROUP_CHAT_FOLLOWUP_MIN_CHARS,
    8,
    120
  );
  const softMaxChars = clampNumber(
    isFirstSegment ? options.firstMaxChars : options.followupMaxChars,
    isFirstSegment ? DEFAULT_GROUP_CHAT_FIRST_MAX_CHARS : DEFAULT_GROUP_CHAT_FOLLOWUP_MAX_CHARS,
    minChars + 8,
    260
  );
  const hardMaxChars = Math.max(
    softMaxChars,
    clampNumber(options.hardMaxChars, isFirstSegment ? 112 : 190, softMaxChars, 320)
  );

  const explicit = findExplicitSegmentBreakIndex(input);
  if (explicit >= minChars && explicit <= hardMaxChars) return explicit;

  const strongStops = new Set(['\n', '.', '。', '!', '！', '?', '？', ';', '；', '~', '～', '…']);
  const strongWithinSoftMax = collectSafeSplitCandidates(input, strongStops, {
    minChars,
    maxChars: softMaxChars
  });
  if (strongWithinSoftMax.length) return strongWithinSoftMax[0];

  const strongWithinHardMax = collectSafeSplitCandidates(input, strongStops, {
    minChars,
    maxChars: hardMaxChars
  });
  if (strongWithinHardMax.length) return strongWithinHardMax[strongWithinHardMax.length - 1];

  if (trimmedEnd >= softMaxChars) {
    const weakStops = new Set([',', '，', '、', ':', '：']);
    const weakWithinHardMax = collectSafeSplitCandidates(input, weakStops, {
      minChars: Math.max(minChars, isFirstSegment ? 20 : Math.floor(softMaxChars * 0.55)),
      maxChars: hardMaxChars
    });
    if (weakWithinHardMax.length) return weakWithinHardMax[weakWithinHardMax.length - 1];
  }

  return -1;
}

function getStreamingSplitIndex(text = '', options = {}) {
  const input = String(text || '');
  if (!input) return -1;

  if (isGroupChatStream(options)) {
    const groupSplit = findGroupChatSplitIndex(input, options);
    if (groupSplit > 0) return groupSplit;
    return options.force ? input.length : -1;
  }

  if (options.force) return input.length;

  const explicit = findExplicitSegmentBreakIndex(input);
  if (explicit > 0) return explicit;

  const natural = findNaturalSplitIndex(input, options);
  if (natural > 0) return natural;

  return options.force ? input.length : -1;
}

function stableJitter(input = '', max = 1) {
  const limit = Math.max(1, Number(max) || 1);
  let hash = 0;
  const text = String(input || '');
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
  }
  return hash % limit;
}

function getGroupChatStreamSendGapMs(chunk = '', options = {}) {
  if (!isGroupChatStream(options)) return -1;
  const text = String(chunk || '').trim();
  const length = text.length;
  const base = length <= 24
    ? 680
    : length <= 80
      ? 980
      : length <= 150
        ? 1380
        : 1820;
  const jitter = stableJitter(`${options.chunkIndex || options.sentSegments || 0}:${text}`, 520);
  return Math.max(160, base + jitter);
}

module.exports = {
  findExplicitSegmentBreakIndex,
  findGroupChatSplitIndex,
  findNaturalSplitIndex,
  getGroupChatStreamSendGapMs,
  getStreamingSplitIndex
};
