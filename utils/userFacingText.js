function stripTrailingThinkFragment(text = '') {
  const source = String(text || '');
  const lower = source.toLowerCase();
  const lastOpen = lower.lastIndexOf('<');
  if (lastOpen < 0) return source;

  const fragment = lower.slice(lastOpen);
  if (!fragment) return source;

  const thinkMarkers = [
    '<think>',
    '<think ',
    '</think>',
    '</think '
  ];

  if (thinkMarkers.some((marker) => marker.startsWith(fragment))) {
    return source.slice(0, lastOpen);
  }

  return source;
}

function sanitizeUserFacingText(text = '') {
  let next = String(text || '').replace(/\u200b/g, '');
  let previous = null;

  while (next !== previous) {
    previous = next;
    next = next.replace(/<think\b[^>]*>[\s\S]*?<\/think\s*>/gi, '');
  }

  next = next.replace(/<think\b[^>]*>[\s\S]*$/i, '');
  next = next.replace(/<\/think\s*>/gi, '');
  next = stripTrailingThinkFragment(next);
  return next;
}

function extractUserFacingDelta(previousText = '', currentText = '') {
  const prev = String(previousText || '');
  const next = String(currentText || '');
  if (!next) return '';
  if (!prev) return next;
  if (next === prev) return '';
  if (next.startsWith(prev)) return next.slice(prev.length);
  if (prev.endsWith(next) || prev.includes(next)) return '';

  const maxOverlap = Math.min(prev.length, next.length);
  for (let size = maxOverlap; size > 0; size -= 1) {
    if (prev.slice(-size) === next.slice(0, size)) {
      return next.slice(size);
    }
  }

  return next;
}

function hasVisibleUserFacingText(text = '') {
  return Boolean(sanitizeUserFacingText(text).trim());
}

module.exports = {
  extractUserFacingDelta,
  hasVisibleUserFacingText,
  sanitizeUserFacingText
};
