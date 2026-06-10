const config = require('../../config');
const {
  clampNumber,
  hashId,
  nowIso,
  nowMs,
  normalizeArray,
  normalizeEvidenceList,
  normalizeKind,
  normalizePatternKey,
  normalizeShortList,
  normalizeStatus,
  normalizeSummary,
  normalizeSummaryKey,
  parseTime,
  redactSensitiveText,
  trimText
} = require('./normalizers');

const PROMOTED_STATUS = 'promoted';
const GUIDE_ACTIVE_STATUS = 'active';
const SOURCE_PRIORITY = Object.freeze({
  deterministic_tool_error: 1,
  deterministic_correction: 1,
  deterministic_feature_request: 1,
  llm_extraction: 2,
  unknown: 9
});

function getDedupWindowMs() {
  return 24 * 60 * 60 * 1000;
}

function getPromotionWindowMs() {
  const days = Math.max(1, Number(config.SELF_IMPROVEMENT_PROMOTION_WINDOW_DAYS || 30));
  return days * 24 * 60 * 60 * 1000;
}

function getPromotionThreshold() {
  return Math.max(1, Number(config.SELF_IMPROVEMENT_PROMOTION_THRESHOLD || 3));
}

function getGuideMinOccurrences() {
  return Math.max(1, Number(config.SELF_IMPROVEMENT_GUIDE_MIN_OCCURRENCES || 5));
}

function getGuideMinConfidence() {
  return clampNumber(config.SELF_IMPROVEMENT_GUIDE_MIN_CONFIDENCE, 0, 1, 0.85);
}

function createPatternEngine(deps = {}) {
  const normalizeStoredEvent = typeof deps.normalizeStoredEvent === 'function' ? deps.normalizeStoredEvent : (item) => item;
  const normalizePatternRecord = typeof deps.normalizePatternRecord === 'function' ? deps.normalizePatternRecord : (item) => item;
  const normalizeRuleRecord = typeof deps.normalizeRuleRecord === 'function' ? deps.normalizeRuleRecord : (item) => item;
  const normalizeGuideRecord = typeof deps.normalizeGuideRecord === 'function' ? deps.normalizeGuideRecord : (item) => item;

  function selectBetterSource(candidate = {}, current = {}) {
    const candidateRank = SOURCE_PRIORITY[String(candidate.source || '').trim().toLowerCase()] ?? SOURCE_PRIORITY.unknown;
    const currentRank = SOURCE_PRIORITY[String(current.source || '').trim().toLowerCase()] ?? SOURCE_PRIORITY.unknown;
    return candidateRank <= currentRank;
  }

  function getPromotionContextKey(event = {}) {
    const fields = [
      trimText(event.toolName || '', 80),
      trimText(event.routePolicyKey || '', 120),
      trimText(event.taskType || '', 120)
    ].filter(Boolean);
    return fields.join('|');
  }

  function getDedupKey(event = {}) {
    return [
      normalizePatternKey(event.patternKey, 'general.unknown.other'),
      normalizeKind(event.kind),
      trimText(event.toolName || '', 80).toLowerCase(),
      trimText(event.routePolicyKey || '', 120).toLowerCase(),
      normalizeSummaryKey(event.summary)
    ].join('|');
  }

  function mergeEvent(existing = {}, incoming = {}) {
    const mergedEvidence = normalizeEvidenceList([
      ...normalizeArray(existing.evidence),
      ...normalizeArray(incoming.evidence)
    ]);
    const betterSource = selectBetterSource(incoming, existing);
    return normalizeStoredEvent({
      ...existing,
      source: betterSource ? incoming.source : existing.source,
      status: existing.status === PROMOTED_STATUS ? PROMOTED_STATUS : normalizeStatus(incoming.status || existing.status),
      priority: Math.max(Number(existing.priority || 0), Number(incoming.priority || 0)),
      summary: incoming.summary || existing.summary,
      details: incoming.details || existing.details,
      suggestedAction: incoming.suggestedAction || existing.suggestedAction,
      confidence: Math.max(Number(existing.confidence || 0), Number(incoming.confidence || 0)),
      evidence: mergedEvidence,
      updatedAt: nowIso(),
      occurrenceCount: Math.max(1, Number(existing.occurrenceCount || 1) || 1) + 1
    });
  }

  function findDedupMatch(events = [], incoming = {}) {
    const dedupKey = getDedupKey(incoming);
    const cutoff = nowMs() - getDedupWindowMs();
    for (let i = events.length - 1; i >= 0; i -= 1) {
      const item = normalizeStoredEvent(events[i]);
      if (getDedupKey(item) !== dedupKey) continue;
      if (parseTime(item.updatedAt || item.createdAt) < cutoff) continue;
      return i;
    }
    return -1;
  }

  function buildRuntimeRule(entry = {}) {
    const summary = normalizeSummary(entry.summary);
    const action = redactSensitiveText(entry.suggestedAction, 180);
    const kind = normalizeKind(entry.kind);
    const ruleType = kind === 'strategy' ? 'prefer' : 'avoid';

    if (ruleType === 'prefer') {
      return {
        ruleType,
        ruleText: trimText(`Prefer: ${action || summary}`, 280)
      };
    }

    let fallback = summary;
    if (!fallback) {
      if (String(entry.patternKey || '').startsWith('route.')) fallback = 'Check route policy before refusing or claiming no tools are available.';
      else if (String(entry.patternKey || '').startsWith('tool.')) fallback = 'Do not repeat the same tool failure pattern without adjusting inputs or fallback strategy.';
      else if (String(entry.patternKey || '').startsWith('capability.')) fallback = 'Do not claim the capability exists when current route or tool access cannot execute it.';
      else if (String(entry.patternKey || '').startsWith('deploy.')) fallback = 'Do not skip the required safe deployment step for this class of change.';
      else fallback = 'Do not repeat the same failure pattern.';
    }
    return {
      ruleType,
      ruleText: trimText(`Avoid: ${action || fallback}`, 280)
    };
  }

  function buildPatternRecord(windowEvents = []) {
    const list = normalizeArray(windowEvents).map((item) => normalizeStoredEvent(item));
    if (list.length === 0) return null;
    const latest = list[list.length - 1];
    const contexts = new Set();
    for (const event of list) {
      const ctx = getPromotionContextKey(event);
      if (ctx) contexts.add(ctx);
    }
    const distinctContextList = Array.from(contexts).slice(0, 8);
    const totalCount = list.reduce((total, event) => total + Math.max(1, Number(event.occurrenceCount || 1) || 1), 0);
    const promoted = totalCount >= getPromotionThreshold() && distinctContextList.length >= 2;
    const runtimeRule = promoted ? buildRuntimeRule(latest) : { ruleType: latest.kind === 'strategy' ? 'prefer' : 'avoid', ruleText: '' };
    const priority = promoted
      ? Math.max(0.9, ...list.map((event) => Number(event.priority || 0)))
      : Math.max(...list.map((event) => Number(event.priority || 0)));
    return normalizePatternRecord({
      patternKey: latest.patternKey,
      kind: latest.kind,
      status: promoted ? PROMOTED_STATUS : latest.status,
      occurrenceCount: totalCount,
      distinctContexts: distinctContextList,
      summary: latest.summary,
      suggestedAction: latest.suggestedAction,
      injectionText: promoted ? runtimeRule.ruleText : '',
      confidence: list.reduce((max, event) => Math.max(max, Number(event.confidence || 0)), 0),
      topRouteType: latest.topRouteType,
      routePolicyKey: latest.routePolicyKey,
      toolName: latest.toolName,
      taskType: latest.taskType,
      firstSeenAt: list[0].createdAt,
      lastSeenAt: latest.updatedAt,
      taxonomyVersion: config.SELF_IMPROVEMENT_PATTERN_TAXONOMY_VERSION || 3,
      ruleType: runtimeRule.ruleType,
      runtimeRule: runtimeRule.ruleText,
      priority
    });
  }

  function rebuildPromotedRules(patterns = []) {
    const now = nowIso();
    return normalizeArray(patterns)
      .map((item) => normalizePatternRecord(item))
      .filter((item) => item.status === PROMOTED_STATUS)
      .filter((item) => item.learning_allowed !== false)
      .map((item) => {
        const runtimeRule = buildRuntimeRule(item);
        return normalizeRuleRecord({
          ruleId: `sir_${hashId({ patternKey: item.patternKey, ruleText: runtimeRule.ruleText })}`,
          patternKey: item.patternKey,
          kind: item.kind,
          priority: Math.max(Number(item.priority || 0), 0.9),
          ruleType: runtimeRule.ruleType,
          ruleText: runtimeRule.ruleText,
          toolName: item.toolName,
          routePolicyKey: item.routePolicyKey,
          topRouteType: item.topRouteType,
          taskType: item.taskType,
          occurrenceCount: item.occurrenceCount,
          confidence: item.confidence,
          sourcePatternUpdatedAt: item.lastSeenAt,
          updatedAt: now
        });
      })
      .sort((a, b) => parseTime(b.sourcePatternUpdatedAt) - parseTime(a.sourcePatternUpdatedAt));
  }

  function buildGuideExample(pattern = {}) {
    const routeHint = trimText(pattern.routePolicyKey || pattern.topRouteType || pattern.taskType || '', 80);
    const toolHint = trimText(pattern.toolName || '', 80);
    const parts = [routeHint, toolHint, trimText(pattern.summary, 80)].filter(Boolean);
    return trimText(parts.join(' | '), 220);
  }

  function rebuildLocalSkillGuides(patterns = [], rules = []) {
    const now = nowIso();
    const rulesByPattern = new Map(normalizeArray(rules).map((item) => {
      const normalized = normalizeRuleRecord(item);
      return [normalized.patternKey, normalized];
    }));
    return normalizeArray(patterns)
      .map((item) => normalizePatternRecord(item))
      .filter((item) => item.status === PROMOTED_STATUS)
      .filter((item) => item.learning_allowed !== false)
      .filter((item) => item.kind !== 'knowledge_gap')
      .filter((item) => Number(item.occurrenceCount || 0) >= getGuideMinOccurrences())
      .filter((item) => Number(item.confidence || 0) >= getGuideMinConfidence())
      .map((item) => {
        const rule = rulesByPattern.get(item.patternKey);
        if (!rule || !rule.ruleText) return null;
        const doList = rule.ruleType === 'prefer'
          ? [redactSensitiveText(item.suggestedAction || rule.ruleText.replace(/^Prefer:\s*/i, ''), 140)]
          : [redactSensitiveText(item.suggestedAction || 'Use a safer fallback before repeating this pattern.', 140)];
        const dontList = rule.ruleType === 'avoid'
          ? [redactSensitiveText(item.summary || rule.ruleText.replace(/^Avoid:\s*/i, ''), 140)]
          : [];
        return normalizeGuideRecord({
          guideId: `sig_${hashId({ patternKey: item.patternKey, updatedAt: item.lastSeenAt })}`,
          patternKey: item.patternKey,
          kind: item.kind,
          title: `Guide: ${item.patternKey}`,
          summary: item.summary,
          ruleText: rule.ruleText,
          triggerHints: normalizeShortList([item.patternKey, item.routePolicyKey, item.toolName, item.taskType], 4, 120),
          doList,
          dontList,
          example: buildGuideExample(item),
          occurrenceCount: item.occurrenceCount,
          confidence: item.confidence,
          status: GUIDE_ACTIVE_STATUS,
          updatedAt: now
        });
      })
      .filter(Boolean)
      .sort((a, b) => parseTime(b.updatedAt) - parseTime(a.updatedAt));
  }

  function recomputePatterns(events = []) {
    const cutoff = nowMs() - getPromotionWindowMs();
    const bucket = new Map();
    for (const raw of normalizeArray(events)) {
      const event = normalizeStoredEvent(raw);
      if (event.status === 'archived') continue;
      const ts = parseTime(event.updatedAt || event.createdAt);
      if (ts < cutoff) continue;
      const key = `${event.patternKey}|${event.kind}`;
      if (!bucket.has(key)) bucket.set(key, []);
      bucket.get(key).push(event);
    }

    const patterns = [];
    const promotedKeys = new Set();
    for (const [key, list] of bucket.entries()) {
      list.sort((a, b) => parseTime(a.updatedAt) - parseTime(b.updatedAt));
      const pattern = buildPatternRecord(list);
      if (!pattern) continue;
      patterns.push(pattern);
      if (pattern.status === PROMOTED_STATUS) promotedKeys.add(key);
    }

    const normalizedEvents = normalizeArray(events).map((item) => normalizeStoredEvent(item)).map((event) => {
      if (event.status === 'archived') return event;
      const key = `${event.patternKey}|${event.kind}`;
      if (promotedKeys.has(key)) return normalizeStoredEvent({ ...event, status: PROMOTED_STATUS });
      if (event.status === PROMOTED_STATUS) return normalizeStoredEvent({ ...event, status: 'open' });
      return event;
    });

    const sortedPatterns = patterns.sort((a, b) => parseTime(b.lastSeenAt) - parseTime(a.lastSeenAt));
    const promotedRules = rebuildPromotedRules(sortedPatterns);
    const skillGuides = rebuildLocalSkillGuides(sortedPatterns, promotedRules);
    return {
      events: normalizedEvents,
      patterns: sortedPatterns,
      promotedRules,
      skillGuides
    };
  }

  return {
    buildRuntimeRule,
    findDedupMatch,
    mergeEvent,
    rebuildLocalSkillGuides,
    rebuildPromotedRules,
    recomputePatterns
  };
}

module.exports = {
  createPatternEngine
};
