const { normalizeText } = require('./helpers');

const VALID_PRIVACY_LEVELS = new Set(['public', 'private', 'sensitive']);

function normalizeLower(value = '') {
  return normalizeText(value).toLowerCase();
}

function normalizeCategory(value = '') {
  const category = normalizeLower(value)
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '');
  return category || '';
}

function normalizeTag(value = '') {
  return normalizeLower(value)
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '');
}

function normalizeTags(values = [], limit = 12) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalizeTag(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= Math.max(1, Number(limit) || 1)) break;
  }
  return out;
}

function normalizePrivacyLevel(value = '') {
  const level = normalizeLower(value);
  return VALID_PRIVACY_LEVELS.has(level) ? level : 'private';
}

function normalizeIntent(value = '') {
  const intent = normalizeLower(value)
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_\-\u4e00-\u9fa5]/g, '');
  return intent || '';
}

function deriveCategoryFromFields(input = {}) {
  const source = normalizeLower(input.source);
  const type = normalizeLower(input.type);
  const fieldKey = normalizeLower(input.fieldKey || input.semanticSlot);
  const memoryKind = normalizeLower(input.memoryKind);
  const scopeType = normalizeLower(input.scopeType);

  if (source === 'recent' || scopeType === 'session') return 'continuity';
  if (source === 'journal' || type === 'episode' || memoryKind === 'episode') return 'journal';
  if (source === 'task' || scopeType === 'task' || type === 'goal') return 'task';
  if (source === 'group' || source === 'jargon' || scopeType === 'group' || memoryKind === 'jargon') return 'group_context';
  if (source === 'style' || memoryKind === 'style' || fieldKey.includes('style')) return 'style';
  if (source === 'notebook') return 'notebook';
  if (source === 'profile' || fieldKey.startsWith('persona_') || type.startsWith('persona_')) return 'profile';
  if (fieldKey.includes('preference') || ['like', 'dislike', 'hobby'].includes(type) || ['like', 'dislike'].includes(memoryKind)) return 'preference';
  if (fieldKey.includes('relationship') || type.includes('relationship')) return 'relationship';
  if (['identity', 'personality', 'boundary'].includes(type) || ['identity', 'personality', 'boundary'].includes(fieldKey)) return 'identity';
  return 'personal_fact';
}

function collectTagHints(input = {}, meta = {}, payload = {}) {
  return [
    input.source,
    input.type,
    input.fieldKey,
    input.semanticSlot,
    input.memoryKind,
    input.sourceKind,
    input.rollupLevel,
    ...(Array.isArray(input.tags) ? input.tags : []),
    ...(Array.isArray(meta.tags) ? meta.tags : []),
    ...(Array.isArray(payload.tags) ? payload.tags : []),
    ...(Array.isArray(input.topics) ? input.topics : []),
    ...(Array.isArray(input.entities) ? input.entities : []),
    ...(Array.isArray(input.participants) ? input.participants : [])
  ];
}

function deriveMemoryMetadata(input = {}) {
  const value = input && typeof input === 'object' ? input : {};
  const meta = value.meta && typeof value.meta === 'object' ? value.meta : {};
  const payload = value.payload && typeof value.payload === 'object' ? value.payload : {};
  const openPayload = value.openPayload && typeof value.openPayload === 'object' ? value.openPayload : {};
  const explicitCategory = normalizeCategory(
    value.category
    || meta.category
    || payload.category
    || openPayload.category
    || ''
  );
  let category = explicitCategory || deriveCategoryFromFields(value);
  const source = normalizeLower(value.source);
  if (['recent', 'journal', 'task', 'group', 'jargon', 'style', 'notebook'].includes(source)) {
    const derived = deriveCategoryFromFields(value);
    if (derived !== 'personal_fact') category = derived;
  }
  const tags = normalizeTags(collectTagHints(value, meta, payload));
  const intent = normalizeIntent(
    value.intent
    || meta.intent
    || payload.intent
    || openPayload.intent
    || (value.source === 'notebook' ? 'document_recall' : '')
    || (value.source === 'recent' ? 'recent_context' : '')
    || (value.source === 'journal' ? 'episode_recall' : '')
    || 'memory_recall'
  );
  const privacyLevel = normalizePrivacyLevel(
    value.privacyLevel
    || value.privacy_level
    || meta.privacyLevel
    || meta.privacy_level
    || payload.privacyLevel
    || payload.privacy_level
    || openPayload.privacyLevel
    || openPayload.privacy_level
    || 'private'
  );
  return {
    category,
    tags,
    tagsText: tags.join(' '),
    intent,
    privacyLevel
  };
}

function normalizeFilterList(value = []) {
  if (Array.isArray(value)) return value.map((item) => normalizeCategory(item)).filter(Boolean);
  const single = normalizeCategory(value);
  return single ? [single] : [];
}

function matchesMemoryMetadataFilters(item = {}, options = {}) {
  const metadata = deriveMemoryMetadata(item);
  const categories = normalizeFilterList(options.categories || options.category || options.memoryCategory);
  if (categories.length > 0 && !categories.includes(metadata.category)) return false;

  const wantedTags = normalizeTags(options.tags || options.memoryTags || [], 32);
  if (wantedTags.length > 0) {
    const tagSet = new Set(metadata.tags);
    if (!wantedTags.some((tag) => tagSet.has(tag))) return false;
  }

  const intent = normalizeIntent(options.intentFilter || options.memoryIntent || '');
  if (intent && metadata.intent !== intent) return false;

  const privacyLevel = normalizePrivacyLevel(options.privacyLevel || options.memoryPrivacyLevel || '');
  if ((options.privacyLevel || options.memoryPrivacyLevel) && metadata.privacyLevel !== privacyLevel) return false;
  return true;
}

function normalizeFacetForCategoryBoost(facet = '') {
  const normalized = normalizeLower(facet);
  if (normalized === 'recent_continuity' || normalized === 'default_continuity') return 'continuity';
  if (normalized === 'task_or_plan') return 'task';
  if (normalized === 'group_context') return 'group';
  return normalized || 'default';
}

function categoryFacetBoost(item = {}, facet = 'default') {
  const metadata = deriveMemoryMetadata(item);
  const key = `${normalizeFacetForCategoryBoost(facet)}:${metadata.category}`;
  const table = {
    'preference:preference': 0.14,
    'preference:profile': 0.06,
    'identity:identity': 0.14,
    'identity:profile': 0.1,
    'relationship:relationship': 0.14,
    'relationship:profile': 0.08,
    'continuity:continuity': 0.16,
    'continuity:journal': 0.1,
    'continuity:task': 0.08,
    'task:task': 0.16,
    'journal:journal': 0.18,
    'group:group_context': 0.14,
    'style:style': 0.16
  };
  return Number(table[key] || 0);
}

module.exports = {
  categoryFacetBoost,
  deriveMemoryMetadata,
  matchesMemoryMetadataFilters,
  normalizeCategory,
  normalizeFacetForCategoryBoost,
  normalizeIntent,
  normalizePrivacyLevel,
  normalizeTags
};
