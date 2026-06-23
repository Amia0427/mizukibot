const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'group-reply-sensitive-words.json');
const DEFAULT_VENDOR_DIR = path.join(__dirname, '..', 'data', 'sensitive-words', 'vendor', 'sensitive-lexicon', 'Vocabulary');
const DEFAULT_REPLACEMENT_TEXT = '这句我先不发了，换个说法吧。';
const MIN_VENDOR_WORD_LENGTH = 2;

let cachedGuard = null;
let cachedConfigPath = '';
let cachedVendorDir = '';

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function normalizeWord(value = '') {
  return normalizeText(value);
}

function readJsonFile(filePath = '') {
  const source = fs.readFileSync(filePath, 'utf8');
  return JSON.parse(source);
}

function listTextFiles(dirPath = '', includedNames = []) {
  if (!dirPath || !fs.existsSync(dirPath)) return [];
  const included = new Set(includedNames.map((name) => String(name || '').trim()).filter(Boolean));
  return fs.readdirSync(dirPath)
    .filter((name) => name.toLowerCase().endsWith('.txt'))
    .filter((name) => included.size === 0 || included.has(name))
    .map((name) => path.join(dirPath, name))
    .sort((a, b) => a.localeCompare(b));
}

function readWordLines(filePath = '') {
  return fs.readFileSync(filePath, 'utf8')
    .split(/[\r\n,，]+/)
    .map((line) => normalizeWord(line))
    .filter(Boolean);
}

function uniqueWords(words = []) {
  return Array.from(new Set(words.map((word) => normalizeWord(word)).filter(Boolean)));
}

function loadVendorWords(vendorDir = DEFAULT_VENDOR_DIR, includedFiles = []) {
  const words = [];
  for (const filePath of listTextFiles(vendorDir, includedFiles)) {
    words.push(...readWordLines(filePath));
  }
  return uniqueWords(words).filter((word) => word.length >= MIN_VENDOR_WORD_LENGTH);
}

function loadGuardConfig(configPath = DEFAULT_CONFIG_PATH) {
  const raw = fs.existsSync(configPath) ? readJsonFile(configPath) : {};
  return {
    enabled: raw.enabled !== false,
    replacementText: String(raw.replacementText || DEFAULT_REPLACEMENT_TEXT).trim() || DEFAULT_REPLACEMENT_TEXT,
    vendorFiles: Array.isArray(raw.vendorFiles)
      ? raw.vendorFiles.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    extraWords: uniqueWords(Array.isArray(raw.extraWords) ? raw.extraWords : []),
    allowWords: uniqueWords(Array.isArray(raw.allowWords) ? raw.allowWords : [])
  };
}

function createGroupReplySensitiveGuard(options = {}) {
  const config = loadGuardConfig(options.configPath || DEFAULT_CONFIG_PATH);
  const vendorWords = loadVendorWords(options.vendorDir || DEFAULT_VENDOR_DIR, config.vendorFiles);
  const allowWords = new Set(config.allowWords);
  const words = uniqueWords([...vendorWords, ...config.extraWords])
    .filter((word) => !allowWords.has(word));

  function check(text = '') {
    const normalizedText = normalizeText(text);
    if (!config.enabled || !normalizedText || words.length === 0) {
      return { blocked: false, matchedWords: [] };
    }

    const matchedWords = [];
    for (const word of words) {
      if (normalizedText.includes(word)) matchedWords.push(word);
    }

    return {
      blocked: matchedWords.length > 0,
      matchedWords
    };
  }

  return {
    check,
    enabled: config.enabled,
    replacementText: config.replacementText,
    wordCount: words.length,
    allowWordCount: allowWords.size
  };
}

function getGroupReplySensitiveGuard(options = {}) {
  const configPath = options.configPath || process.env.GROUP_REPLY_SENSITIVE_CONFIG_PATH || DEFAULT_CONFIG_PATH;
  const vendorDir = options.vendorDir || process.env.GROUP_REPLY_SENSITIVE_VENDOR_DIR || DEFAULT_VENDOR_DIR;
  if (!cachedGuard || cachedConfigPath !== configPath || cachedVendorDir !== vendorDir || options.reload === true) {
    cachedGuard = createGroupReplySensitiveGuard({ configPath, vendorDir });
    cachedConfigPath = configPath;
    cachedVendorDir = vendorDir;
  }
  return cachedGuard;
}

function checkGroupReplySensitiveText(text = '', options = {}) {
  return getGroupReplySensitiveGuard(options).check(text);
}

function resetGroupReplySensitiveGuardCache() {
  cachedGuard = null;
  cachedConfigPath = '';
  cachedVendorDir = '';
}

module.exports = {
  DEFAULT_REPLACEMENT_TEXT,
  checkGroupReplySensitiveText,
  createGroupReplySensitiveGuard,
  getGroupReplySensitiveGuard,
  loadGuardConfig,
  loadVendorWords,
  normalizeText,
  resetGroupReplySensitiveGuardCache
};
