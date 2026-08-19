const fs = require('fs');
const path = require('path');

const DEFAULT_STAGE = 'main';
const KNOWN_STAGES = new Set(['main', 'review', 'planner', 'router', 'shared']);
const PROMPT_TIERS = Object.freeze(['core', 'contract', 'persona', 'capability', 'context', 'example']);
const PROMPT_CACHE_SCOPES = Object.freeze(['stable_system', 'dynamic_context', 'assistant_only']);

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeStringArray(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
}

function normalizeStage(value) {
  const stage = normalizeText(value, DEFAULT_STAGE).toLowerCase();
  return KNOWN_STAGES.has(stage) ? stage : DEFAULT_STAGE;
}

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function resolvePromptUserId(context = {}) {
  const routeMeta = isPlainObject(context.routeMeta || context.route_meta)
    ? (context.routeMeta || context.route_meta)
    : {};
  return normalizeText(
    context.userId
    || context.user_id
    || context.senderId
    || context.sender_id
    || routeMeta.userId
    || routeMeta.user_id
    || routeMeta.senderId
    || routeMeta.sender_id
  );
}

function normalizeAdminUserIds(context = {}) {
  const value = context.adminUserIds || context.admin_user_ids || context.ADMIN_USER_IDS;
  if (Array.isArray(value)) return value.map((item) => normalizeText(item)).filter(Boolean);
  return String(value || '').split(',').map((item) => normalizeText(item)).filter(Boolean);
}

function isAdminPromptContext(context = {}) {
  if (context.isAdmin === true || context.admin === true) return true;
  return normalizeText(context.userRole).toLowerCase() === 'admin';
}

function isNormalUserPromptContext(context = {}) {
  if (isAdminPromptContext(context)) return false;
  if (context.isNormalUser === true || normalizeText(context.userRole).toLowerCase() === 'normal') return true;
  const userId = resolvePromptUserId(context);
  const adminUserIds = normalizeAdminUserIds(context);
  return Boolean(userId && adminUserIds.length > 0 && !adminUserIds.includes(userId));
}

function matchesPromptContext(appliesWhen = {}, context = {}) {
  const condition = isPlainObject(appliesWhen) ? appliesWhen : {};
  if ((condition.adminOnly === true || condition.admin_only === true) && !isAdminPromptContext(context)) return false;
  if ((condition.normalUserOnly === true || condition.normal_user_only === true) && !isNormalUserPromptContext(context)) return false;
  const modelPattern = normalizeText(condition.modelPattern || condition.model_pattern);
  if (modelPattern) {
    const modelName = normalizeText(context.modelName || context.model_name || context.model);
    if (!modelName || !modelName.toLowerCase().includes(modelPattern.toLowerCase())) return false;
  }
  return true;
}

function inferPromptTier(block = {}) {
  const id = normalizeText(block.id).toLowerCase();
  const authority = normalizeText(block.authority).toLowerCase();
  const kind = normalizeText(block.kind).toLowerCase();
  const lane = normalizeText(block.lane || block.cacheLane).toLowerCase();
  if (authority === 'system_root' || kind === 'system_root') return 'core';
  if (authority === 'security' || kind === 'security') return 'contract';
  if (authority === 'tool_policy' || kind === 'tool_policy') return 'capability';
  if (id === 'dynamic_few_shot' || lane === 'assistant_only' || kind.includes('example')) return 'example';
  if (authority.includes('persona') || kind.includes('persona')) return 'persona';
  return 'context';
}

function normalizePromptModule(module = {}, index = 0) {
  const id = normalizeText(module.id);
  if (!id) throw new Error(`Prompt module at index ${index} is missing id`);
  const version = normalizeText(module.version);
  if (!version) throw new Error(`Prompt module ${id} is missing version`);
  const stage = normalizeText(module.stage).toLowerCase();
  if (!KNOWN_STAGES.has(stage)) throw new Error(`Unknown prompt stage: ${stage || '(empty)'}`);
  const tier = normalizeText(module.tier).toLowerCase();
  if (!PROMPT_TIERS.includes(tier)) throw new Error(`Unknown prompt tier: ${tier || '(empty)'}`);
  const cacheScope = normalizeText(module.cacheScope || module.cache_scope).toLowerCase();
  if (!PROMPT_CACHE_SCOPES.includes(cacheScope)) {
    throw new Error(`Unknown prompt cache scope: ${cacheScope || '(empty)'}`);
  }
  if (typeof module.enabledWhen !== 'function') throw new Error(`Prompt module ${id} is missing enabledWhen`);
  if (typeof module.render !== 'function') throw new Error(`Prompt module ${id} is missing render`);
  if (!Number.isFinite(Number(module.priority))) throw new Error(`Prompt module ${id} has invalid priority`);
  if (!Number.isFinite(Number(module.maxTokens)) || Number(module.maxTokens) < 0) {
    throw new Error(`Prompt module ${id} has invalid maxTokens`);
  }
  return Object.freeze({
    ...module,
    id,
    version,
    stage,
    tier,
    priority: Number(module.priority),
    maxTokens: Math.max(0, Number(module.maxTokens)),
    cacheScope,
    registrationOrder: index
  });
}

function createPromptRegistry(modules = []) {
  if (!Array.isArray(modules)) throw new Error('Prompt registry modules must be an array');
  const ids = new Set();
  const normalized = modules.map((module, index) => {
    const item = normalizePromptModule(module, index);
    if (ids.has(item.id)) throw new Error(`Duplicate prompt module id: ${item.id}`);
    ids.add(item.id);
    return item;
  });
  const versions = Array.from(new Set(normalized.map((module) => module.version)));
  return Object.freeze({
    version: versions.length === 1 ? versions[0] : versions.join(','),
    modules: Object.freeze(normalized)
  });
}

function createPromptModulesFromBlocks(blocks = [], options = {}) {
  const version = normalizeText(options.version, 'legacy');
  return (Array.isArray(blocks) ? blocks : []).filter(Boolean).map((block, index) => {
    const source = isPlainObject(block) ? { ...block } : {};
    const appliesWhen = isPlainObject(source.appliesWhen || source.applies_when)
      ? { ...(source.appliesWhen || source.applies_when) }
      : {};
    const cacheScope = normalizeText(source.lane || source.cacheLane, 'dynamic_context');
    return {
      ...source,
      id: normalizeText(source.id, `block_${index + 1}`),
      version: normalizeText(source.version, version),
      stage: normalizeText(source.stage, DEFAULT_STAGE).toLowerCase(),
      tier: normalizeText(source.tier, inferPromptTier(source)),
      priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 100 + index,
      maxTokens: Math.max(0, Number(source.maxTokens || source.budgetTokens || source.budget_tokens || 0) || 0),
      cacheScope,
      enabledWhen: (context) => matchesPromptContext(appliesWhen, context),
      render: () => ({ ...source })
    };
  });
}

function normalizeSection(section = {}, index = 0) {
  const relPath = normalizeText(section.path);
  return {
    id: normalizeText(section.id, `section_${index + 1}`),
    path: relPath,
    required: section.required !== false,
    kind: normalizeText(section.kind, 'unknown'),
    includeInSystemPrompt: section.include_in_system_prompt !== false,
    stage: normalizeStage(section.stage),
    priority: Number.isFinite(Number(section.priority)) ? Number(section.priority) : 100 + index,
    budgetTokens: Math.max(0, Number(section.budget_tokens || 0) || 0),
    authority: normalizeText(section.authority, section.kind || 'prompt_asset'),
    appliesWhen: section.applies_when && typeof section.applies_when === 'object'
      ? { ...section.applies_when }
      : {},
    conflictTags: normalizeStringArray(section.conflict_tags),
    requiredVariables: normalizeStringArray(section.required_variables)
  };
}

function readPromptManifestFromFile(manifestPath) {
  const raw = safeReadText(manifestPath, '').trim();
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    throw new Error('[prompt-manifest] Invalid JSON: ' + String(error.message || error));
  }
}

function normalizePromptManifest(manifest = {}) {
  const normalized = manifest && typeof manifest === 'object' ? { ...manifest } : {};
  const systemPrompt = normalized.system_prompt && typeof normalized.system_prompt === 'object'
    ? normalized.system_prompt
    : {};
  const sections = Array.isArray(systemPrompt.sections)
    ? systemPrompt.sections.map((section, index) => normalizeSection(section, index))
    : [];
  return {
    version: Number(normalized.version || 1) || 1,
    system_prompt: {
      preamble: normalizeStringArray(systemPrompt.preamble),
      sections
    },
    validators: normalized.validators && typeof normalized.validators === 'object'
      ? { ...normalized.validators }
      : {}
  };
}

function loadPromptManifest(manifestPath) {
  const parsed = readPromptManifestFromFile(manifestPath);
  return parsed ? normalizePromptManifest(parsed) : null;
}

function resolvePromptAssetPath(promptsDir, relPath = '') {
  return path.join(promptsDir, ...String(relPath || '').split('/').filter(Boolean));
}

function readPromptAsset(promptsDir, relPath = '') {
  const fullPath = resolvePromptAssetPath(promptsDir, relPath);
  return {
    fullPath,
    text: safeReadText(fullPath, '')
  };
}

module.exports = {
  DEFAULT_STAGE,
  KNOWN_STAGES,
  PROMPT_CACHE_SCOPES,
  PROMPT_TIERS,
  createPromptModulesFromBlocks,
  createPromptRegistry,
  inferPromptTier,
  isAdminPromptContext,
  isNormalUserPromptContext,
  loadPromptManifest,
  matchesPromptContext,
  normalizePromptModule,
  normalizePromptManifest,
  normalizeSection,
  readPromptAsset,
  readPromptManifestFromFile,
  resolvePromptAssetPath,
  safeReadText
};
