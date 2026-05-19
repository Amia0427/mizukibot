const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const config = require('../config');
const {
  ALLOWED_ANALYSIS_MOODS,
  ALLOWED_ANALYSIS_STATUSES,
  ALLOWED_EXTENSIONS,
  ALLOWED_INTENSITIES,
  ALLOWED_MOODS,
  CATEGORY_BOOTSTRAP_RULES,
  MEME_CONTEXT_VOCAB,
  createMemeStoreNormalizers
} = require('./memeStore/normalizers');

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

const {
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
} = createMemeStoreNormalizers({
  analysisVersion,
  nowTs
});

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
