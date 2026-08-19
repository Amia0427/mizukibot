'use strict';

const fs = require('fs');
const path = require('path');

const { mapPromptBlockToMessage } = require('./promptSecurity');

function normalizeText(value) {
  return String(value || '').trim();
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function assertUniqueAssetIds(assets = []) {
  const ids = new Set();
  for (const asset of assets) {
    const id = normalizeText(asset?.id);
    if (!id) throw new Error('Prompt loader asset is missing id');
    if (ids.has(id)) throw new Error(`Duplicate prompt loader asset id: ${id}`);
    ids.add(id);
  }
}

class PromptLoader {
  constructor(options = {}) {
    const promptsDir = path.resolve(process.env.PROMPTS_DIR || path.join(__dirname, '..', 'prompts'));
    this.manifestPath = path.resolve(options.manifestPath || path.join(promptsDir, 'main-reply', 'manifest.json'));
    const manifestDir = path.dirname(this.manifestPath);
    const defaultRoot = path.basename(manifestDir) === 'main-reply'
      ? path.dirname(manifestDir)
      : manifestDir;
    this.promptsRoot = path.resolve(options.promptsRoot || (options.manifestPath ? defaultRoot : promptsDir));
    this.readFileSync = options.readFileSync || fs.readFileSync;
    this.snapshot = null;
  }

  readManifest() {
    let raw;
    try {
      raw = this.readFileSync(this.manifestPath, 'utf8');
    } catch (error) {
      throw new Error(`Unable to read prompt loader manifest: ${String(error.message || error)}`);
    }
    try {
      return JSON.parse(String(raw || ''));
    } catch (error) {
      throw new Error(`Invalid prompt loader manifest JSON: ${String(error.message || error)}`);
    }
  }

  buildLegacySnapshot() {
    const assets = {};
    const legacyAssets = [
      { id: 'few_shot_index', path: '../persona/05_examples.index.json', format: 'json' },
      { id: 'few_shot_intro', path: 'few-shot-intro.txt', format: 'text' }
    ];
    for (const definition of legacyAssets) {
      const filePath = this.resolveAssetPath(definition.path);
      if (!fs.existsSync(filePath)) continue;
      assets[definition.id] = this.readAsset(definition);
    }
    return deepFreeze({
      version: 'legacy',
      manifestPath: this.manifestPath,
      loadedAt: new Date().toISOString(),
      assets
    });
  }

  resolveAssetPath(relPath) {
    const fullPath = path.resolve(path.dirname(this.manifestPath), String(relPath || ''));
    const rootPrefix = `${this.promptsRoot}${path.sep}`;
    if (fullPath !== this.promptsRoot && !fullPath.startsWith(rootPrefix)) {
      throw new Error(`Prompt loader asset escapes prompts root: ${relPath}`);
    }
    return fullPath;
  }

  readAsset(asset) {
    const id = normalizeText(asset?.id);
    const format = normalizeText(asset?.format, 'text').toLowerCase();
    const filePath = this.resolveAssetPath(asset?.path);
    let raw;
    try {
      raw = String(this.readFileSync(filePath, 'utf8'));
    } catch (error) {
      throw new Error(`Unable to read prompt loader asset ${id}: ${String(error.message || error)}`);
    }
    const text = raw.trim();
    if (!text) throw new Error(`Prompt loader asset is empty: ${id}`);
    if (format === 'text') return { id, format, path: filePath, text };
    if (format === 'json') {
      try {
        return { id, format, path: filePath, text, value: JSON.parse(text) };
      } catch (error) {
        throw new Error(`Invalid prompt loader JSON asset ${id}: ${String(error.message || error)}`);
      }
    }
    throw new Error(`Unknown prompt loader asset format: ${format}`);
  }

  buildSnapshot() {
    let manifest;
    try {
      manifest = this.readManifest();
    } catch (error) {
      if (String(error.message || error).includes('ENOENT')) return this.buildLegacySnapshot();
      throw error;
    }
    const version = normalizeText(manifest?.version);
    if (!version) throw new Error('Prompt loader manifest is missing version');
    const definitions = Array.isArray(manifest.assets) ? manifest.assets : [];
    assertUniqueAssetIds(definitions);
    const assets = {};
    for (const definition of definitions) {
      if (normalizeText(definition.format, 'text').toLowerCase() === 'bundle') continue;
      const loaded = this.readAsset(definition);
      assets[loaded.id] = loaded;
    }
    for (const definition of definitions) {
      if (normalizeText(definition.format).toLowerCase() !== 'bundle') continue;
      const id = normalizeText(definition.id);
      const parts = Array.isArray(definition.parts) ? definition.parts : [];
      if (!id || parts.length === 0) throw new Error(`Prompt loader bundle is invalid: ${id || '(empty)'}`);
      const rendered = parts.map((part) => {
        const asset = assets[normalizeText(part.asset)];
        if (!asset) throw new Error(`Prompt loader bundle ${id} references missing asset: ${part.asset}`);
        const authority = normalizeText(part.authority, 'prompt_asset');
        return mapPromptBlockToMessage({ authority, content: asset.text }).content;
      }).filter(Boolean);
      assets[id] = {
        id,
        format: 'bundle',
        text: rendered.join(String(definition.separator || '\n'))
      };
    }
    const snapshot = {
      version,
      manifestPath: this.manifestPath,
      loadedAt: new Date().toISOString(),
      assets
    };
    return deepFreeze(snapshot);
  }

  initialize() {
    if (!this.snapshot) this.snapshot = this.buildSnapshot();
    return this.snapshot;
  }

  getSnapshot() {
    return this.initialize();
  }

  reload() {
    try {
      const next = this.buildSnapshot();
      this.snapshot = next;
      return { ok: true, version: next.version, snapshot: next };
    } catch (error) {
      return {
        ok: false,
        version: this.snapshot?.version || '',
        snapshot: this.snapshot,
        error: String(error.message || error)
      };
    }
  }
}

const defaultLoader = new PromptLoader();

function getPromptSnapshot() {
  return defaultLoader.getSnapshot();
}

function reloadPromptSnapshot() {
  return defaultLoader.reload();
}

module.exports = {
  PromptLoader,
  getPromptSnapshot,
  reloadPromptSnapshot
};
