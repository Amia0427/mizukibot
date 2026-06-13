function stripTrailingThinkFragment(text = '', options = {}) {
  const preserveThink = options && typeof options === 'object' && options.preserveThink === true;
  if (preserveThink) return String(text || '');
  const source = String(text || '');
  const lower = source.toLowerCase();
  const lastOpen = lower.lastIndexOf('<');
  if (lastOpen < 0) return source;

  const fragment = lower.slice(lastOpen);
  if (!fragment) return source;

  const thinkMarkers = [
    '<think>',
    '<think ',
    '<thinking>',
    '<thinking ',
    '</think>',
    '</think ',
    '</thinking>',
    '</thinking '
  ];

  if (thinkMarkers.some((marker) => marker.startsWith(fragment))) {
    return source.slice(0, lastOpen);
  }

  return source;
}

const NARRATIVE_LEAD_IN_CUES = [
  '笑着',
  '笑了下',
  '干笑',
  '轻轻',
  '低声',
  '小声',
  '顿了顿',
  '停了停',
  '慢半拍',
  '沉默了下',
  '想了想',
  '想了下',
  '怔了下',
  '抿了抿嘴',
  '偏开视线',
  '别开眼',
  '话题一跳',
  '话锋一转',
  '转开话题',
  '岔开',
  '改口',
  '收住',
  '半句停住',
  '故作轻松'
];

function looksLikeNarrativeLeadIn(prefix = '') {
  const text = String(prefix || '').trim();
  if (!text || text.length > 24) return false;
  if (!/[：:]/.test(`${text}:`)) return false;
  if (/[A-Za-z0-9]/.test(text)) return false;
  if (/[“”"'`]/.test(text)) return false;
  return NARRATIVE_LEAD_IN_CUES.some((cue) => text.includes(cue));
}

function stripNarrativeLeadIn(text = '') {
  return String(text || '')
    .split('\n')
    .map((line) => {
      const colonIndex = line.search(/[：:]/);
      if (colonIndex <= 0) return line;
      const prefix = line.slice(0, colonIndex).trim();
      const suffix = line.slice(colonIndex + 1).trimStart();
      if (!suffix) return line;
      return looksLikeNarrativeLeadIn(prefix) ? suffix : line;
    })
    .join('\n');
}

function stripInternalReasoningLeakText(text = '') {
  let next = String(text || '');

  next = next.replace(/```(?:json|JSON)?\s*\{[\s\S]*?"reasoning_content"\s*:[\s\S]*?\}\s*```/g, '');
  next = next.replace(/^\s*["']?(?:reasoning_content|internal_check|内部检查)["']?\s*[:：=]\s*.*$/gmi, '');
  next = next.replace(/\[(?:RoleplayInnerProtocol|InternalCheck|内部检查)\][\s\S]*?(?=\n{2,}|$)/gi, '');
  next = next.replace(/(?:系统提示词|隐藏提示词|内部规则)\s*(?:如下|全文|原文|内容|是|为|[:：])[\s\S]*?(?=\n{2,}|$)/g, '');

  return next.replace(/^\s*\n+/, '');
}

function sanitizeUserFacingText(text = '', options = {}) {
  const preserveThink = options && typeof options === 'object' && options.preserveThink === true;
  let next = String(text || '').replace(/\u200b/g, '');

  // \u68c0\u6d4b\u5b89\u5168\u9650\u5236\u6807\u8bb0
  const hasSafetyRestriction = /\/%\s*$/.test(next);
  if (hasSafetyRestriction) {
    next = next.replace(/\/%\s*$/, '').trimEnd();
  }

  if (preserveThink) return { text: next, hasSafetyRestriction };
  let previous = null;

  while (next !== previous) {
    previous = next;
    next = next.replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?\s*>/gi, '');
  }

  next = next.replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, '');
  next = next.replace(/<\/think(?:ing)?\s*>/gi, '');
  next = stripTrailingThinkFragment(next, options);
  next = stripInternalReasoningLeakText(next);
  next = stripNarrativeLeadIn(next);

  // \u8fd4\u56de\u5bf9\u8c61\u5f62\u5f0f\uff0c\u5411\u540e\u517c\u5bb9\u5b57\u7b26\u4e32\u7528\u6cd5
  if (options && options.returnMeta) {
    return { text: next, hasSafetyRestriction };
  }
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
  sanitizeUserFacingText,
  stripInternalReasoningLeakText
};
