const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', 'config', 'group-reply-sensitive-words.json');
const DEFAULT_VENDOR_DIR = path.join(__dirname, '..', 'data', 'sensitive-words', 'vendor', 'sensitive-lexicon', 'Vocabulary');
const DEFAULT_REPLACEMENT_TEXT = '这句我先不发了，换个说法吧。';
const MIN_VENDOR_WORD_LENGTH = 2;
const DEFAULT_POLITICAL_CONTEXT_WORDS = [
  '现实政治',
  '时政',
  '政治',
  '政权',
  '政党',
  '政府',
  '当局',
  '官方',
  '国家主席',
  '总书记',
  '主席',
  '总统',
  '选举',
  '议会',
  '宪政',
  '人权',
  '民主',
  '独裁',
  '专政',
  '革命',
  '中国',
  '中共',
  '共产党',
  '共产主义',
  '大陆',
  '台湾',
  '台海',
  '西藏',
  '新疆',
  '香港',
  '维吾尔',
  '藏人',
  '六四',
  '天安门',
  '法轮功'
];
const DEFAULT_STRONG_POLITICAL_WORDS = [
  '习近平',
  '毛泽东',
  '江泽民',
  '胡锦涛',
  '温家宝',
  '邓小平',
  '朱镕基',
  '李鹏',
  '中共',
  '共产党',
  '共产主义',
  '法轮功',
  '六四',
  '天安门',
  '台湾独立',
  '台独',
  '藏独',
  '疆独',
  '港独'
];
const DEFAULT_FICTION_CONTEXT_WORDS = [
  '角色扮演',
  '角色',
  'rp',
  'oc',
  '设定',
  '剧情',
  '世界观',
  '虚构',
  '架空',
  '台词',
  '扮演',
  '人设',
  '剧本',
  '小说',
  '漫画',
  '游戏',
  '副本',
  '阵营',
  '王国',
  '帝国',
  '魔法',
  '公会',
  'npc'
];

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

function getTextLength(text = '') {
  return Array.from(String(text || '')).length;
}

function includesAnyWord(text = '', words = []) {
  return words.some((word) => word && text.includes(word));
}

function isStrongPoliticalMatch(word = '', strongWords = []) {
  return includesAnyWord(word, strongWords);
}

function isSpecificPoliticalMatch(word = '') {
  return getTextLength(word) >= 3;
}

function hasPoliticalSensitiveContext(normalizedText = '', matchedWords = [], config = {}) {
  const strongWords = config.strongPoliticalWords || DEFAULT_STRONG_POLITICAL_WORDS;
  if (matchedWords.some((word) => isStrongPoliticalMatch(word, strongWords))) return true;

  const fictionWords = config.fictionContextWords || DEFAULT_FICTION_CONTEXT_WORDS;
  if (includesAnyWord(normalizedText, fictionWords)) return false;

  const contextWords = config.politicalContextWords || DEFAULT_POLITICAL_CONTEXT_WORDS;
  return includesAnyWord(normalizedText, contextWords)
    && matchedWords.some((word) => isSpecificPoliticalMatch(word));
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
    politicalContextRequired: raw.politicalContextRequired !== false,
    replacementText: String(raw.replacementText || DEFAULT_REPLACEMENT_TEXT).trim() || DEFAULT_REPLACEMENT_TEXT,
    vendorFiles: Array.isArray(raw.vendorFiles)
      ? raw.vendorFiles.map((item) => String(item || '').trim()).filter(Boolean)
      : [],
    extraWords: uniqueWords(Array.isArray(raw.extraWords) ? raw.extraWords : []),
    allowWords: uniqueWords(Array.isArray(raw.allowWords) ? raw.allowWords : []),
    politicalContextWords: uniqueWords(Array.isArray(raw.politicalContextWords)
      ? raw.politicalContextWords
      : DEFAULT_POLITICAL_CONTEXT_WORDS),
    strongPoliticalWords: uniqueWords(Array.isArray(raw.strongPoliticalWords)
      ? raw.strongPoliticalWords
      : DEFAULT_STRONG_POLITICAL_WORDS),
    fictionContextWords: uniqueWords(Array.isArray(raw.fictionContextWords)
      ? raw.fictionContextWords
      : DEFAULT_FICTION_CONTEXT_WORDS)
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

    const blocked = matchedWords.length > 0 && (
      !config.politicalContextRequired
      || hasPoliticalSensitiveContext(normalizedText, matchedWords, config)
    );

    return {
      blocked,
      matchedWords
    };
  }

  return {
    check,
    enabled: config.enabled,
    politicalContextRequired: config.politicalContextRequired,
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
  hasPoliticalSensitiveContext,
  loadGuardConfig,
  loadVendorWords,
  normalizeText,
  resetGroupReplySensitiveGuardCache
};
