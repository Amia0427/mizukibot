const ALLOWED_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);
const ALLOWED_MOODS = new Set(['praise', 'playful', 'confused', 'comfort', 'annoyed']);
const ALLOWED_INTENSITIES = new Set(['low', 'medium', 'high']);
const ALLOWED_ANALYSIS_MOODS = new Set(['praise', 'playful', 'confused', 'comfort', 'annoyed', 'none']);
const ALLOWED_ANALYSIS_STATUSES = new Set(['pending', 'ready', 'failed']);
const MEME_CONTEXT_VOCAB = [
  'praise',
  'playful_banter',
  'confusion_reaction',
  'comfort',
  'annoyance',
  'greeting',
  'celebration',
  'self_mockery',
  'technical_help',
  'formal_status',
  'failure_recovery',
  'apology',
  'serious_sensitive'
];
const MEME_CONTEXT_SET = new Set(MEME_CONTEXT_VOCAB);
const CATEGORY_BOOTSTRAP_RULES = [
  {
    names: ['开心', '夸奖', '可爱'],
    moods: ['praise', 'playful'],
    intensities: ['low', 'medium']
  },
  {
    names: ['装傻', '疑惑'],
    moods: ['confused', 'playful'],
    intensities: ['low', 'medium']
  },
  {
    names: ['伤心', '难过', '悲伤'],
    moods: ['comfort'],
    intensities: ['low', 'medium']
  },
  {
    names: ['嫌弃', '生气'],
    moods: ['annoyed'],
    intensities: ['low', 'medium']
  }
];

function createMemeStoreNormalizers(deps = {}) {
  const {
    analysisVersion,
    nowTs
  } = deps;

  function clampNonNegativeInt(value) {
    return Math.max(0, Math.floor(Number(value) || 0));
  }

  function clampConfidence(value) {
    const num = Number(value);
    if (!Number.isFinite(num)) return 0;
    return Math.max(0, Math.min(1, num));
  }

  function normalizeTextField(value) {
    return String(value || '').trim();
  }

  function uniqueStrings(list = []) {
    const seen = new Set();
    const result = [];
    for (const item of Array.isArray(list) ? list : []) {
      const value = String(item || '').trim();
      if (!value || seen.has(value)) continue;
      seen.add(value);
      result.push(value);
    }
    return result;
  }

  function normalizeFreeStringList(list = []) {
    return uniqueStrings(list)
      .map((item) => String(item || '').trim())
      .filter(Boolean);
  }

  function normalizeAnalysisMood(value, { allowNone = true } = {}) {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) return allowNone ? 'none' : '';
    if (!ALLOWED_ANALYSIS_MOODS.has(normalized)) return allowNone ? 'none' : '';
    if (normalized === 'none' && !allowNone) return '';
    return normalized;
  }

  function normalizeAnalysisMoods(list = [], { allowNone = false } = {}) {
    return uniqueStrings(list)
      .map((item) => normalizeAnalysisMood(item, { allowNone }))
      .filter((item) => item && (allowNone || item !== 'none'));
  }

  function normalizeAnalysisContexts(list = []) {
    return uniqueStrings(list)
      .map((item) => String(item || '').trim().toLowerCase())
      .filter((item) => MEME_CONTEXT_SET.has(item));
  }

  function defaultResolvedAssetAnalysis() {
    return {
      summary: '',
      primaryMood: 'none',
      secondaryMoods: [],
      intensity: 'low',
      confidence: 0,
      expressionTags: [],
      sceneTags: [],
      styleTags: [],
      subjectTags: [],
      textContent: '',
      textTags: [],
      preferredContexts: [],
      avoidContexts: []
    };
  }

  function normalizeAssetAnalysisPayload(payload = {}, options = {}) {
    const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
    const partial = options?.partial === true;
    const output = partial ? {} : defaultResolvedAssetAnalysis();

    if (!partial || Object.prototype.hasOwnProperty.call(source, 'summary')) {
      output.summary = normalizeTextField(source.summary);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'primaryMood')) {
      output.primaryMood = normalizeAnalysisMood(source.primaryMood, { allowNone: true });
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'secondaryMoods')) {
      output.secondaryMoods = normalizeAnalysisMoods(source.secondaryMoods, { allowNone: false });
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'intensity')) {
      const normalizedIntensity = String(source.intensity || '').trim().toLowerCase();
      output.intensity = ALLOWED_INTENSITIES.has(normalizedIntensity) ? normalizedIntensity : 'low';
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'confidence')) {
      output.confidence = clampConfidence(source.confidence);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'textContent')) {
      output.textContent = normalizeTextField(source.textContent);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'expressionTags')) {
      output.expressionTags = normalizeFreeStringList(source.expressionTags);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'sceneTags')) {
      output.sceneTags = normalizeFreeStringList(source.sceneTags);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'styleTags')) {
      output.styleTags = normalizeFreeStringList(source.styleTags);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'subjectTags')) {
      output.subjectTags = normalizeFreeStringList(source.subjectTags);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'textTags')) {
      output.textTags = normalizeFreeStringList(source.textTags);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'preferredContexts')) {
      output.preferredContexts = normalizeAnalysisContexts(source.preferredContexts);
    }
    if (!partial || Object.prototype.hasOwnProperty.call(source, 'avoidContexts')) {
      output.avoidContexts = normalizeAnalysisContexts(source.avoidContexts);
    }

    return output;
  }

  function normalizeAssetAnalysisRecord(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    const normalizedStatus = String(source.status || '').trim().toLowerCase();
    return {
      status: ALLOWED_ANALYSIS_STATUSES.has(normalizedStatus) ? normalizedStatus : 'pending',
      version: Math.max(1, Number(source.version) || analysisVersion()),
      analyzedAt: Math.max(0, Number(source.analyzedAt) || 0),
      model: normalizeTextField(source.model),
      lastError: normalizeTextField(source.lastError),
      auto: normalizeAssetAnalysisPayload(source.auto),
      overrides: normalizeAssetAnalysisPayload(source.overrides, { partial: true })
    };
  }

  function normalizeAssetFeedback(input = {}) {
    const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
    return {
      likes: clampNonNegativeInt(source.likes),
      dislikes: clampNonNegativeInt(source.dislikes),
      skips: clampNonNegativeInt(source.skips),
      blocked: source.blocked === true
    };
  }

  function normalizeAsset(asset = {}) {
    return {
      id: String(asset.id || '').trim(),
      fileName: String(asset.fileName || '').trim(),
      mime: String(asset.mime || '').trim(),
      size: Math.max(0, Number(asset.size) || 0),
      createdAt: Math.max(0, Number(asset.createdAt) || nowTs()),
      analysis: normalizeAssetAnalysisRecord(asset.analysis),
      feedback: normalizeAssetFeedback(asset.feedback)
    };
  }

  function normalizeMoodList(list = []) {
    return uniqueStrings(list)
      .map((item) => item.toLowerCase())
      .filter((item) => ALLOWED_MOODS.has(item));
  }

  function normalizeIntensityList(list = []) {
    return uniqueStrings(list)
      .map((item) => item.toLowerCase())
      .filter((item) => ALLOWED_INTENSITIES.has(item));
  }

  function normalizeKeywordList(list = []) {
    return uniqueStrings(list);
  }

  function findBootstrapMeta(name = '') {
    const categoryName = String(name || '').trim();
    if (!categoryName) return null;
    return CATEGORY_BOOTSTRAP_RULES.find((rule) => rule.names.includes(categoryName)) || null;
  }

  function normalizeCategory(name, category = {}) {
    const assets = Array.isArray(category.assets)
      ? category.assets.map((item) => normalizeAsset(item)).filter((item) => item.id && item.fileName)
      : [];
    const categoryName = String(category.name || name || '').trim();
    const explicitMoods = normalizeMoodList(category.moods);
    const explicitIntensities = normalizeIntensityList(category.intensities);
    const bootstrapMeta = explicitMoods.length ? null : findBootstrapMeta(categoryName);
    const moods = explicitMoods.length ? explicitMoods : normalizeMoodList(bootstrapMeta?.moods || []);
    const intensities = explicitIntensities.length
      ? explicitIntensities
      : normalizeIntensityList(bootstrapMeta?.intensities || []);
    const keywords = normalizeKeywordList(category.keywords);

    return {
      name: categoryName,
      description: String(category.description || '').trim(),
      enabled: category.enabled !== false,
      moods,
      intensities,
      keywords,
      assets
    };
  }

  function normalizeStore(input = {}) {
    const surfaces = input?.surfaces && typeof input.surfaces === 'object' ? input.surfaces : {};
    const categoriesInput = input?.categories && typeof input.categories === 'object' ? input.categories : {};
    const categories = {};

    for (const [key, value] of Object.entries(categoriesInput)) {
      const normalized = normalizeCategory(key, value);
      if (!normalized.name) continue;
      categories[normalized.name] = normalized;
    }

    return {
      enabled: input?.enabled !== false,
      surfaces: {
        direct: surfaces.direct !== false,
        passive: surfaces.passive !== false,
        scheduled: surfaces.scheduled !== false
      },
      categories
    };
  }

  function validateExtension(ext = '') {
    const normalized = String(ext || '').toLowerCase();
    if (!ALLOWED_EXTENSIONS.has(normalized)) {
      throw new Error('Unsupported image type.');
    }
    return normalized;
  }

  return {
    defaultResolvedAssetAnalysis,
    findBootstrapMeta,
    normalizeAsset,
    normalizeAssetAnalysisPayload,
    normalizeAssetAnalysisRecord,
    normalizeAssetFeedback,
    normalizeCategory,
    normalizeIntensityList,
    normalizeKeywordList,
    normalizeMoodList,
    normalizeStore,
    normalizeTextField,
    validateExtension
  };
}

module.exports = {
  ALLOWED_ANALYSIS_MOODS,
  ALLOWED_ANALYSIS_STATUSES,
  ALLOWED_EXTENSIONS,
  ALLOWED_INTENSITIES,
  ALLOWED_MOODS,
  CATEGORY_BOOTSTRAP_RULES,
  MEME_CONTEXT_VOCAB,
  createMemeStoreNormalizers
};
