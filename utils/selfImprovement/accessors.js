const {
  atomicWriteJson,
  ensureStore,
  safeReadJson,
  safeReadText,
  safeWriteText
} = require('./storeFiles');

function createSelfImprovementAccessors(deps = {}) {
  const {
    normalizeArray,
    normalizeGuideRecord,
    normalizePatternRecord,
    normalizeRuleRecord,
    normalizeStoredEvent
  } = deps;

  function readEvents() {
    const paths = ensureStore();
    const raw = safeReadText(paths.eventsFile, '');
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch (_) {
          return null;
        }
      })
      .filter(Boolean)
      .map((item) => normalizeStoredEvent(item));
  }

  function readPatterns() {
    const paths = ensureStore();
    const payload = safeReadJson(paths.patternsFile, { items: [] });
    return {
      items: normalizeArray(payload?.items).map((item) => normalizePatternRecord(item))
    };
  }

  function readPromotedRules() {
    const paths = ensureStore();
    const payload = safeReadJson(paths.rulesFile, { items: [] });
    return {
      items: normalizeArray(payload?.items).map((item) => normalizeRuleRecord(item))
    };
  }

  function readSkillGuides() {
    const paths = ensureStore();
    const payload = safeReadJson(paths.guidesFile, { items: [] });
    return {
      items: normalizeArray(payload?.items).map((item) => normalizeGuideRecord(item))
    };
  }

  function writeEvents(events = []) {
    const paths = ensureStore();
    const body = normalizeArray(events).map((item) => JSON.stringify(normalizeStoredEvent(item))).join('\n');
    safeWriteText(paths.eventsFile, body ? `${body}\n` : '');
  }

  function writePatterns(payload = { items: [] }) {
    const paths = ensureStore();
    atomicWriteJson(paths.patternsFile, {
      items: normalizeArray(payload?.items).map((item) => normalizePatternRecord(item))
    });
  }

  function writePromotedRules(payload = { items: [] }) {
    const paths = ensureStore();
    atomicWriteJson(paths.rulesFile, {
      items: normalizeArray(payload?.items).map((item) => normalizeRuleRecord(item))
    });
  }

  function writeSkillGuides(payload = { items: [] }) {
    const paths = ensureStore();
    atomicWriteJson(paths.guidesFile, {
      items: normalizeArray(payload?.items).map((item) => normalizeGuideRecord(item))
    });
  }

  return {
    readEvents,
    readPatterns,
    readPromotedRules,
    readSkillGuides,
    writeEvents,
    writePatterns,
    writePromotedRules,
    writeSkillGuides
  };
}

module.exports = {
  createSelfImprovementAccessors
};
