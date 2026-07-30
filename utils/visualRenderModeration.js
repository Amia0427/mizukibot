const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { createGroupReplySensitiveGuard } = require('./groupReplySensitiveGuard');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'visual-render-sensitive-words.json');
const DEFAULT_VENDOR_DIR = path.join(__dirname, '..', 'data', 'sensitive-words', 'vendor', 'sensitive-lexicon', 'Vocabulary');

let cachedGuard = null;
let cachedConfigPath = '';
let cachedVendorDir = '';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeWord(value = '') {
  return normalizeText(value).toLowerCase();
}

function resolveCategory(fileName = '') {
  const name = String(fileName || '');
  if (/反动|政治/.test(name)) return 'political';
  if (/暴恐/.test(name)) return 'violence_terror';
  if (/色情/.test(name)) return 'sexual';
  if (/涉枪涉爆/.test(name)) return 'weapons_explosives';
  return 'other';
}

function readManifest(configPath, vendorDir) {
  if (!fs.existsSync(configPath)) throw new Error('moderation config missing');
  const manifest = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (manifest.enabled !== true) throw new Error('moderation disabled');
  if (!Array.isArray(manifest.vendorFiles) || manifest.vendorFiles.length === 0) {
    throw new Error('moderation vocabulary missing');
  }

  const vendorRoot = path.resolve(vendorDir);
  const allowWords = new Set((manifest.allowWords || []).map(normalizeWord).filter(Boolean));
  const categoriesByWord = new Map();
  for (const fileName of manifest.vendorFiles) {
    const resolvedPath = path.resolve(vendorRoot, String(fileName || ''));
    if (!resolvedPath.startsWith(`${vendorRoot}${path.sep}`) || !fs.existsSync(resolvedPath)) {
      throw new Error('moderation vocabulary unavailable');
    }
    const category = resolveCategory(fileName);
    const words = fs.readFileSync(resolvedPath, 'utf8')
      .split(/[\r\n,，]+/)
      .map(normalizeWord)
      .filter((word) => word && !allowWords.has(word));
    for (const word of words) {
      const categories = categoriesByWord.get(word) || new Set();
      categories.add(category);
      categoriesByWord.set(word, categories);
    }
  }
  for (const word of (manifest.extraWords || []).map(normalizeWord).filter(Boolean)) {
    if (!allowWords.has(word)) categoriesByWord.set(word, new Set(['custom']));
  }
  return categoriesByWord;
}

function getVisualRenderSensitiveGuard(options = {}) {
  if (options.guard) return options.guard;
  const configPath = options.configPath || process.env.VISUAL_RENDER_SENSITIVE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const vendorDir = options.vendorDir || process.env.GROUP_REPLY_SENSITIVE_VENDOR_DIR || DEFAULT_VENDOR_DIR;
  if (!cachedGuard || cachedConfigPath !== configPath || cachedVendorDir !== vendorDir || options.reload === true) {
    const categoriesByWord = readManifest(configPath, vendorDir);
    const guard = createGroupReplySensitiveGuard({ configPath, vendorDir });
    if (!guard.enabled || guard.wordCount === 0) throw new Error('moderation vocabulary unavailable');
    cachedGuard = {
      ...guard,
      categoriesFor(words = []) {
        const categories = new Set();
        for (const word of words) {
          for (const category of categoriesByWord.get(normalizeWord(word)) || []) categories.add(category);
        }
        return Array.from(categories).sort();
      }
    };
    cachedConfigPath = configPath;
    cachedVendorDir = vendorDir;
  }
  return cachedGuard;
}

function extractVisibleMarkupText(markup = '', renderer = 'html') {
  const source = String(markup || '');
  if (!source) return '';

  if (String(renderer || '').toLowerCase() === 'svg') {
    const $ = cheerio.load(source, { xmlMode: true });
    $('style,script').remove();
    return normalizeText($('text,title,desc').text());
  }

  const $ = cheerio.load(source);
  $('style,script,noscript,template').remove();
  return normalizeText($.root().text());
}

function reviewVisualRenderContent(input = {}, options = {}) {
  const prompt = normalizeText(input.prompt);
  if (!prompt) {
    return {
      allowed: false,
      reason: 'prompt_unavailable',
      stage: 'user_prompt',
      matchedCount: 0,
      categories: ['validation']
    };
  }

  let guard;
  try {
    guard = getVisualRenderSensitiveGuard(options);
  } catch (_) {
    return {
      allowed: false,
      reason: 'moderation_unavailable',
      stage: 'configuration',
      matchedCount: 0,
      categories: ['configuration']
    };
  }

  let promptResult;
  try {
    promptResult = guard.check(prompt);
  } catch (_) {
    return {
      allowed: false,
      reason: 'moderation_unavailable',
      stage: 'user_prompt',
      matchedCount: 0,
      categories: ['moderation']
    };
  }
  if (promptResult.blocked) {
    return {
      allowed: false,
      reason: 'sensitive_content',
      stage: 'user_prompt',
      matchedCount: promptResult.matchedWords.length,
      categories: promptResult.categories || guard.categoriesFor?.(promptResult.matchedWords) || [],
      replacementText: guard.replacementText
    };
  }

  let visibleText;
  try {
    visibleText = extractVisibleMarkupText(input.markup, input.renderer);
  } catch (_) {
    return {
      allowed: false,
      reason: 'markup_parse_failed',
      stage: 'markup',
      matchedCount: 0,
      categories: ['markup']
    };
  }

  let markupResult;
  try {
    markupResult = guard.check(visibleText);
  } catch (_) {
    return {
      allowed: false,
      reason: 'moderation_unavailable',
      stage: 'visible_text',
      matchedCount: 0,
      categories: ['moderation']
    };
  }
  if (markupResult.blocked) {
    return {
      allowed: false,
      reason: 'sensitive_content',
      stage: 'visible_text',
      matchedCount: markupResult.matchedWords.length,
      categories: markupResult.categories || guard.categoriesFor?.(markupResult.matchedWords) || [],
      replacementText: guard.replacementText
    };
  }

  return { allowed: true, reason: '', stage: '', matchedCount: 0, categories: [], visibleText };
}

function resetVisualRenderModerationCache() {
  cachedGuard = null;
  cachedConfigPath = '';
  cachedVendorDir = '';
}

module.exports = {
  DEFAULT_CONFIG_PATH,
  DEFAULT_VENDOR_DIR,
  extractVisibleMarkupText,
  getVisualRenderSensitiveGuard,
  resetVisualRenderModerationCache,
  reviewVisualRenderContent
};
