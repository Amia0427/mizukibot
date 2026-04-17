const fs = require('fs');
const path = require('path');

const DEFAULT_STAGE = 'main';
const KNOWN_STAGES = new Set(['main', 'review', 'planner', 'router', 'shared']);

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
  loadPromptManifest,
  normalizePromptManifest,
  normalizeSection,
  readPromptAsset,
  readPromptManifestFromFile,
  resolvePromptAssetPath,
  safeReadText
};
