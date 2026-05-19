function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function listEnabledCategoryNames(store = {}) {
  return Object.values(store.categories || {})
    .filter((category) => category.enabled !== false && Array.isArray(category.assets) && category.assets.length > 0)
    .map((category) => category.name);
}

function listSelectorCategories(store = {}) {
  return Object.values(store.categories || {})
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

function listCategorySummaries(store = {}) {
  return Object.values(store.categories || {})
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

function listCategoryAssets(category = null) {
  if (!category) return [];
  return (Array.isArray(category.assets) ? category.assets : [])
    .slice()
    .sort((left, right) => right.createdAt - left.createdAt)
    .map((asset) => ({ ...asset }));
}

function listAllStoreAssets(store = {}, options = {}) {
  const filterCategory = String(options.categoryName || '').trim();
  const entries = [];
  for (const category of Object.values(store.categories || {})) {
    if (filterCategory && category.name !== filterCategory) continue;
    for (const asset of Array.isArray(category.assets) ? category.assets : []) {
      entries.push({
        categoryName: category.name,
        asset: cloneJson(asset)
      });
    }
  }
  return entries;
}

function listAssetsNeedingAnalysisFromEntries(entries = [], options = {}) {
  const targetVersion = Math.max(1, Number(options.version) || options.defaultVersion || 1);
  const normalizeAssetAnalysisRecord = typeof options.normalizeAssetAnalysisRecord === 'function'
    ? options.normalizeAssetAnalysisRecord
    : (analysis) => analysis || {};

  return entries.filter(({ asset }) => {
    const analysis = normalizeAssetAnalysisRecord(asset.analysis);
    return analysis.status !== 'ready' || analysis.version !== targetVersion;
  });
}

function formatPickedAsset(category, asset, getCategoryAssetPath) {
  if (!category || !asset) return null;
  return {
    ...asset,
    category: category.name,
    absolutePath: getCategoryAssetPath(category.name, asset.fileName)
  };
}

function pickRandomAssetFromCategory(category, options = {}) {
  if (!category || !Array.isArray(category.assets) || category.assets.length === 0) return null;
  const getCategoryAssetPath = typeof options.getCategoryAssetPath === 'function'
    ? options.getCategoryAssetPath
    : () => '';
  const excludeAssetIds = new Set(
    (Array.isArray(options.excludeAssetIds) ? options.excludeAssetIds : [])
      .map((item) => String(item || '').trim())
      .filter(Boolean)
  );
  const filteredAssets = category.assets.filter((asset) => !excludeAssetIds.has(String(asset.id || '').trim()));
  const pool = filteredAssets.length > 0 ? filteredAssets : category.assets;
  const index = Math.floor(Math.random() * pool.length);
  return formatPickedAsset(category, pool[index], getCategoryAssetPath);
}

module.exports = {
  listAllStoreAssets,
  listAssetsNeedingAnalysisFromEntries,
  listCategoryAssets,
  listCategorySummaries,
  listEnabledCategoryNames,
  listSelectorCategories,
  pickRandomAssetFromCategory
};
