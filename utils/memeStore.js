const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');

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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function nowTs() {
  return Date.now();
}

function analysisVersion() {
  return Math.max(1, Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION) || 1);
}

function atomicWriteJson(targetFile, data) {
  const tempFile = `${targetFile}.${process.pid}.tmp`;
  const text = JSON.stringify(data, null, 2);
  try {
    fs.writeFileSync(tempFile, text, 'utf8');
    fs.renameSync(tempFile, targetFile);
  } catch (error) {
    try {
      fs.writeFileSync(targetFile, text, 'utf8');
    } finally {
      try {
        if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
      } catch (_) {}
    }
    if (error?.code !== 'EPERM') throw error;
  }
}

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (error) {
    console.error('[meme-manager] failed to read store json:', {
      filePath,
      error: error?.message || String(error)
    });
    return fallback;
  }
}

function defaultStore() {
  return {
    enabled: true,
    surfaces: {
      direct: true,
      passive: true,
      scheduled: true
    },
    categories: {}
  };
}

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

function getCategoryDir(categoryName) {
  return path.join(config.MEME_MANAGER_ASSET_DIR, categoryName);
}

function getCategoryAssetPath(categoryName, fileName) {
  return path.join(getCategoryDir(categoryName), String(fileName || '').trim());
}

function inferMimeFromExt(fileName = '') {
  const ext = path.extname(String(fileName || '').trim()).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  return 'application/octet-stream';
}

function buildAssetId() {
  return `m_${nowTs()}_${crypto.randomBytes(3).toString('hex')}`;
}

function buildFileName(assetId, ext) {
  return `${assetId}${ext.toLowerCase()}`;
}

let store = defaultStore();

function persist() {
  atomicWriteJson(config.MEME_MANAGER_DATA_FILE, store);
}

function initializeStore() {
  ensureDir(config.DATA_DIR);
  ensureDir(config.MEME_MANAGER_ASSET_DIR);
  const rawStore = safeReadJson(config.MEME_MANAGER_DATA_FILE, defaultStore());
  const normalizedStore = normalizeStore(rawStore);
  store = normalizedStore;
  let changed = JSON.stringify(rawStore || {}) !== JSON.stringify(normalizedStore);

  for (const categoryName of Object.keys(store.categories)) {
    ensureDir(getCategoryDir(categoryName));
    const category = store.categories[categoryName];
    const keptAssets = [];
    for (const asset of category.assets) {
      const assetPath = getCategoryAssetPath(categoryName, asset.fileName);
      if (fs.existsSync(assetPath)) {
        keptAssets.push(asset);
      } else {
        changed = true;
      }
    }
    if (keptAssets.length !== category.assets.length) {
      store.categories[categoryName] = {
        ...category,
        assets: keptAssets
      };
    }
  }

  if (!fs.existsSync(config.MEME_MANAGER_DATA_FILE) || changed) {
    persist();
  }
  return getStore();
}

function getStore() {
  return JSON.parse(JSON.stringify(store));
}

function getEnabledCategoryNames() {
  return Object.values(store.categories)
    .filter((category) => category.enabled !== false && Array.isArray(category.assets) && category.assets.length > 0)
    .map((category) => category.name);
}

function getSelectorCategories() {
  return Object.values(store.categories)
    .filter((category) => category.enabled !== false)
    .map((category) => ({
      name: category.name,
      description: category.description,
      moods: Array.isArray(category.moods) ? [...category.moods] : [],
      intensities: Array.isArray(category.intensities) ? [...category.intensities] : [],
      keywords: Array.isArray(category.keywords) ? [...category.keywords] : [],
      assetCount: Array.isArray(category.assets) ? category.assets.length : 0
    }));
}

function setEnabled(enabled) {
  store.enabled = Boolean(enabled);
  persist();
  return getStore();
}

function addCategory(name, description) {
  const categoryName = String(name || '').trim();
  const desc = String(description || '').trim();
  if (!categoryName) throw new Error('Category name is required.');
  if (!desc) throw new Error('Category description is required.');
  if (store.categories[categoryName]) throw new Error('Category already exists.');

  ensureDir(getCategoryDir(categoryName));
  store.categories[categoryName] = normalizeCategory(categoryName, {
    name: categoryName,
    description: desc,
    enabled: true,
    moods: [],
    intensities: [],
    keywords: [],
    assets: []
  });
  persist();
  return JSON.parse(JSON.stringify(store.categories[categoryName]));
}

function updateCategoryDescription(name, description) {
  const categoryName = String(name || '').trim();
  const desc = String(description || '').trim();
  const category = store.categories[categoryName];
  if (!category) throw new Error('Category not found.');
  if (!desc) throw new Error('Category description is required.');

  store.categories[categoryName] = {
    ...category,
    description: desc
  };
  persist();
  return JSON.parse(JSON.stringify(store.categories[categoryName]));
}

function removeCategory(name) {
  const categoryName = String(name || '').trim();
  const category = store.categories[categoryName];
  if (!category) throw new Error('Category not found.');
  if (Array.isArray(category.assets) && category.assets.length > 0) {
    throw new Error('Category is not empty.');
  }

  delete store.categories[categoryName];
  persist();
  return true;
}

function getCategory(name) {
  const categoryName = String(name || '').trim();
  const category = store.categories[categoryName];
  return category ? JSON.parse(JSON.stringify(category)) : null;
}

function getAsset(categoryName, assetId) {
  const category = store.categories[String(categoryName || '').trim()];
  if (!category) return null;
  const normalizedAssetId = String(assetId || '').trim();
  const asset = Array.isArray(category.assets)
    ? category.assets.find((item) => String(item.id || '').trim() === normalizedAssetId)
    : null;
  return asset ? JSON.parse(JSON.stringify(asset)) : null;
}

function listCategories() {
  return Object.values(store.categories)
    .map((category) => ({
      name: category.name,
      description: category.description,
      enabled: category.enabled !== false,
      moods: Array.isArray(category.moods) ? [...category.moods] : [],
      intensities: Array.isArray(category.intensities) ? [...category.intensities] : [],
      keywords: Array.isArray(category.keywords) ? [...category.keywords] : [],
      assetCount: Array.isArray(category.assets) ? category.assets.length : 0
    }))
    .sort((left, right) => left.name.localeCompare(right.name, 'zh-Hans-CN-u-co-pinyin'));
}

function listCategoryFiles(name) {
  const category = getCategory(name);
  if (!category) throw new Error('Category not found.');
  return category.assets
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((asset) => ({ ...asset }));
}

function validateExtension(ext = '') {
  const normalized = String(ext || '').toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(normalized)) {
    throw new Error('Unsupported image type.');
  }
  return normalized;
}

function importAsset(categoryName, fileBuffer, options = {}) {
  const category = store.categories[String(categoryName || '').trim()];
  if (!category) throw new Error('Category not found.');

  const ext = validateExtension(options.ext || '');
  const buffer = Buffer.isBuffer(fileBuffer) ? fileBuffer : Buffer.from(fileBuffer || '');
  if (!buffer.length) throw new Error('Image content is empty.');

  const assetId = buildAssetId();
  const fileName = buildFileName(assetId, ext);
  const categoryDir = getCategoryDir(category.name);
  ensureDir(categoryDir);
  fs.writeFileSync(path.join(categoryDir, fileName), buffer);

  const asset = normalizeAsset({
    id: assetId,
    fileName,
    mime: String(options.mime || '').trim() || inferMimeFromExt(fileName),
    size: buffer.length,
    createdAt: nowTs(),
    analysis: {
      status: 'pending',
      version: analysisVersion(),
      analyzedAt: 0,
      model: '',
      lastError: '',
      auto: defaultResolvedAssetAnalysis(),
      overrides: {}
    },
    feedback: {
      likes: 0,
      dislikes: 0,
      skips: 0,
      blocked: false
    }
  });

  store.categories[category.name] = {
    ...category,
    assets: [...category.assets, asset]
  };
  persist();
  return JSON.parse(JSON.stringify(asset));
}

function deleteAsset(categoryName, assetId) {
  const category = store.categories[String(categoryName || '').trim()];
  if (!category) throw new Error('Category not found.');

  const normalizedAssetId = String(assetId || '').trim();
  const asset = category.assets.find((item) => item.id === normalizedAssetId);
  if (!asset) throw new Error('Asset not found.');

  const assetPath = getCategoryAssetPath(category.name, asset.fileName);
  try {
    if (fs.existsSync(assetPath)) fs.unlinkSync(assetPath);
  } catch (error) {
    console.warn('[meme-manager] failed to remove asset file:', {
      category: category.name,
      assetId: normalizedAssetId,
      error: error?.message || String(error)
    });
  }

  store.categories[category.name] = {
    ...category,
    assets: category.assets.filter((item) => item.id !== normalizedAssetId)
  };
  persist();
  return true;
}

function updateCategoryMoods(name, moods) {
  const categoryName = String(name || '').trim();
  const category = store.categories[categoryName];
  if (!category) throw new Error('Category not found.');

  const normalized = normalizeMoodList(moods);
  if (!normalized.length) throw new Error('At least one mood is required.');

  store.categories[categoryName] = {
    ...category,
    moods: normalized
  };
  persist();
  return JSON.parse(JSON.stringify(store.categories[categoryName]));
}

function updateCategoryIntensities(name, intensities) {
  const categoryName = String(name || '').trim();
  const category = store.categories[categoryName];
  if (!category) throw new Error('Category not found.');

  store.categories[categoryName] = {
    ...category,
    intensities: normalizeIntensityList(intensities)
  };
  persist();
  return JSON.parse(JSON.stringify(store.categories[categoryName]));
}

function updateCategoryKeywords(name, keywords) {
  const categoryName = String(name || '').trim();
  const category = store.categories[categoryName];
  if (!category) throw new Error('Category not found.');

  store.categories[categoryName] = {
    ...category,
    keywords: normalizeKeywordList(keywords)
  };
  persist();
  return JSON.parse(JSON.stringify(store.categories[categoryName]));
}

function updateAsset(categoryName, assetId, updater) {
  const category = store.categories[String(categoryName || '').trim()];
  if (!category) throw new Error('Category not found.');

  const normalizedAssetId = String(assetId || '').trim();
  const index = Array.isArray(category.assets)
    ? category.assets.findIndex((item) => String(item.id || '').trim() === normalizedAssetId)
    : -1;
  if (index < 0) throw new Error('Asset not found.');

  const currentAsset = category.assets[index];
  const nextAsset = normalizeAsset(updater(JSON.parse(JSON.stringify(currentAsset))) || currentAsset);
  const assets = category.assets.slice();
  assets[index] = nextAsset;
  store.categories[category.name] = {
    ...category,
    assets
  };
  persist();
  return JSON.parse(JSON.stringify(nextAsset));
}

function updateAssetAnalysis(categoryName, assetId, patch = {}) {
  const sourcePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  return updateAsset(categoryName, assetId, (asset) => {
    const currentAnalysis = normalizeAssetAnalysisRecord(asset.analysis);
    return {
      ...asset,
      analysis: normalizeAssetAnalysisRecord({
        ...currentAnalysis,
        status: Object.prototype.hasOwnProperty.call(sourcePatch, 'status')
          ? String(sourcePatch.status || '').trim().toLowerCase()
          : currentAnalysis.status,
        version: Object.prototype.hasOwnProperty.call(sourcePatch, 'version')
          ? Math.max(1, Number(sourcePatch.version) || analysisVersion())
          : currentAnalysis.version,
        analyzedAt: Object.prototype.hasOwnProperty.call(sourcePatch, 'analyzedAt')
          ? Math.max(0, Number(sourcePatch.analyzedAt) || 0)
          : currentAnalysis.analyzedAt,
        model: Object.prototype.hasOwnProperty.call(sourcePatch, 'model')
          ? normalizeTextField(sourcePatch.model)
          : currentAnalysis.model,
        lastError: Object.prototype.hasOwnProperty.call(sourcePatch, 'lastError')
          ? normalizeTextField(sourcePatch.lastError)
          : currentAnalysis.lastError,
        auto: Object.prototype.hasOwnProperty.call(sourcePatch, 'auto')
          ? normalizeAssetAnalysisPayload(sourcePatch.auto)
          : currentAnalysis.auto,
        overrides: Object.prototype.hasOwnProperty.call(sourcePatch, 'overrides')
          ? normalizeAssetAnalysisPayload(sourcePatch.overrides, { partial: true })
          : currentAnalysis.overrides
      })
    };
  });
}

function patchAssetOverrides(categoryName, assetId, patch = {}) {
  const sourcePatch = patch && typeof patch === 'object' && !Array.isArray(patch) ? patch : {};
  return updateAsset(categoryName, assetId, (asset) => {
    const currentAnalysis = normalizeAssetAnalysisRecord(asset.analysis);
    return {
      ...asset,
      analysis: normalizeAssetAnalysisRecord({
        ...currentAnalysis,
        overrides: {
          ...currentAnalysis.overrides,
          ...normalizeAssetAnalysisPayload(sourcePatch, { partial: true })
        }
      })
    };
  });
}

function applyAssetFeedback(categoryName, assetId, action = '') {
  const normalizedAction = String(action || '').trim().toLowerCase();
  if (!['like', 'dislike', 'skip', 'block', 'unblock'].includes(normalizedAction)) {
    throw new Error('Unsupported feedback action.');
  }

  return updateAsset(categoryName, assetId, (asset) => {
    const feedback = normalizeAssetFeedback(asset.feedback);
    if (normalizedAction === 'like') feedback.likes += 1;
    if (normalizedAction === 'dislike') feedback.dislikes += 1;
    if (normalizedAction === 'skip') feedback.skips += 1;
    if (normalizedAction === 'block') feedback.blocked = true;
    if (normalizedAction === 'unblock') feedback.blocked = false;
    return {
      ...asset,
      feedback
    };
  });
}

function listAllAssets(options = {}) {
  const filterCategory = String(options.categoryName || '').trim();
  const entries = [];
  for (const category of Object.values(store.categories)) {
    if (filterCategory && category.name !== filterCategory) continue;
    for (const asset of Array.isArray(category.assets) ? category.assets : []) {
      entries.push({
        categoryName: category.name,
        asset: JSON.parse(JSON.stringify(asset))
      });
    }
  }
  return entries;
}

function listAssetsNeedingAnalysis(options = {}) {
  const targetVersion = Math.max(1, Number(options.version) || analysisVersion());
  return listAllAssets(options).filter(({ asset }) => {
    const analysis = normalizeAssetAnalysisRecord(asset.analysis);
    return analysis.status !== 'ready' || analysis.version !== targetVersion;
  });
}

function getAssetAbsolutePath(categoryName, assetId) {
  const category = store.categories[String(categoryName || '').trim()];
  if (!category) return '';
  const asset = Array.isArray(category.assets)
    ? category.assets.find((item) => String(item.id || '').trim() === String(assetId || '').trim())
    : null;
  if (!asset) return '';
  return getCategoryAssetPath(category.name, asset.fileName);
}

function pickRandomAsset(categoryName) {
  const category = store.categories[String(categoryName || '').trim()];
  if (!category || !Array.isArray(category.assets) || category.assets.length === 0) return null;
  const index = Math.floor(Math.random() * category.assets.length);
  const asset = category.assets[index];
  return {
    ...asset,
    category: category.name,
    absolutePath: getCategoryAssetPath(category.name, asset.fileName)
  };
}

function pickRandomAssetFromSelectedCategory(categoryName, options = {}) {
  if (!categoryName || categoryName === 'none') return null;
  const category = store.categories[String(categoryName || '').trim()];
  if (!category || !Array.isArray(category.assets) || category.assets.length === 0) return null;
  const excludeAssetIds = new Set(
    (Array.isArray(options?.excludeAssetIds) ? options.excludeAssetIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  );
  const filteredAssets = category.assets.filter((asset) => !excludeAssetIds.has(String(asset.id || '').trim()));
  const pool = filteredAssets.length > 0 ? filteredAssets : category.assets;
  const index = Math.floor(Math.random() * pool.length);
  const asset = pool[index];
  return {
    ...asset,
    category: category.name,
    absolutePath: getCategoryAssetPath(category.name, asset.fileName)
  };
}

module.exports = {
  ALLOWED_EXTENSIONS,
  ALLOWED_ANALYSIS_MOODS,
  ALLOWED_ANALYSIS_STATUSES,
  ALLOWED_INTENSITIES,
  ALLOWED_MOODS,
  addCategory,
  applyAssetFeedback,
  CATEGORY_BOOTSTRAP_RULES,
  defaultStore,
  defaultResolvedAssetAnalysis,
  deleteAsset,
  findBootstrapMeta,
  getAsset,
  getAssetAbsolutePath,
  getCategory,
  getEnabledCategoryNames,
  getSelectorCategories,
  getStore,
  importAsset,
  inferMimeFromExt,
  initializeStore,
  listAllAssets,
  listAssetsNeedingAnalysis,
  listCategories,
  listCategoryFiles,
  MEME_CONTEXT_VOCAB,
  normalizeAssetAnalysisPayload,
  normalizeAssetAnalysisRecord,
  normalizeAssetFeedback,
  normalizeIntensityList,
  normalizeKeywordList,
  normalizeMoodList,
  patchAssetOverrides,
  pickRandomAsset,
  pickRandomAssetFromSelectedCategory,
  removeCategory,
  setEnabled,
  updateAssetAnalysis,
  updateCategoryDescription,
  updateCategoryIntensities,
  updateCategoryKeywords,
  updateCategoryMoods
};
