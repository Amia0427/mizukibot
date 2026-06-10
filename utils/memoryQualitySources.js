const { buildMemoryQualityReport } = require('./memoryQuality');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeCall(fn, fallback) {
  try {
    return typeof fn === 'function' ? fn() : fallback;
  } catch (_) {
    return fallback;
  }
}

function worldbookItems(deps = {}) {
  const catalog = safeCall(deps.loadPersonaModuleCatalog || (() => require('./personaModules').loadPersonaModuleCatalog()), { modules: [] });
  const docs = safeCall(() => (deps.buildWorldbookDocuments || require('./personaWorldbookSearch').buildWorldbookDocuments)(catalog), []);
  return normalizeArray(docs).map((doc) => ({
    id: normalizeText(doc.moduleId || doc.id),
    type: 'worldbook',
    memoryKind: 'worldbook',
    sourceKind: 'manual',
    status: 'active',
    confidence: 0.92,
    importance: Number(doc.priority || 1) || 1,
    updatedAt: Number(doc.fileMtimeMs || 0) || 0,
    text: normalizeText([doc.purpose, doc.text].filter(Boolean).join(' '))
  }));
}

function socialContextItems(deps = {}) {
  const store = safeCall(deps.readSocialStore || (() => require('./socialContextRuntime').readStore()), { groups: {}, mergedGraph: {} });
  const groups = Object.entries(store.groups || {}).map(([groupId, group]) => ({
    id: `social:${groupId}`,
    type: 'social_context',
    memoryKind: 'social',
    sourceKind: 'runtime',
    status: 'active',
    confidence: Math.min(1, Math.max(0.3, Number(group?.summary?.sampleCount || 0) / 40)),
    importance: 0.8,
    updatedAt: Number(group?.updatedAt || group?.summary?.updatedAt || 0) || 0,
    groupId,
    text: normalizeText(JSON.stringify(group?.summary || {}))
  }));
  const edgeCount = Object.keys(store.mergedGraph?.edges || {}).length;
  if (edgeCount > 0) {
    groups.push({
      id: 'social:merged-graph',
      type: 'relationship_graph',
      memoryKind: 'social',
      sourceKind: 'runtime',
      status: 'active',
      confidence: Math.min(1, Math.max(0.3, edgeCount / 20)),
      importance: 0.8,
      text: normalizeText(JSON.stringify(store.mergedGraph || {}))
    });
  }
  return groups.filter((item) => item.text);
}

function memeAssetItems(deps = {}) {
  const assets = safeCall(deps.listAllAssets || (() => require('./memeStore').listAllAssets({ includeDisabled: true })), []);
  return normalizeArray(assets).map((asset) => {
    const analysis = asset.analysis && typeof asset.analysis === 'object' ? asset.analysis : {};
    const keywords = normalizeArray(asset.keywords || analysis.keywords).join(' ');
    const moods = normalizeArray(asset.moods || analysis.moods).join(' ');
    return {
      id: normalizeText(asset.id || asset.assetId || asset.fileName),
      type: 'image_asset',
      memoryKind: 'image',
      sourceKind: 'manual',
      status: asset.enabled === false ? 'archived' : 'active',
      confidence: analysis.status === 'ready' ? 0.85 : 0.55,
      importance: 0.6,
      updatedAt: Number(asset.updatedAt || asset.mtimeMs || 0) || 0,
      text: normalizeText([asset.name, asset.description, analysis.caption, keywords, moods].filter(Boolean).join(' '))
    };
  }).filter((item) => item.id || item.text);
}

function notebookItems(deps = {}) {
  const docs = safeCall(deps.listNotebookDocs, []);
  return normalizeArray(docs).map((doc) => ({
    id: normalizeText(doc.id || doc.path || doc.filePath),
    type: 'notebook_doc',
    memoryKind: 'notebook',
    sourceKind: 'manual',
    status: 'active',
    confidence: 0.82,
    importance: 0.7,
    updatedAt: Number(doc.updatedAt || doc.mtimeMs || 0) || 0,
    userId: normalizeText(doc.userId),
    text: normalizeText([doc.title, doc.content, doc.preview].filter(Boolean).join(' '))
  })).filter((item) => item.text);
}

function memoryV3Items(deps = {}) {
  const loadMemoryNodes = deps.loadMemoryNodes || (() => require('./memory-v3/storage').loadMemoryNodes());
  return normalizeArray(safeCall(loadMemoryNodes, []));
}

function buildLongTermMemoryQualityReport(options = {}, deps = {}) {
  const sourceItems = {
    memory_v3: memoryV3Items(deps),
    worldbook: worldbookItems(deps),
    social_context: socialContextItems(deps),
    image_assets: memeAssetItems(deps),
    notebook: notebookItems(deps)
  };
  const bySource = {};
  const all = [];
  for (const [source, items] of Object.entries(sourceItems)) {
    bySource[source] = buildMemoryQualityReport(items, options);
    all.push(...items.map((item) => ({ ...item, sourceKind: item.sourceKind || source })));
  }
  const aggregate = buildMemoryQualityReport(all, options);
  return {
    ok: true,
    ...aggregate,
    aggregate,
    bySource
  };
}

module.exports = {
  buildLongTermMemoryQualityReport,
  memeAssetItems,
  notebookItems,
  socialContextItems,
  worldbookItems
};
