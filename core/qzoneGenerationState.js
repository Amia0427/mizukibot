const fs = require('fs');
const path = require('path');
const config = require('../config');

const HISTORY_LIMIT = Math.max(1, Number(config.QZONE_HISTORY_LIMIT || 40) || 40);
const LOOKBACK = Math.max(1, Number(config.QZONE_VARIATION_LOOKBACK || 8) || 8);
const RECENT_STRONG_LOOKBACK = 5;
const RECENT_TYPE_LOOKBACK = 2;
const DEFAULT_SIMILARITY_THRESHOLD = Number.isFinite(Number(config.QZONE_SIMILARITY_THRESHOLD))
  ? Math.max(0, Math.min(1, Number(config.QZONE_SIMILARITY_THRESHOLD)))
  : 0.72;
const MAX_RETRIES = Math.max(1, Number(config.QZONE_GENERATION_MAX_RETRIES || 4) || 4);
const QZONE_TASK_MODEL_CONFIG = Object.freeze({
  temperature: 0.85,
  top_p: 0.95
});
const QZONE_RETRY_MODEL_CONFIG = Object.freeze({
  temperature: 0.95,
  top_p: 0.98
});
const LENS_VALUES = Object.freeze([
  'state',
  'scene',
  'object',
  'action',
  'self_talk',
  'aftertaste',
  'light_recommendation',
  'contradiction'
]);
const EMOTION_VALUES = Object.freeze([
  'sleepy',
  'restless',
  'aloof',
  'soft',
  'playful',
  'irritated',
  'blank',
  'stubborn_care'
]);
const ANCHOR_VALUES = Object.freeze([
  'weather',
  'light',
  'desk',
  'screen',
  'drink',
  'food',
  'commute',
  'music',
  'bed',
  'window',
  'body_signal',
  'small_object'
]);
const STRUCTURE_VALUES = Object.freeze([
  'one_breath',
  'short_then_turn',
  'turn_then_drop',
  'fragment_mix',
  'two_step',
  'murmur_close'
]);
const ENDING_VALUES = Object.freeze([
  'hanging',
  'self_mock',
  'tiny_wish',
  'cold_turn',
  'soft_close',
  'casual_recommend'
]);
const TOPIC_LIBRARY = Object.freeze({
  media: [
    { key: 'media-book', label: '书', hint: '最近翻到的书页、书名或读书情绪' },
    { key: 'media-movie', label: '电影', hint: '最近想重看或回味的电影感受' },
    { key: 'media-anime', label: '动画', hint: '最近想看或想到的动画片段' },
    { key: 'media-series', label: '剧', hint: '最近惦记的剧集节奏或角色气味' },
    { key: 'media-podcast', label: '播客', hint: '最近戴耳机时想到的播客片段' },
    { key: 'media-game', label: '游戏', hint: '最近想打开或还没通关的游戏心情' },
    { key: 'media-playlist', label: '歌单', hint: '最近循环的歌单或某种声音氛围' }
  ],
  daily: [
    { key: 'daily-sleep', label: '睡眠', hint: '困意、赖床、没睡够、补觉感' },
    { key: 'daily-commute', label: '通勤', hint: '路上、出门前、回程、移动中的情绪' },
    { key: 'daily-eat', label: '吃喝', hint: '饮料、夜宵、零食、嘴巴想要的东西' },
    { key: 'daily-desk', label: '桌面', hint: '桌上杂物、屏幕边角、手边小动作' },
    { key: 'daily-room', label: '房间', hint: '房间里光线、空气、角落、床边' },
    { key: 'daily-weather', label: '天气', hint: '风、雨、温度、潮气、晴光' },
    { key: 'daily-morning', label: '清晨', hint: '刚醒、洗漱、出门前的状态' },
    { key: 'daily-night', label: '深夜', hint: '夜深、困倦、收工、睡前空档' }
  ],
  sensory: [
    { key: 'sensory-light', label: '光线', hint: '灯光、窗光、屏幕光、阴影' },
    { key: 'sensory-temperature', label: '温度', hint: '热、冷、闷、发凉、回温' },
    { key: 'sensory-sound', label: '声音', hint: '耳机里、窗外、房间里的细碎声音' },
    { key: 'sensory-smell', label: '气味', hint: '空气、杯子、衣服、雨味或甜味' },
    { key: 'sensory-clothes', label: '衣物', hint: '袖口、外套、衣料、领口触感' },
    { key: 'sensory-body', label: '身体感觉', hint: '肩颈、眼睛、手指、困意、乏力' }
  ],
  mindset: [
    { key: 'mindset-stubborn-care', label: '嘴硬关心', hint: '嘴上别扭，心里还是在意' },
    { key: 'mindset-irritated', label: '小烦躁', hint: '轻微不耐烦、嫌麻烦、想翻白眼' },
    { key: 'mindset-loose', label: '松弛', hint: '放空、发呆、慢下来一点' },
    { key: 'mindset-empty', label: '空落', hint: '轻微空心感、散掉、没着没落' },
    { key: 'mindset-hide', label: '想躲', hint: '想缩回去、不想社交、想安静' },
    { key: 'mindset-clingy', label: '想黏', hint: '想靠近一点、想被接住一点' },
    { key: 'mindset-lazy', label: '想偷懒', hint: '拖延、赖着、不想动、想摆烂一下' }
  ]
});
const LENS_HINTS = Object.freeze({
  state: '以“我现在是什么状态”为主轴，不要绕太多。',
  scene: '先写眼前场景，再自然落回我的情绪。',
  object: '从一个小东西或手边物件切进去。',
  action: '从一个细小动作开始，不要讲大道理。',
  self_talk: '像我在心里嘀咕两句，别像对别人讲话。',
  aftertaste: '写余韵、后劲、 lingering 的感受。',
  light_recommendation: '可以带一点顺手安利，但仍然以我自己的状态为主。',
  contradiction: '允许一点别扭、嘴硬、前后反差。'
});
const EMOTION_HINTS = Object.freeze({
  sleepy: '带一点困意、迟钝感，但不要卖惨。',
  restless: '有一点坐不住、心里毛糙的感觉。',
  aloof: '语气偏冷一点，但不要真冷漠。',
  soft: '轻一点、软一点，像放低了刺。',
  playful: '可以有一点灵动和小调皮，但别过头。',
  irritated: '轻微烦躁就够了，不要攻击性。',
  blank: '有一点发空、发呆、散神。',
  stubborn_care: '嘴硬、别扭，但能让人感觉到我其实在意。'
});
const ANCHOR_HINTS = Object.freeze({
  weather: '把天气当成意象，不要写成天气预报。',
  light: '写灯光、窗光、阴影或屏幕光。',
  desk: '围绕桌面、键盘、纸张、手边杂物。',
  screen: '围绕屏幕、消息框、播放器、电子光。',
  drink: '围绕咖啡、奶茶、水杯、温度。',
  food: '围绕嘴馋、夜宵、零食、饭点错位感。',
  commute: '围绕路上、出门、回程、移动中的体感。',
  music: '围绕耳机、歌单、某种声音氛围。',
  bed: '围绕床、枕头、被子、睡前或赖床。',
  window: '围绕窗边、风、雨痕、城市远光。',
  body_signal: '围绕眼睛、肩颈、手指、呼吸、困意。',
  small_object: '选一个很小的生活物件当引子。'
});
const STRUCTURE_HINTS = Object.freeze({
  one_breath: '一口气写完，连贯、不切分太明显。',
  short_then_turn: '前半句轻一点，后半句转一下。',
  turn_then_drop: '先拐一下，再轻轻落地收尾。',
  fragment_mix: '允许碎片感，但整体仍要自然。',
  two_step: '像两步走，先看见，再感受到。',
  murmur_close: '像自言自语，尾巴轻轻收。'
});
const ENDING_HINTS = Object.freeze({
  hanging: '结尾留一点没说完的感觉。',
  self_mock: '结尾带一点自嘲或轻轻翻白眼。',
  tiny_wish: '结尾带一个很小的愿望或心愿。',
  cold_turn: '结尾冷一下，但别戳人。',
  soft_close: '结尾柔一点，像把刺收回来。',
  casual_recommend: '如果合适，结尾顺手带一句轻安利。'
});
const GENERIC_QZONE_GUESS_PATTERNS = Object.freeze({
  mentionTheme: /(书|电影|动画|剧|播客|游戏|歌|歌单|奶茶|咖啡|夜宵|通勤|桌面|房间|天气|清晨|深夜|睡不着|困|emo|烦|发呆|治愈|悬疑)/i,
  mentionLength: /(短一点|简短|几十字|80字|100字|长一点|详细一点|两句|一段)/i,
  mentionTone: /(口语|自然|冷一点|温柔|可爱|emo|丧|阴阳怪气|嘴硬|别扭|日记|状态|说说)/i
});

function safeReadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf-8');
    if (!raw || !raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(filePath, data) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tempPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    try {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');
    } finally {
      try {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      } catch (_) {}
    }
    if (error && error.code !== 'EPERM') throw error;
  }
}

function normalizeText(value = '', maxChars = 120) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
}

function normalizeBodyText(text = '') {
  return String(text || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeForCompare(text = '') {
  return normalizeBodyText(text)
    .toLowerCase()
    .replace(/[“”"'`‘’]/g, '')
    .replace(/[，。！？!?,、:：;；【】\[\]()（）<>《》\-—_]/g, '')
    .replace(/\s+/g, '');
}

function stableHash(seed = '') {
  const text = String(seed || '');
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function createSeededRandom(seed = '') {
  let state = stableHash(seed) || 1;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function uniqueBy(list = [], selector = (item) => item) {
  const seen = new Set();
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(selector(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function pickFromPool(list = [], blocked = new Set(), random = Math.random) {
  const normalized = Array.isArray(list) ? list.filter(Boolean) : [];
  const preferred = normalized.filter((item) => !blocked.has(String(item).trim().toLowerCase()));
  const pool = preferred.length ? preferred : normalized;
  if (!pool.length) return '';
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return String(pool[index] || '').trim();
}

function pickObjectFromPool(list = [], blockedKeys = new Set(), random = Math.random) {
  const normalized = Array.isArray(list) ? list.filter(Boolean) : [];
  const preferred = normalized.filter((item) => !blockedKeys.has(String(item?.key || '').trim().toLowerCase()));
  const pool = preferred.length ? preferred : normalized;
  if (!pool.length) return null;
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] || null;
}

function normalizeHistoryEntry(item = {}) {
  return {
    source: normalizeText(item?.source || '', 40).toLowerCase(),
    fingerprint: normalizeText(item?.fingerprint || '', 240).toLowerCase(),
    opening: normalizeText(item?.opening || '', 40).toLowerCase(),
    topicKey: normalizeText(item?.topicKey || '', 80).toLowerCase(),
    topicGroup: normalizeText(item?.topicGroup || '', 80).toLowerCase(),
    lens: normalizeText(item?.lens || '', 32).toLowerCase(),
    emotion: normalizeText(item?.emotion || '', 32).toLowerCase(),
    anchor: normalizeText(item?.anchor || '', 32).toLowerCase(),
    structure: normalizeText(item?.structure || '', 32).toLowerCase(),
    ending: normalizeText(item?.ending || '', 32).toLowerCase(),
    type: normalizeText(item?.type || '', 32).toLowerCase(),
    ngrams: Array.isArray(item?.ngrams)
      ? uniqueBy(
        item.ngrams
          .map((ngram) => normalizeText(ngram || '', 24).toLowerCase())
          .filter(Boolean),
        (ngram) => ngram
      ).slice(0, 64)
      : [],
    at: Math.max(0, Number(item?.at || 0) || 0)
  };
}

function normalizeHistoryPayload(payload = {}) {
  const rawItems = Array.isArray(payload?.items) ? payload.items : [];
  return {
    items: rawItems
      .map((item) => normalizeHistoryEntry(item))
      .filter((item) => item.at && item.source && item.fingerprint)
      .slice(-HISTORY_LIMIT)
  };
}

function loadQzoneGenerationHistory() {
  return normalizeHistoryPayload(safeReadJson(config.QZONE_GENERATION_HISTORY_FILE, { items: [] }));
}

function saveQzoneGenerationHistory(payload = {}) {
  const normalized = normalizeHistoryPayload(payload);
  atomicWriteJson(config.QZONE_GENERATION_HISTORY_FILE, normalized);
  return normalized;
}

function getRecentQzoneHistory(limit = LOOKBACK) {
  const payload = loadQzoneGenerationHistory();
  const maxItems = Math.max(1, Number(limit) || LOOKBACK);
  return payload.items.slice(-maxItems);
}

function getRecentQzoneHistoryByWindow(limit = RECENT_STRONG_LOOKBACK) {
  return getRecentQzoneHistory(limit);
}

function toNgrams(text = '', size = 3) {
  const normalized = normalizeForCompare(text);
  if (!normalized) return [];
  if (normalized.length <= size) return [normalized];
  const grams = [];
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.push(normalized.slice(index, index + size));
  }
  return uniqueBy(grams, (item) => item);
}

function normalizeDailyShareFingerprint(text = '') {
  return normalizeForCompare(text);
}

function extractOpening(text = '', maxChars = 12) {
  const normalized = normalizeForCompare(text);
  if (!normalized) return '';
  return normalized.slice(0, Math.max(4, Number(maxChars) || 12));
}

function getRecentBlockedValues(history = [], field, limit = LOOKBACK) {
  return new Set(
    (Array.isArray(history) ? history : [])
      .slice(-Math.max(1, Number(limit) || LOOKBACK))
      .map((item) => normalizeText(item?.[field] || '', 80).toLowerCase())
      .filter(Boolean)
  );
}

function sampleVariationProfile(context = {}) {
  const recentHistory = Array.isArray(context.recentHistory) ? context.recentHistory : getRecentQzoneHistory();
  const seed = [
    context.surface || 'qzone',
    context.source || 'unknown',
    context.type || '',
    context.windowKey || '',
    context.groupId || '',
    context.today || '',
    String(context.attempt || 0),
    String(context.now || Date.now()),
    recentHistory.slice(-3).map((item) => item.fingerprint || '').join('|')
  ].join('|');
  const random = createSeededRandom(seed);
  const profile = {
    lens: pickFromPool(LENS_VALUES, getRecentBlockedValues(recentHistory, 'lens'), random),
    emotion: pickFromPool(EMOTION_VALUES, getRecentBlockedValues(recentHistory, 'emotion'), random),
    anchor: pickFromPool(ANCHOR_VALUES, getRecentBlockedValues(recentHistory, 'anchor'), random),
    structure: pickFromPool(STRUCTURE_VALUES, getRecentBlockedValues(recentHistory, 'structure'), random),
    ending: pickFromPool(ENDING_VALUES, getRecentBlockedValues(recentHistory, 'ending'), random)
  };
  return profile;
}

function buildVariationProfilePrompt(profile = {}) {
  const lines = ['[本次写法槽位]'];
  if (profile.lens) lines.push(`切入角度: ${profile.lens} / ${LENS_HINTS[profile.lens] || ''}`.trim());
  if (profile.emotion) lines.push(`情绪底色: ${profile.emotion} / ${EMOTION_HINTS[profile.emotion] || ''}`.trim());
  if (profile.anchor) lines.push(`意象锚点: ${profile.anchor} / ${ANCHOR_HINTS[profile.anchor] || ''}`.trim());
  if (profile.structure) lines.push(`句式结构: ${profile.structure} / ${STRUCTURE_HINTS[profile.structure] || ''}`.trim());
  if (profile.ending) lines.push(`收尾方式: ${profile.ending} / ${ENDING_HINTS[profile.ending] || ''}`.trim());
  return lines.join('\n');
}

function buildVariationConstraintPrompt(input = {}) {
  const recentHistory = Array.isArray(input.recentHistory) ? input.recentHistory : getRecentQzoneHistory();
  const blockedOpenings = uniqueBy(
    recentHistory.slice(-RECENT_STRONG_LOOKBACK).map((item) => normalizeText(item?.opening || '', 20)).filter(Boolean),
    (item) => item
  );
  const blockedAnchors = uniqueBy(
    recentHistory.slice(-RECENT_STRONG_LOOKBACK).map((item) => normalizeText(item?.anchor || '', 24)).filter(Boolean),
    (item) => item
  );
  const blockedStructures = uniqueBy(
    recentHistory.slice(-RECENT_STRONG_LOOKBACK).map((item) => normalizeText(item?.structure || '', 24)).filter(Boolean),
    (item) => item
  );
  const blockedEndings = uniqueBy(
    recentHistory.slice(-RECENT_STRONG_LOOKBACK).map((item) => normalizeText(item?.ending || '', 24)).filter(Boolean),
    (item) => item
  );
  const blockedTopics = uniqueBy(
    recentHistory
      .slice(-RECENT_STRONG_LOOKBACK)
      .map((item) => normalizeText(item?.topicKey || '', 48))
      .filter(Boolean),
    (item) => item
  );
  return [
    '[最近禁用模式]',
    `不要重复这些开头: ${blockedOpenings.join(' / ') || '无'}`,
    `不要重复这些意象: ${blockedAnchors.join(' / ') || '无'}`,
    `不要重复这些句式: ${blockedStructures.join(' / ') || '无'}`,
    `不要重复这些收尾: ${blockedEndings.join(' / ') || '无'}`,
    `不要重复这些最近方向: ${blockedTopics.join(' / ') || '无'}`
  ].join('\n');
}

function chooseQzoneTypeByWeight(sequence = [], recentHistory = [], seed = '') {
  const normalized = (Array.isArray(sequence) ? sequence : [])
    .map((item) => normalizeText(item || '', 32).toLowerCase())
    .filter(Boolean);
  if (!normalized.length) return null;
  const recentTypes = recentHistory
    .slice(-RECENT_TYPE_LOOKBACK)
    .map((item) => normalizeText(item?.type || '', 32).toLowerCase())
    .filter(Boolean);
  const blocked = new Set(recentTypes);
  const preferred = normalized.filter((item) => !blocked.has(item));
  const pool = preferred.length ? preferred : normalized;
  const random = createSeededRandom(`${seed}|${pool.join(',')}`);
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] || null;
}

function getTopicLibraryBySurface(surface = 'qzone') {
  if (String(surface || '').trim().toLowerCase() !== 'qzone') {
    return { media: (TOPIC_LIBRARY.media || []).slice() };
  }
  return TOPIC_LIBRARY;
}

function chooseQzoneTopic({ now = Date.now(), recentHistory = [], surface = 'qzone', seed = '' } = {}) {
  const topicLibrary = getTopicLibraryBySurface(surface);
  const groups = Object.keys(topicLibrary);
  const normalizedRecent = Array.isArray(recentHistory) ? recentHistory : [];
  const recentGroupBlock = new Set(
    normalizedRecent.slice(-3).map((item) => normalizeText(item?.topicGroup || '', 32).toLowerCase()).filter(Boolean)
  );
  const cutoff7 = Math.max(0, Number(now || Date.now()) - (7 * 24 * 60 * 60 * 1000));
  const cutoff60 = Math.max(0, Number(now || Date.now()) - (60 * 24 * 60 * 60 * 1000));
  const blocked7 = new Set(
    normalizedRecent
      .filter((item) => Math.max(0, Number(item?.at || 0) || 0) >= cutoff7)
      .map((item) => normalizeText(item?.topicKey || '', 80).toLowerCase())
      .filter(Boolean)
  );
  const blocked60 = new Set(
    normalizedRecent
      .filter((item) => Math.max(0, Number(item?.at || 0) || 0) >= cutoff60)
      .map((item) => normalizeText(item?.topicKey || '', 80).toLowerCase())
      .filter(Boolean)
  );
  const availableGroups = groups.filter((group) => !recentGroupBlock.has(group));
  const preferredGroups = availableGroups.length ? availableGroups : groups;
  const random = createSeededRandom(`${seed}|topic-group`);
  const pickedGroup = pickFromPool(preferredGroups, new Set(), random);
  const items = Array.isArray(topicLibrary[pickedGroup]) ? topicLibrary[pickedGroup] : [];
  const strictPool = items.filter((item) => !blocked60.has(String(item?.key || '').trim().toLowerCase()));
  const relaxedPool = items.filter((item) => !blocked7.has(String(item?.key || '').trim().toLowerCase()));
  const chosen = pickObjectFromPool(strictPool.length ? strictPool : relaxedPool, new Set(), createSeededRandom(`${seed}|topic-item`));
  if (!chosen) return { topic: null, topicGroup: pickedGroup || '', relaxed: !strictPool.length };
  return {
    topic: {
      key: normalizeText(chosen.key || '', 80).toLowerCase(),
      label: normalizeText(chosen.label || '', 48),
      hint: normalizeText(chosen.hint || '', 120),
      group: pickedGroup
    },
    topicGroup: pickedGroup,
    relaxed: !strictPool.length
  };
}

function getModelConfigForQzoneAttempt(reason = '') {
  const normalized = normalizeText(reason || '', 48).toLowerCase();
  if (normalized === 'similarity' || normalized === 'duplicate') {
    return { ...QZONE_RETRY_MODEL_CONFIG };
  }
  return { ...QZONE_TASK_MODEL_CONFIG };
}

function buildHistoryEntryFromContent(input = {}) {
  const text = normalizeBodyText(input.text);
  const fingerprint = normalizeText(input.fingerprint || normalizeDailyShareFingerprint(text), 240).toLowerCase();
  return normalizeHistoryEntry({
    source: input.source || 'unknown',
    fingerprint,
    opening: extractOpening(text),
    topicKey: input.topicKey || '',
    topicGroup: input.topicGroup || '',
    lens: input.variationProfile?.lens || input.lens || '',
    emotion: input.variationProfile?.emotion || input.emotion || '',
    anchor: input.variationProfile?.anchor || input.anchor || '',
    structure: input.variationProfile?.structure || input.structure || '',
    ending: input.variationProfile?.ending || input.variationProfile?.ending || input.ending || '',
    type: input.type || '',
    ngrams: toNgrams(text),
    at: Math.max(0, Number(input.at || Date.now()) || 0)
  });
}

function recordQzoneGenerationHistory(input = {}) {
  const payload = loadQzoneGenerationHistory();
  const entry = buildHistoryEntryFromContent(input);
  if (!entry.source || !entry.fingerprint || !entry.at) return payload;
  const next = normalizeHistoryPayload({
    items: [...payload.items, entry]
  });
  saveQzoneGenerationHistory(next);
  return next;
}

function compareNgramSimilarity(a = [], b = []) {
  const left = new Set(Array.isArray(a) ? a.filter(Boolean) : []);
  const right = new Set(Array.isArray(b) ? b.filter(Boolean) : []);
  if (!left.size || !right.size) return 0;
  let intersect = 0;
  for (const item of left) {
    if (right.has(item)) intersect += 1;
  }
  const union = new Set([...left, ...right]).size;
  return union > 0 ? (intersect / union) : 0;
}

function evaluateQzoneGenerationCandidate(text = '', input = {}) {
  const normalizedText = normalizeBodyText(text);
  const fingerprint = normalizeText(input.fingerprint || normalizeDailyShareFingerprint(normalizedText), 240).toLowerCase();
  const history = Array.isArray(input.recentHistory) ? input.recentHistory : getRecentQzoneHistory();
  const variationProfile = input.variationProfile && typeof input.variationProfile === 'object'
    ? input.variationProfile
    : {};
  const opening = extractOpening(normalizedText);
  const combo = [
    normalizeText(variationProfile.lens || '', 32).toLowerCase(),
    normalizeText(variationProfile.anchor || '', 32).toLowerCase(),
    normalizeText(variationProfile.structure || '', 32).toLowerCase()
  ].join('|');
  const ngrams = toNgrams(normalizedText);
  const strongHistory = history.slice(-RECENT_STRONG_LOOKBACK);
  if (fingerprint && strongHistory.some((item) => item.fingerprint === fingerprint)) {
    return { ok: false, reason: 'recent-content-duplicate', similarity: 1, fingerprint, ngrams, opening };
  }
  if (opening && strongHistory.some((item) => item.opening && item.opening === opening)) {
    return { ok: false, reason: 'recent-opening-duplicate', similarity: 1, fingerprint, ngrams, opening };
  }
  if (combo !== '||' && strongHistory.some((item) => [item.lens, item.anchor, item.structure].join('|') === combo)) {
    return { ok: false, reason: 'recent-variation-combo-duplicate', similarity: 1, fingerprint, ngrams, opening };
  }
  const threshold = Number.isFinite(Number(input.similarityThreshold))
    ? Math.max(0, Math.min(1, Number(input.similarityThreshold)))
    : DEFAULT_SIMILARITY_THRESHOLD;
  let maxSimilarity = 0;
  for (const item of strongHistory) {
    const similarity = compareNgramSimilarity(ngrams, item.ngrams);
    maxSimilarity = Math.max(maxSimilarity, similarity);
    if (similarity >= threshold) {
      return { ok: false, reason: 'recent-content-similar', similarity, fingerprint, ngrams, opening };
    }
  }
  return { ok: true, reason: '', similarity: maxSimilarity, fingerprint, ngrams, opening };
}

function describeGenericAutodraftRandomness(requestText = '') {
  const text = normalizeText(requestText, 200).toLowerCase();
  const explicit = {
    themeLocked: GENERIC_QZONE_GUESS_PATTERNS.mentionTheme.test(text),
    lengthLocked: GENERIC_QZONE_GUESS_PATTERNS.mentionLength.test(text),
    toneLocked: GENERIC_QZONE_GUESS_PATTERNS.mentionTone.test(text)
  };
  return {
    explicit,
    useFullVariation: !explicit.themeLocked && !explicit.lengthLocked && !explicit.toneLocked
  };
}

module.exports = {
  DEFAULT_SIMILARITY_THRESHOLD,
  HISTORY_LIMIT,
  LOOKBACK,
  MAX_RETRIES,
  QZONE_RETRY_MODEL_CONFIG,
  QZONE_TASK_MODEL_CONFIG,
  TOPIC_LIBRARY,
  buildHistoryEntryFromContent,
  buildVariationConstraintPrompt,
  buildVariationProfilePrompt,
  chooseQzoneTopic,
  chooseQzoneTypeByWeight,
  compareNgramSimilarity,
  describeGenericAutodraftRandomness,
  evaluateQzoneGenerationCandidate,
  extractOpening,
  getModelConfigForQzoneAttempt,
  getRecentQzoneHistory,
  getRecentQzoneHistoryByWindow,
  loadQzoneGenerationHistory,
  normalizeDailyShareFingerprint,
  recordQzoneGenerationHistory,
  sampleVariationProfile,
  toNgrams
};
