const DEFAULT_MIN_STREAM_CHUNK_CHARS = 4;

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

function getStreamingSplitIndex(text = '', options = {}) {
  const input = String(text || '');
  if (!input) return -1;

  if (options.force) return input.length;

  const explicit = findExplicitSegmentBreakIndex(input);
  if (explicit > 0) return explicit;

  const natural = findNaturalSplitIndex(input, options);
  if (natural > 0) return natural;

  return options.force ? input.length : -1;
}

module.exports = {
  findExplicitSegmentBreakIndex,
  findNaturalSplitIndex,
  getStreamingSplitIndex
};
