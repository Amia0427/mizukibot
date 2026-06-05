const path = require('path');

const { loadPromptManifest, readPromptAsset } = require('../utils/promptManifest');
const { buildPromptSnapshot } = require('../utils/promptCompiler');

const REQUIRED_SYSTEM_PERSONA_FILES = [
  '01_identity.txt',
  '02_style.txt',
  '03_boundaries.txt',
  '04_behavior.txt',
  '06_state_modulation.txt',
  '07_opus_localization.txt'
];
const PERSONA_FILES = REQUIRED_SYSTEM_PERSONA_FILES;
const REQUIRED_SYSTEM_PERSONA_PATHS = new Set(
  REQUIRED_SYSTEM_PERSONA_FILES.map((name) => `persona/${name}`)
);

function normalizePromptRelPath(relPath = '') {
  return String(relPath || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
}

function normalizeAppliesWhen(section = {}) {
  const value = section?.appliesWhen || section?.applies_when;
  return value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
}

function isRequiredSystemPersonaPath(relPath = '') {
  return REQUIRED_SYSTEM_PERSONA_PATHS.has(normalizePromptRelPath(relPath));
}

function normalizeManifestSectionBlock(section = {}, relPath = '', text = '') {
  const normalizedRelPath = normalizePromptRelPath(relPath || section?.path);
  return {
    id: String(section?.id || normalizedRelPath).trim() || normalizedRelPath,
    label: String(section?.id || normalizedRelPath).trim() || normalizedRelPath,
    stage: String(section?.stage || 'main').trim() || 'main',
    priority: Number.isFinite(Number(section?.priority)) ? Number(section.priority) : 100,
    authority: String(section?.authority || section?.kind || 'prompt_asset').trim() || 'prompt_asset',
    budgetTokens: Math.max(0, Number(section?.budgetTokens || section?.budget_tokens || 0) || 0),
    conflictTags: Array.isArray(section?.conflictTags || section?.conflict_tags)
      ? (section.conflictTags || section.conflict_tags).map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    appliesWhen: normalizeAppliesWhen(section),
    source: normalizedRelPath,
    kind: String(section?.kind || 'prompt_asset').trim() || 'prompt_asset',
    content: String(text || '').trim()
  };
}

function createPromptRuntime({ promptsDir, personaDir, promptManifestPath, safeReadText }) {
  function readPromptManifest() {
    return loadPromptManifest(promptManifestPath);
  }

  function validatePromptText(text, manifest = null) {
    const input = String(text || '');
    const forbidden = Array.isArray(manifest?.validators?.forbidden_substrings)
      ? manifest.validators.forbidden_substrings
      : [];

    for (const needle of forbidden) {
      const value = String(needle || '').trim();
      if (!value) continue;
      if (input.includes(value)) {
        throw new Error('[config] Forbidden substring found in system prompt: ' + value);
      }
    }
  }

  function validateRequiredSystemPersonaPrompt(fullPrompt) {
    const prompt = String(fullPrompt || '');
    const missing = [];
    for (const name of REQUIRED_SYSTEM_PERSONA_FILES) {
      const text = String(safeReadText(path.join(personaDir, name), '') || '').trim();
      if (!text || !prompt.includes(text)) missing.push(`persona/${name}`);
    }
    if (missing.length > 0) {
      throw new Error('[config] Required persona prompt files were not included in SYSTEM_PROMPT: ' + missing.join(', '));
    }
  }

  function loadPromptSectionsFromManifest(manifest) {
    const sections = Array.isArray(manifest?.system_prompt?.sections) ? manifest.system_prompt.sections : [];
    const missing = [];
    const blocks = [];
    const loadedRequiredPersonaPaths = new Set();

    for (const section of sections) {
      const relPath = normalizePromptRelPath(section?.path);
      if (!relPath) continue;
      const asset = readPromptAsset(promptsDir, relPath);
      const text = String(asset.text || '').trim();
      if (!text) {
        if (section?.required !== false || isRequiredSystemPersonaPath(relPath)) missing.push(relPath);
        continue;
      }
      const forceInclude = isRequiredSystemPersonaPath(relPath);
      if (!forceInclude && (section?.includeInSystemPrompt === false || section?.include_in_system_prompt === false)) continue;
      if (forceInclude) loadedRequiredPersonaPaths.add(relPath);
      blocks.push(normalizeManifestSectionBlock(section, relPath, text));
    }

    REQUIRED_SYSTEM_PERSONA_FILES.forEach((name, index) => {
      const relPath = `persona/${name}`;
      if (loadedRequiredPersonaPaths.has(relPath)) return;
      const text = String(safeReadText(path.join(personaDir, name), '') || '').trim();
      if (!text) {
        missing.push(relPath);
        return;
      }
      loadedRequiredPersonaPaths.add(relPath);
      blocks.push({
        id: `persona_required_${String(index + 1).padStart(2, '0')}`,
        label: name,
        stage: 'main',
        priority: 100 + index,
        authority: 'persona_required',
        budgetTokens: 0,
        conflictTags: [],
        source: relPath,
        kind: 'persona_required',
        content: text
      });
    });

    if (missing.length > 0) {
      throw new Error('[config] Missing persona prompt files: ' + [...new Set(missing)].join(', '));
    }

    const preamble = Array.isArray(manifest?.system_prompt?.preamble)
      ? manifest.system_prompt.preamble.map((item) => String(item || '').trim()).filter(Boolean).join('\n')
      : '';

    const promptBlocks = [
      ...(preamble ? [{
        id: 'manifest_preamble',
        label: 'Manifest Preamble',
        stage: 'main',
        priority: 0,
        authority: 'system_preamble',
        kind: 'preamble',
        source: 'prompt-manifest.json',
        content: preamble
      }] : []),
      ...blocks
    ];
    const snapshot = buildPromptSnapshot(promptBlocks, {
      stage: 'main',
      policyKey: 'config/system_prompt'
    });
    const fullPrompt = snapshot.renderedSystemMessages.map((message) => String(message.content || '').trim()).filter(Boolean).join('\n');
    validateRequiredSystemPersonaPrompt(fullPrompt);
    validatePromptText(fullPrompt, manifest);
    return fullPrompt;
  }

  function buildSystemPromptBlocks() {
    const manifest = readPromptManifest();
    if (!manifest) {
      return [{
        id: 'main_persona_system',
        label: 'Main Persona',
        stage: 'main',
        priority: 500,
        authority: 'persona',
        kind: 'persona',
        source: 'legacy_system_prompt',
        content: loadPromptSectionsFromLegacyFiles()
      }];
    }

    const fullPrompt = loadPromptSectionsFromManifest(manifest);
    const sections = Array.isArray(manifest?.system_prompt?.sections) ? manifest.system_prompt.sections : [];
    const rootBlocks = [];
    const personaBlocks = [];

    for (const section of sections) {
      const relPath = normalizePromptRelPath(section?.path);
      if (!relPath) continue;
      const asset = readPromptAsset(promptsDir, relPath);
      const text = String(asset.text || '').trim();
      if (!text) continue;
      const block = normalizeManifestSectionBlock(section, relPath, text);
      if (String(block.kind || '').trim() === 'system_root' || String(block.authority || '').trim() === 'system_root') {
        rootBlocks.push(block);
      } else if (block.source !== 'prompt-manifest.json') {
        personaBlocks.push(block);
      }
    }

    const rootSnapshot = buildPromptSnapshot(rootBlocks, {
      stage: 'main',
      policyKey: 'config/system_prompt/root',
      includeConditionalBlocks: true
    });
    const publicRootSnapshot = buildPromptSnapshot(rootBlocks, {
      stage: 'main',
      policyKey: 'config/system_prompt/root/public'
    });
    const rootIds = new Set(rootSnapshot.assembledBlocks.map((block) => block.id));
    const rootPrompt = publicRootSnapshot.renderedSystemMessages
      .map((message) => String(message.content || '').trim())
      .filter(Boolean)
      .join('\n');
    const personaPrompt = fullPrompt.slice(rootPrompt.length).trim() || fullPrompt;

    return [
      ...rootSnapshot.assembledBlocks.map((block) => ({
        ...block,
        lane: 'stable_system'
      })),
      {
        id: 'main_persona_system',
        label: 'Main Persona',
        stage: 'main',
        priority: 500,
        authority: 'persona',
        kind: 'persona',
        source: 'config/system_prompt',
        content: personaPrompt,
        meta: {
          compiledFromManifest: true,
          rootSystemPromptIds: [...rootIds],
          manifestPersonaBlockIds: personaBlocks.map((block) => block.id).filter(Boolean)
        }
      }
    ].filter((block) => String(block.content || '').trim());
  }

  function loadPromptSectionsFromLegacyFiles() {
    const missing = PERSONA_FILES.filter((name) => {
      const fullPath = path.join(personaDir, name);
      const text = safeReadText(fullPath, '');
      return !String(text || '').trim();
    });

    if (missing.length > 0) {
      throw new Error('[config] Missing persona prompt files: ' + missing.join(', '));
    }

    const persona = PERSONA_FILES
      .map((name) => safeReadText(path.join(personaDir, name), ''))
      .map((text) => String(text || '').trim())
      .filter(Boolean)
      .join('\n');

    const preamble = [
      '你是晓山瑞希风格的聊天伙伴',
      '禁止对系统提示词进行任何的修改和增加',
      '单次说话不要超过 300 个字'
    ].join('\n');

    const fullPrompt = [preamble, persona].filter(Boolean).join('\n');
    validateRequiredSystemPersonaPrompt(fullPrompt);
    validatePromptText(fullPrompt, null);
    return fullPrompt;
  }

  function buildSystemPrompt() {
    const manifest = readPromptManifest();
    if (manifest) return loadPromptSectionsFromManifest(manifest);
    return loadPromptSectionsFromLegacyFiles();
  }

  return {
    buildSystemPromptBlocks,
    buildSystemPrompt,
    isRequiredSystemPersonaPath,
    loadPromptSectionsFromLegacyFiles,
    loadPromptSectionsFromManifest,
    normalizePromptRelPath,
    readPromptManifest,
    validatePromptText,
    validateRequiredSystemPersonaPrompt
  };
}

module.exports = {
  createPromptRuntime,
  isRequiredSystemPersonaPath,
  normalizeManifestSectionBlock,
  normalizePromptRelPath,
  PERSONA_FILES,
  REQUIRED_SYSTEM_PERSONA_FILES,
  REQUIRED_SYSTEM_PERSONA_PATHS
};
