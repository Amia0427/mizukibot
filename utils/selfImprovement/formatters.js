function createSelfImprovementFormatters(deps = {}) {
  const {
    buildRuntimeRule,
    normalizeArray
  } = deps;

  function formatEventsAsText(items = []) {
    const list = normalizeArray(items);
    if (list.length === 0) return 'No self-improvement events found.';
    return list.map((item, index) => {
      const status = item.status === 'promoted' ? 'promoted' : item.status;
      const meta = [item.kind, status, item.patternKey].filter(Boolean).join(' | ');
      const detail = [item.summary, item.suggestedAction ? `action: ${item.suggestedAction}` : ''].filter(Boolean).join(' | ');
      return `${index + 1}. [${meta}] ${detail}`;
    }).join('\n');
  }

  function formatPatternsAsText(items = []) {
    const list = normalizeArray(items);
    if (list.length === 0) return 'No self-improvement patterns found.';
    return list.map((item, index) => {
      const prefix = `${index + 1}. [${item.kind} | ${item.status} | count:${item.occurrenceCount}]`;
      const body = [item.patternKey, item.summary, item.runtimeRule || item.injectionText].filter(Boolean).join(' | ');
      return `${prefix} ${body}`.trim();
    }).join('\n');
  }

  function formatRulesAsText(items = []) {
    const list = normalizeArray(items);
    if (list.length === 0) return 'No self-improvement rules found.';
    return list.map((item, index) => {
      const meta = [item.kind, item.ruleType, `count:${item.occurrenceCount}`, item.patternKey].filter(Boolean).join(' | ');
      return `${index + 1}. [${meta}] ${item.ruleText}`;
    }).join('\n');
  }

  function formatGuidesAsText(items = []) {
    const list = normalizeArray(items);
    if (list.length === 0) return 'No self-improvement guides found.';
    return list.map((item, index) => {
      const hints = normalizeArray(item.triggerHints).join(', ');
      const dos = normalizeArray(item.doList).join(' | ');
      const donts = normalizeArray(item.dontList).join(' | ');
      return [
        `${index + 1}. [${item.kind} | ${item.patternKey}] ${item.title}`,
        item.summary ? `summary: ${item.summary}` : '',
        item.ruleText ? `rule: ${item.ruleText}` : '',
        hints ? `triggers: ${hints}` : '',
        dos ? `do: ${dos}` : '',
        donts ? `avoid: ${donts}` : '',
        item.example ? `example: ${item.example}` : ''
      ].filter(Boolean).join('\n');
    }).join('\n\n');
  }

  function splitRuntimeRuleText(text = '') {
    if (/^Prefer:/i.test(text)) {
      return { type: 'prefer', text: text.replace(/^Prefer:\s*/i, '') };
    }
    return { type: 'avoid', text: text.replace(/^Avoid:\s*/i, '') };
  }

  function collectPromptRuleLines(candidates = [], options = {}) {
    const trimText = typeof options.trimText === 'function'
      ? options.trimText
      : (text, max) => String(text || '').slice(0, max);
    const prefer = [];
    const avoid = [];
    for (const item of candidates) {
      const text = trimText(item.ruleText || item.runtimeRule || item.injectionText || buildRuntimeRule(item).ruleText, 220);
      if (!text) continue;
      const split = splitRuntimeRuleText(text);
      if (split.type === 'prefer') prefer.push(split.text);
      else avoid.push(split.text);
    }
    return { prefer, avoid };
  }

  return {
    collectPromptRuleLines,
    formatEventsAsText,
    formatGuidesAsText,
    formatPatternsAsText,
    formatRulesAsText,
    splitRuntimeRuleText
  };
}

module.exports = {
  createSelfImprovementFormatters
};
