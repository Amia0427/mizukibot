const fs = require('fs');
const path = require('path');
const config = require('../config');
const { getJsonStore } = require('../utils/storeRegistry');
const {
  DEFAULT_SIMILARITY_THRESHOLD,
  LOOKBACK,
  TOPIC_LIBRARY,
  evaluateQzoneGenerationCandidate,
  getRecentQzoneHistory,
  normalizeDailyShareFingerprint,
  recordQzoneGenerationHistory,
  sampleVariationProfile
} = require('./qzoneGenerationState');

const PLAN_RETRY_LIMIT = Math.max(1, Number(config.QZONE_PLAN_RETRY_LIMIT || 3) || 3);
const CANDIDATE_COUNT = Math.max(1, Number(config.QZONE_CANDIDATE_COUNT || 3) || 3);
const VISUAL_HISTORY_LIMIT = Math.max(1, Number(config.QZONE_VISUAL_HISTORY_LIMIT || 30) || 30);
const RERANK_MIN_SCORE = Number.isFinite(Number(config.QZONE_RERANK_MIN_SCORE))
  ? Math.max(0, Math.min(1, Number(config.QZONE_RERANK_MIN_SCORE)))
  : 0.58;
const EDGE_VARIANT_ENABLED = Boolean(config.QZONE_EDGE_VARIANT_ENABLED);
const CIRCLE_NATURALNESS_WEIGHT = Number.isFinite(Number(config.QZONE_CIRCLE_NATURALNESS_WEIGHT))
  ? Math.max(0, Math.min(1, Number(config.QZONE_CIRCLE_NATURALNESS_WEIGHT)))
  : 0.24;
const TROPE_COLLISION_THRESHOLD = Number.isFinite(Number(config.QZONE_TROPE_COLLISION_THRESHOLD))
  ? Math.max(0, Math.min(1, Number(config.QZONE_TROPE_COLLISION_THRESHOLD)))
  : 0.66;
const BAD_STREAK_BLOCK_WINDOW = Math.max(1, Number(config.QZONE_BAD_STREAK_BLOCK_WINDOW || 4) || 4);
const EDGE_VARIANT_RATIO = Number.isFinite(Number(config.QZONE_EDGE_VARIANT_RATIO))
  ? Math.max(0, Math.min(1, Number(config.QZONE_EDGE_VARIANT_RATIO)))
  : 0.34;
const IMAGE_CONSISTENCY_THRESHOLD = Number.isFinite(Number(config.QZONE_IMAGE_CONSISTENCY_THRESHOLD))
  ? Math.max(0, Math.min(1, Number(config.QZONE_IMAGE_CONSISTENCY_THRESHOLD)))
  : 0.6;

const ARC_VALUES = Object.freeze(['flat', 'lift', 'sink', 'rebound', 'tease', 'soften']);
const TEMPO_VALUES = Object.freeze(['crisp', 'drifting', 'clipped', 'airy']);
const DISTANCE_VALUES = Object.freeze(['self_only', 'weak_outer', 'ambient_people']);
const SPARK_VALUES = Object.freeze(['petty_truth', 'tiny_embarrassment', 'fake_calm', 'soft_obsession', 'harmless_spite', 'self_roast', 'quiet_craving']);
const SOCIAL_MASK_VALUES = Object.freeze(['pretend_fine', 'lowkey_showoff', 'casual_cover', 'reluctant_confess']);
const FRESHNESS_MODE_VALUES = Object.freeze(['mundane_twist', 'anti_template', 'overshare_fakeout', 'mini_scene_cut']);
const VOICE_EDGE_VALUES = Object.freeze(['mild', 'sly', 'sharpish']);
const CANDIDATE_VARIANT_TYPES = Object.freeze(['safe_realistic', 'edge_variant', 'image_variant']);
const SCENE_LIBRARY = Object.freeze({
  room_corner: { label: '房间角落', safeHints: ['桌边', '床边', '门口那一角'], imageHints: ['room corner', 'interior corner'] },
  window_night: { label: '夜窗', safeHints: ['窗边', '夜色', '远处灯光'], imageHints: ['window', 'night city glow'] },
  desk_spill: { label: '桌面散落感', safeHints: ['纸张', '杯子', '屏幕边缘'], imageHints: ['desk clutter', 'cup', 'papers'] },
  commute_gap: { label: '路途中空档', safeHints: ['路上', '走神', '车窗反光'], imageHints: ['commute', 'street glow'] },
  bed_soft: { label: '床边松软感', safeHints: ['被子', '枕头', '赖着不动'], imageHints: ['bed', 'soft fabric'] },
  weather_hang: { label: '天气悬着', safeHints: ['风', '潮气', '雨味'], imageHints: ['rain', 'mist', 'wind'] }
});
const TOPIC_TREE = Object.freeze({
  media: [
    { key: 'media.music.loop', label: '循环歌单', safeHints: ['单曲循环', '耳机里那首歌'], tabooHints: ['榜单', '硬推荐'], imageHints: ['headphones', 'music player'], compatibleVariation: ['music', 'screen'] },
    { key: 'media.movie.rewatch', label: '重看电影', safeHints: ['熟悉镜头', '回看感'], tabooHints: ['完整剧透'], imageHints: ['screen glow', 'movie ambience'], compatibleVariation: ['screen', 'light'] },
    { key: 'media.anime.slice', label: '动画碎片感', safeHints: ['片段', '角色气味'], tabooHints: ['百科式设定'], imageHints: ['anime frame', 'soft color'], compatibleVariation: ['light', 'bed'] },
    { key: 'media.game.idle', label: '游戏挂着', safeHints: ['没打完', '想重新打开'], tabooHints: ['战报式描述'], imageHints: ['controller', 'screen'], compatibleVariation: ['screen', 'desk'] }
  ],
  daily: [
    { key: 'daily.room.corner', label: '房间角落', safeHints: ['角落积着光', '房间有点安静'], tabooHints: ['精确时间'], imageHints: ['corner light', 'bedroom'], compatibleVariation: ['light', 'window'] },
    { key: 'daily.window.pause', label: '窗边停顿', safeHints: ['拉窗帘', '窗缝风'], tabooHints: ['天气播报'], imageHints: ['window', 'curtain'], compatibleVariation: ['window', 'weather'] },
    { key: 'daily.desk.pause', label: '桌面停顿', safeHints: ['键盘旁边', '水杯边上'], tabooHints: ['工作汇报'], imageHints: ['desk', 'cup'], compatibleVariation: ['desk', 'drink'] },
    { key: 'daily.bed.drag', label: '赖床拖延', safeHints: ['不想起', '翻个身'], tabooHints: ['卖惨'], imageHints: ['bed', 'blanket'], compatibleVariation: ['bed', 'body_signal'] }
  ],
  sensory: [
    { key: 'sensory.temperature.damp', label: '潮湿温度', safeHints: ['闷', '发凉', '空气裹着人'], tabooHints: ['医疗描述'], imageHints: ['mist', 'soft light'], compatibleVariation: ['weather', 'window'] },
    { key: 'sensory.light.trim', label: '边角灯光', safeHints: ['灯没有开满', '屏幕边缘的亮'], tabooHints: ['灯具说明'], imageHints: ['lamp glow', 'rim light'], compatibleVariation: ['light', 'screen'] },
    { key: 'sensory.sound.hum', label: '背景嗡鸣', safeHints: ['空调声', '耳机余音'], tabooHints: ['引用原话'], imageHints: ['headphones', 'ambient room'], compatibleVariation: ['music', 'body_signal'] },
    { key: 'sensory.cloth.brush', label: '衣料摩擦', safeHints: ['袖口', '领口', '布料碰到皮肤'], tabooHints: ['外貌描写过重'], imageHints: ['sweater sleeve', 'fabric'], compatibleVariation: ['small_object', 'body_signal'] }
  ],
  mindset: [
    { key: 'mindset.stubborn.care', label: '嘴硬关心', safeHints: ['不承认但还是在意'], tabooHints: ['直接点名别人'], imageHints: ['soft expression', 'cool light'], compatibleVariation: ['window', 'desk'] },
    { key: 'mindset.irritated.spark', label: '烦躁火星', safeHints: ['轻微不耐烦', '想翻白眼'], tabooHints: ['攻击性'], imageHints: ['sharp light', 'screen glow'], compatibleVariation: ['screen', 'desk'] },
    { key: 'mindset.loose.drift', label: '松弛走神', safeHints: ['散掉', '不太想动'], tabooHints: ['空洞重复'], imageHints: ['soft bed', 'lamp'], compatibleVariation: ['bed', 'light'] },
    { key: 'mindset.empty.sink', label: '空落往下沉', safeHints: ['后劲', '慢慢掉下去'], tabooHints: ['危险绝望'], imageHints: ['night window', 'soft dark'], compatibleVariation: ['window', 'weather'] }
  ],
  social: [
    { key: 'social.unsent.reply', label: '撤回冲动', safeHints: ['打完字又删', '不太想回'], tabooHints: ['点名别人'], imageHints: ['message glow', 'screen'], compatibleVariation: ['screen', 'desk'], microObservations: ['打好的字删到只剩一个句号', '输入框亮着但人不想回'], likelyOpenings: ['刚刚把一段话删掉了', '消息框亮了一下又暗下去'], edgeFlavors: ['pretend_fine', 'harmless_spite'] },
    { key: 'social.read.delay', label: '已读拖延感', safeHints: ['看到了但还没回', '懒得解释'], tabooHints: ['攻击性'], imageHints: ['phone screen', 'night room'], compatibleVariation: ['screen', 'window'], microObservations: ['通知栏亮了一次又没管', '把手机扣回桌上'], likelyOpenings: ['看到消息的时候我先装没看见', '通知亮起来那一下其实挺烦'], edgeFlavors: ['fake_calm', 'petty_truth'] }
  ],
  self_image: [
    { key: 'self_image.outfit.hesitate', label: '出门前磨蹭', safeHints: ['换衣服', '照镜子', '假装随意'], tabooHints: ['过度外貌描写'], imageHints: ['mirror', 'soft room'], compatibleVariation: ['small_object', 'light'], microObservations: ['衣服换了两次又换回来', '镜子前站久了一点'], likelyOpenings: ['我刚刚又把衣服换回去了', '出门前在镜子前站得有点久'], edgeFlavors: ['lowkey_showoff', 'tiny_embarrassment'] },
    { key: 'self_image.selfie.fail', label: '自拍失败', safeHints: ['角度不对', '表情怪', '算了'], tabooHints: ['容貌焦虑'], imageHints: ['phone', 'mirror glow'], compatibleVariation: ['screen', 'light'], microObservations: ['前置开了又关', '拍了两张都没存'], likelyOpenings: ['前置打开三秒我就放弃了', '刚刚差点拍照又算了'], edgeFlavors: ['self_roast', 'pretend_fine'] }
  ],
  tiny_desire: [
    { key: 'tiny_desire.drink.pull', label: '想喝点什么', safeHints: ['奶茶', '冰水', '热咖啡'], tabooHints: ['硬安利'], imageHints: ['cup', 'drink'], compatibleVariation: ['drink', 'desk'], microObservations: ['杯口还温着', '冰块化了一半'], likelyOpenings: ['我刚刚突然很想喝点甜的', '现在最真实的愿望其实只是喝一口冰的'], edgeFlavors: ['quiet_craving', 'soft_obsession'] },
    { key: 'tiny_desire.disappear.short', label: '想消失半小时', safeHints: ['躲开一下', '安静一会'], tabooHints: ['危险绝望'], imageHints: ['window', 'night'], compatibleVariation: ['window', 'bed'], microObservations: ['把耳机戴上像临时关门', '只想让世界静音半小时'], likelyOpenings: ['我现在最想做的事是消失半小时', '想安静一会儿这个念头突然变得很具体'], edgeFlavors: ['fake_calm', 'quiet_craving'] }
  ],
  annoyance: [
    { key: 'annoyance.weather.sticky', label: '天气烦', safeHints: ['黏', '闷', '空气不对劲'], tabooHints: ['暴躁攻击'], imageHints: ['mist', 'window'], compatibleVariation: ['weather', 'body_signal'], microObservations: ['衣服贴在皮肤上', '头发不听话'], likelyOpenings: ['今天这个天气真的有点烦人', '空气黏得我不想说话'], edgeFlavors: ['harmless_spite', 'petty_truth'] },
    { key: 'annoyance.tiny.interrupt', label: '被打断', safeHints: ['差一点', '又断掉', '懒得继续'], tabooHints: ['指责别人'], imageHints: ['desk', 'screen'], compatibleVariation: ['desk', 'screen'], microObservations: ['刚沉下去的情绪被提示音拽了一下', '耳机线又缠在一起'], likelyOpenings: ['刚刚差一点就静下来了', '提示音一响我又翻白眼了'], edgeFlavors: ['harmless_spite', 'self_roast'] }
  ]
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
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function atomicWriteJson(filePath, data) {
  getJsonStore(filePath, {
    fallback: () => ({ items: [] })
  }).replace(data, { flushNow: true });
}

function normalizeText(value = '', maxChars = 160) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > maxChars ? text.slice(0, maxChars).trim() : text;
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

function pickFromPool(values = [], blocked = new Set(), random = Math.random) {
  const list = Array.isArray(values) ? values.filter(Boolean) : [];
  const preferred = list.filter((item) => !blocked.has(String(item).trim().toLowerCase()));
  const pool = preferred.length ? preferred : list;
  if (!pool.length) return '';
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return String(pool[index] || '').trim();
}

function uniqueBy(list = [], selector = (item) => item) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const key = String(selector(item) || '').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function normalizeFailureEntry(item = {}) {
  return {
    ts: Math.max(0, Number(item?.ts || 0) || 0),
    reason: normalizeText(item?.reason || '', 80).toLowerCase(),
    source: normalizeText(item?.source || '', 40).toLowerCase(),
    type: normalizeText(item?.type || '', 32).toLowerCase(),
    fingerprint: normalizeText(item?.fingerprint || '', 240).toLowerCase(),
    topicKey: normalizeText(item?.topicKey || '', 80).toLowerCase(),
    topicGroup: normalizeText(item?.topicGroup || '', 80).toLowerCase(),
    planFingerprint: normalizeText(item?.planFingerprint || '', 200).toLowerCase(),
    lens: normalizeText(item?.lens || '', 32).toLowerCase(),
    anchor: normalizeText(item?.anchor || '', 32).toLowerCase(),
    structure: normalizeText(item?.structure || '', 32).toLowerCase(),
    arc: normalizeText(item?.arc || '', 32).toLowerCase(),
    tempo: normalizeText(item?.tempo || '', 32).toLowerCase(),
    distance: normalizeText(item?.distance || '', 32).toLowerCase(),
    spark: normalizeText(item?.spark || '', 32).toLowerCase(),
    socialMask: normalizeText(item?.socialMask || item?.social_mask || '', 32).toLowerCase(),
    freshnessMode: normalizeText(item?.freshnessMode || item?.freshness_mode || '', 32).toLowerCase(),
    voiceEdge: normalizeText(item?.voiceEdge || item?.voice_edge || '', 32).toLowerCase(),
    tropeFingerprint: normalizeText(item?.tropeFingerprint || item?.trope_fingerprint || '', 120).toLowerCase(),
    score: Number.isFinite(Number(item?.score)) ? Number(item.score) : 0
  };
}

function normalizeLogEntry(item = {}) {
  const candidates = Array.isArray(item?.candidates) ? item.candidates : [];
  return {
    ts: Math.max(0, Number(item?.ts || 0) || 0),
    source: normalizeText(item?.source || '', 40).toLowerCase(),
    type: normalizeText(item?.type || '', 32).toLowerCase(),
    groupId: normalizeText(item?.groupId || '', 40),
    status: normalizeText(item?.status || '', 32).toLowerCase(),
    selectedFingerprint: normalizeText(item?.selectedFingerprint || '', 240).toLowerCase(),
    selectedScore: Number.isFinite(Number(item?.selectedScore)) ? Number(item.selectedScore) : 0,
    similarity: Number.isFinite(Number(item?.similarity)) ? Number(item.similarity) : 0,
    imagePublishMode: normalizeText(item?.imagePublishMode || '', 32).toLowerCase(),
    imageConsistencyScore: Number.isFinite(Number(item?.imageConsistencyScore)) ? Number(item.imageConsistencyScore) : 0,
    noveltyScore: Number.isFinite(Number(item?.noveltyScore)) ? Number(item.noveltyScore) : 0,
    tropeCollisionScore: Number.isFinite(Number(item?.tropeCollisionScore)) ? Number(item.tropeCollisionScore) : 0,
    circleNaturalnessScore: Number.isFinite(Number(item?.circleNaturalnessScore)) ? Number(item.circleNaturalnessScore) : 0,
    edgeTensionScore: Number.isFinite(Number(item?.edgeTensionScore)) ? Number(item.edgeTensionScore) : 0,
    failureReasons: uniqueBy(
      (Array.isArray(item?.failureReasons) ? item.failureReasons : [])
        .map((reason) => normalizeText(reason || '', 80).toLowerCase())
        .filter(Boolean),
      (reason) => reason
    ),
    planSummary: {
      fingerprint: normalizeText(item?.planSummary?.fingerprint || '', 200).toLowerCase(),
      topicKey: normalizeText(item?.planSummary?.topicKey || '', 80).toLowerCase(),
      topicGroup: normalizeText(item?.planSummary?.topicGroup || '', 80).toLowerCase(),
      lens: normalizeText(item?.planSummary?.lens || '', 32).toLowerCase(),
      anchor: normalizeText(item?.planSummary?.anchor || '', 32).toLowerCase(),
      structure: normalizeText(item?.planSummary?.structure || '', 32).toLowerCase(),
      arc: normalizeText(item?.planSummary?.arc || '', 32).toLowerCase(),
      tempo: normalizeText(item?.planSummary?.tempo || '', 32).toLowerCase(),
      distance: normalizeText(item?.planSummary?.distance || '', 32).toLowerCase(),
      spark: normalizeText(item?.planSummary?.spark || '', 32).toLowerCase(),
      socialMask: normalizeText(item?.planSummary?.socialMask || item?.planSummary?.social_mask || '', 32).toLowerCase(),
      freshnessMode: normalizeText(item?.planSummary?.freshnessMode || item?.planSummary?.freshness_mode || '', 32).toLowerCase(),
      voiceEdge: normalizeText(item?.planSummary?.voiceEdge || item?.planSummary?.voice_edge || '', 32).toLowerCase(),
      tropeFingerprint: normalizeText(item?.planSummary?.tropeFingerprint || item?.planSummary?.trope_fingerprint || '', 120).toLowerCase()
    },
    candidates: candidates
      .map((candidate) => ({
        fingerprint: normalizeText(candidate?.fingerprint || '', 240).toLowerCase(),
        score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : 0,
        similarity: Number.isFinite(Number(candidate?.similarity)) ? Number(candidate.similarity) : 0,
        noveltyScore: Number.isFinite(Number(candidate?.noveltyScore)) ? Number(candidate.noveltyScore) : 0,
        tropeCollisionScore: Number.isFinite(Number(candidate?.tropeCollisionScore)) ? Number(candidate.tropeCollisionScore) : 0,
        circleNaturalnessScore: Number.isFinite(Number(candidate?.circleNaturalnessScore)) ? Number(candidate.circleNaturalnessScore) : 0,
        edgeTensionScore: Number.isFinite(Number(candidate?.edgeTensionScore)) ? Number(candidate.edgeTensionScore) : 0,
        variantType: normalizeText(candidate?.variantType || '', 32).toLowerCase(),
        tropeFingerprint: normalizeText(candidate?.tropeFingerprint || '', 120).toLowerCase(),
        rejected: Boolean(candidate?.rejected),
        rejectionReason: normalizeText(candidate?.rejectionReason || '', 80).toLowerCase()
      }))
      .slice(0, 8)
  };
}

function normalizeLogPayload(payload = {}) {
  return {
    items: (Array.isArray(payload?.items) ? payload.items : [])
      .map((item) => normalizeLogEntry(item))
      .filter((item) => item.ts && item.source)
      .slice(-200)
  };
}

function normalizeVisualEntry(item = {}) {
  return {
    ts: Math.max(0, Number(item?.ts || 0) || 0),
    source: normalizeText(item?.source || '', 40).toLowerCase(),
    theme: normalizeText(item?.theme || '', 80).toLowerCase(),
    composition: normalizeText(item?.composition || '', 80).toLowerCase(),
    lighting: normalizeText(item?.lighting || '', 80).toLowerCase(),
    promptFingerprint: normalizeText(item?.promptFingerprint || '', 240).toLowerCase()
  };
}

function normalizeVisualPayload(payload = {}) {
  return {
    items: (Array.isArray(payload?.items) ? payload.items : [])
      .map((item) => normalizeVisualEntry(item))
      .filter((item) => item.ts && item.promptFingerprint)
      .slice(-VISUAL_HISTORY_LIMIT)
  };
}

function loadQzoneGenerationLog() {
  return normalizeLogPayload(safeReadJson(config.QZONE_GENERATION_LOG_FILE, { items: [] }));
}

function saveQzoneGenerationLog(payload = {}) {
  const normalized = normalizeLogPayload(payload);
  atomicWriteJson(config.QZONE_GENERATION_LOG_FILE, normalized);
  return normalized;
}

function appendQzoneGenerationLog(entry = {}) {
  const payload = loadQzoneGenerationLog();
  const normalizedEntry = normalizeLogEntry({
    ts: Date.now(),
    ...entry
  });
  if (!normalizedEntry.ts || !normalizedEntry.source) return payload;
  return saveQzoneGenerationLog({
    items: [...payload.items, normalizedEntry]
  });
}

function loadQzoneVisualHistory() {
  return normalizeVisualPayload(safeReadJson(config.QZONE_VISUAL_HISTORY_FILE, { items: [] }));
}

function saveQzoneVisualHistory(payload = {}) {
  const normalized = normalizeVisualPayload(payload);
  atomicWriteJson(config.QZONE_VISUAL_HISTORY_FILE, normalized);
  return normalized;
}

function recordQzoneVisualHistory(entry = {}) {
  const payload = loadQzoneVisualHistory();
  const normalizedEntry = normalizeVisualEntry({
    ts: Date.now(),
    ...entry
  });
  if (!normalizedEntry.ts || !normalizedEntry.promptFingerprint) return payload;
  return saveQzoneVisualHistory({
    items: [...payload.items, normalizedEntry]
  });
}

function getRecentFailureLikeEntries(logPayload = null, limit = LOOKBACK) {
  const payload = logPayload || loadQzoneGenerationLog();
  const recent = (Array.isArray(payload?.items) ? payload.items : [])
    .filter((item) => item.status === 'failed' || item.status === 'skipped')
    .slice(-Math.max(1, Number(limit) || LOOKBACK));
  return recent.map((item) => normalizeFailureEntry({
    ts: item.ts,
    reason: (item.failureReasons || [])[0] || item.status,
    source: item.source,
    type: item.type,
    fingerprint: item.selectedFingerprint,
    topicKey: item.planSummary?.topicKey || '',
    topicGroup: item.planSummary?.topicGroup || '',
    planFingerprint: item.planSummary?.fingerprint || '',
    lens: item.planSummary?.lens || '',
    anchor: item.planSummary?.anchor || '',
    structure: item.planSummary?.structure || '',
    arc: item.planSummary?.arc || '',
    tempo: item.planSummary?.tempo || '',
    distance: item.planSummary?.distance || '',
    score: item.selectedScore
  }));
}

function topicTreeItems() {
  return Object.values(TOPIC_TREE).flatMap((items) => Array.isArray(items) ? items : []);
}

function pickTopicTreeNode(seed = '', recentHistory = [], recentFailures = []) {
  const failureKeys = new Set(
    recentFailures
      .slice(-3)
      .map((item) => normalizeText(item?.topicKey || '', 80).toLowerCase())
      .filter(Boolean)
  );
  const recentTopicGroups = new Set(
    (Array.isArray(recentHistory) ? recentHistory : [])
      .slice(-3)
      .map((item) => normalizeText(item?.topicGroup || '', 80).toLowerCase())
      .filter(Boolean)
  );
  const items = topicTreeItems();
  const preferred = items.filter((item) => {
    const group = String(item?.key || '').split('.')[0];
    return !failureKeys.has(String(item?.key || '').toLowerCase()) && !recentTopicGroups.has(group);
  });
  const pool = preferred.length ? preferred : items;
  const random = createSeededRandom(`${seed}|topic-tree`);
  const index = Math.min(pool.length - 1, Math.floor(random() * pool.length));
  return pool[index] || null;
}

function buildPlanFingerprint(plan = {}) {
  return normalizeText([
    plan.type,
    plan.theme?.key,
    plan.microTheme?.key,
    plan.variationProfile?.lens,
    plan.variationProfile?.anchor,
    plan.variationProfile?.structure,
    plan.variationProfile?.arc,
    plan.variationProfile?.tempo,
    plan.variationProfile?.distance,
    plan.variationProfile?.spark,
    plan.variationProfile?.socialMask,
    plan.variationProfile?.freshnessMode,
    plan.variationProfile?.voiceEdge,
    plan.tropeFingerprint,
    plan.imageIntent?.theme,
    plan.imageIntent?.composition,
    plan.imageIntent?.lighting
  ].filter(Boolean).join('|'), 200).toLowerCase();
}

function buildTropeFingerprint(input = {}) {
  return normalizeText([
    input.anchor || '',
    input.structure || '',
    input.socialMask || '',
    input.spark || '',
    input.freshnessMode || '',
    input.ending || ''
  ].filter(Boolean).join('|'), 120).toLowerCase();
}

function buildQzonePlan(context = {}) {
  const recentHistory = Array.isArray(context.recentHistory) ? context.recentHistory : getRecentQzoneHistory();
  const recentFailures = Array.isArray(context.recentFailures) ? context.recentFailures : getRecentFailureLikeEntries();
  const variationProfile = sampleVariationProfile({
    source: context.source || 'unknown',
    type: context.type || '',
    windowKey: context.windowKey || '',
    groupId: context.groupId || '',
    today: context.today || '',
    attempt: context.planAttempt || 0,
    now: context.now || Date.now(),
    recentHistory
  });
  const random = createSeededRandom([
    context.source || 'unknown',
    context.type || '',
    context.windowKey || '',
    context.today || '',
    context.groupId || '',
    String(context.planAttempt || 0)
  ].join('|'));
  const usedArc = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.arc || '', 32).toLowerCase()).filter(Boolean)
  );
  const usedTempo = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.tempo || '', 32).toLowerCase()).filter(Boolean)
  );
  const usedDistance = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.distance || '', 32).toLowerCase()).filter(Boolean)
  );
  const usedSpark = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.spark || '', 32).toLowerCase()).filter(Boolean)
  );
  const usedSocialMask = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.socialMask || item?.social_mask || '', 32).toLowerCase()).filter(Boolean)
  );
  const usedFreshnessMode = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.freshnessMode || item?.freshness_mode || '', 32).toLowerCase()).filter(Boolean)
  );
  const usedVoiceEdge = new Set(
    recentHistory.slice(-3).map((item) => normalizeText(item?.voiceEdge || item?.voice_edge || '', 32).toLowerCase()).filter(Boolean)
  );
  const themeNode = pickTopicTreeNode([
    context.source || 'unknown',
    context.type || '',
    context.windowKey || '',
    context.today || '',
    String(context.planAttempt || 0)
  ].join('|'), recentHistory, recentFailures);
  const microTheme = themeNode
    ? {
      key: `${themeNode.key}.detail`,
      label: `${themeNode.label}细部`,
      safeHints: uniqueBy(themeNode.safeHints || [], (item) => item).slice(0, 2),
      imageHints: uniqueBy(themeNode.imageHints || [], (item) => item).slice(0, 2)
    }
    : null;
  const plan = {
    type: normalizeText(context.type || '', 32).toLowerCase(),
    theme: themeNode ? {
      key: normalizeText(themeNode.key || '', 80).toLowerCase(),
      label: normalizeText(themeNode.label || '', 48),
      safeHints: uniqueBy(themeNode.safeHints || [], (item) => item).slice(0, 3),
      tabooHints: uniqueBy(themeNode.tabooHints || [], (item) => item).slice(0, 3),
      imageHints: uniqueBy(themeNode.imageHints || [], (item) => item).slice(0, 3)
    } : null,
    microTheme,
    variationProfile: {
      ...variationProfile,
      arc: pickFromPool(ARC_VALUES, usedArc, random),
      tempo: pickFromPool(TEMPO_VALUES, usedTempo, random),
      distance: pickFromPool(DISTANCE_VALUES, usedDistance, random),
      spark: pickFromPool(SPARK_VALUES, usedSpark, random),
      socialMask: pickFromPool(SOCIAL_MASK_VALUES, usedSocialMask, random),
      freshnessMode: pickFromPool(FRESHNESS_MODE_VALUES, usedFreshnessMode, random),
      voiceEdge: pickFromPool(VOICE_EDGE_VALUES, usedVoiceEdge, random)
    },
    sceneAnchors: uniqueBy([
      normalizeText(variationProfile.anchor || '', 32),
      ...(Array.isArray(themeNode?.compatibleVariation) ? themeNode.compatibleVariation : []),
      ...(themeNode?.safeHints || [])
    ].filter(Boolean), (item) => item).slice(0, 4),
    emotionalArc: normalizeText(pickFromPool(ARC_VALUES, usedArc, random), 32).toLowerCase(),
    imageIntent: {
      enabled: context.allowImage !== false,
      theme: normalizeText(themeNode?.label || variationProfile.anchor || context.type || 'daily', 64),
      composition: normalizeText(pickFromPool(Object.keys(SCENE_LIBRARY), new Set(), random), 64),
      lighting: normalizeText(pickFromPool(['soft_night', 'window_glow', 'desk_lamp', 'muted_rain', 'screen_rim'], new Set(), random), 64),
      promptHints: uniqueBy([
        ...(themeNode?.imageHints || []),
        ...(microTheme?.imageHints || []),
        ...(SCENE_LIBRARY[pickFromPool(Object.keys(SCENE_LIBRARY), new Set(), random)]?.imageHints || [])
      ].filter(Boolean), (item) => item).slice(0, 4)
    },
    bannedRepeats: {
      openings: recentHistory.slice(-3).map((item) => normalizeText(item?.opening || '', 20)).filter(Boolean),
      planFingerprints: recentFailures.slice(-3).map((item) => normalizeText(item?.planFingerprint || '', 200)).filter(Boolean),
      tropes: recentHistory.slice(-BAD_STREAK_BLOCK_WINDOW).map((item) => normalizeText(item?.tropeFingerprint || item?.trope_fingerprint || '', 120)).filter(Boolean)
    },
    targetLength: context.targetLength || (context.source === 'bot_diary' ? '80-180' : '24-120')
  };
  plan.tropeFingerprint = buildTropeFingerprint({
    anchor: plan.variationProfile?.anchor,
    structure: plan.variationProfile?.structure,
    socialMask: plan.variationProfile?.socialMask,
    spark: plan.variationProfile?.spark,
    freshnessMode: plan.variationProfile?.freshnessMode,
    ending: plan.variationProfile?.ending
  });
  plan.fingerprint = buildPlanFingerprint(plan);
  return plan;
}

function buildPlanPrompt(plan = {}, context = {}) {
  const theme = plan.theme || {};
  const microTheme = plan.microTheme || {};
  return [
    '[计划摘要]',
    `type: ${plan.type || normalizeText(context.type || '', 32).toLowerCase()}`,
    `theme: ${theme.key || 'none'} / ${theme.label || 'none'}`,
    `micro_theme: ${microTheme.key || 'none'} / ${microTheme.label || 'none'}`,
    `variation: lens=${plan.variationProfile?.lens || ''}; emotion=${plan.variationProfile?.emotion || ''}; anchor=${plan.variationProfile?.anchor || ''}; structure=${plan.variationProfile?.structure || ''}; ending=${plan.variationProfile?.ending || ''}; arc=${plan.variationProfile?.arc || ''}; tempo=${plan.variationProfile?.tempo || ''}; distance=${plan.variationProfile?.distance || ''}`,
    `circle_style: spark=${plan.variationProfile?.spark || ''}; social_mask=${plan.variationProfile?.socialMask || ''}; freshness_mode=${plan.variationProfile?.freshnessMode || ''}; voice_edge=${plan.variationProfile?.voiceEdge || ''}`,
    `scene_anchors: ${(Array.isArray(plan.sceneAnchors) ? plan.sceneAnchors : []).join(' / ') || 'none'}`,
    `emotional_arc: ${plan.emotionalArc || 'none'}`,
    `target_length: ${plan.targetLength || 'none'}`,
    `taboo_hints: ${(Array.isArray(theme.tabooHints) ? theme.tabooHints : []).join(' / ') || 'none'}`,
    `forbidden_tropes: ${(Array.isArray(plan.bannedRepeats?.tropes) ? plan.bannedRepeats.tropes : []).join(' / ') || 'none'}`,
    `safe_hints: ${[
      ...(Array.isArray(theme.safeHints) ? theme.safeHints : []),
      ...(Array.isArray(microTheme.safeHints) ? microTheme.safeHints : [])
    ].join(' / ') || 'none'}`,
    `banned_openings: ${(plan.bannedRepeats?.openings || []).join(' / ') || 'none'}`,
    `banned_plan_fingerprints: ${(plan.bannedRepeats?.planFingerprints || []).join(' / ') || 'none'}`
  ].join('\n');
}

function buildCandidatePrompt(basePrompt = '', plan = {}, extra = '') {
  return [basePrompt, buildPlanPrompt(plan), extra].filter(Boolean).join('\n\n');
}

function scoreCircleNaturalness(text = '', plan = {}) {
  const body = String(text || '');
  let score = 0.2;
  if (/(刚刚|其实|差点|本来|刚才|又|还是|结果)/.test(body)) score += 0.18;
  if (/(消息|输入框|通知|屏幕|镜子|出门|耳机|杯子|窗帘|鞋|衣服)/.test(body)) score += 0.16;
  if (/(我最近想说|分享一下|突然觉得|今天也是|有时候就是)/.test(body)) score -= 0.18;
  if (/(像是|仿佛|似乎)/.test(body) && body.length < 70) score -= 0.08;
  if (plan?.variationProfile?.socialMask === 'pretend_fine' && /(没事|算了|装作|假装)/.test(body)) score += 0.12;
  if (plan?.variationProfile?.spark === 'tiny_embarrassment' && /(有点丢人|有点好笑|差点|没存|删掉)/.test(body)) score += 0.12;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function scoreEdgeTension(text = '', plan = {}) {
  const body = String(text || '');
  let score = 0.1;
  if (/(翻白眼|懒得|算了|装没看见|不承认|又被|差点|其实挺烦)/.test(body)) score += 0.28;
  if (/(滚|烦死|恶心|受不了|去死|讨厌死)/.test(body)) score -= 0.4;
  if (plan?.variationProfile?.voiceEdge === 'sharpish') score += 0.1;
  if (plan?.variationProfile?.voiceEdge === 'mild') score -= 0.05;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function scoreNovelty(text = '', input = {}) {
  const recentHistory = Array.isArray(input.recentHistory) ? input.recentHistory : [];
  const plan = input.plan || {};
  const tropeFingerprint = plan.tropeFingerprint || '';
  const recentTropeHits = recentHistory.slice(-BAD_STREAK_BLOCK_WINDOW).filter((item) => item.tropeFingerprint === tropeFingerprint).length;
  const recentAnchorHits = recentHistory.slice(-BAD_STREAK_BLOCK_WINDOW).filter((item) => item.anchor === plan?.variationProfile?.anchor).length;
  const recentSparkHits = recentHistory.slice(-BAD_STREAK_BLOCK_WINDOW).filter((item) => item.spark === plan?.variationProfile?.spark).length;
  let score = Math.max(0, 1 - (recentTropeHits * 0.34) - (recentAnchorHits * 0.12) - (recentSparkHits * 0.08));
  if (/(消息|镜子|耳机|杯子|衣服|窗帘|鞋)/.test(String(text || ''))) score += 0.05;
  return Math.max(0, Math.min(1, Number(score.toFixed(4))));
}

function scoreTropeCollision(text = '', input = {}) {
  const recentHistory = Array.isArray(input.recentHistory) ? input.recentHistory : [];
  const plan = input.plan || {};
  const tropeFingerprint = plan.tropeFingerprint || '';
  const sameTrope = recentHistory.slice(-BAD_STREAK_BLOCK_WINDOW).filter((item) => item.tropeFingerprint === tropeFingerprint).length;
  const sameCombo = recentHistory.slice(-BAD_STREAK_BLOCK_WINDOW).filter((item) => (
    item.anchor === plan?.variationProfile?.anchor
    && item.structure === plan?.variationProfile?.structure
    && item.ending === plan?.variationProfile?.ending
  )).length;
  return Math.max(0, Math.min(1, Number((sameTrope * 0.45 + sameCombo * 0.25).toFixed(4))));
}

function scoreCandidate(text = '', input = {}) {
  const similarityCheck = evaluateQzoneGenerationCandidate(text, {
    fingerprint: normalizeDailyShareFingerprint(text),
    recentHistory: input.recentHistory || [],
    variationProfile: input.plan?.variationProfile || {},
    similarityThreshold: input.similarityThreshold || DEFAULT_SIMILARITY_THRESHOLD
  });
  const visibleLength = String(text || '').replace(/\s+/g, '').length;
  const hasScene = (input.plan?.sceneAnchors || []).some((anchor) => String(text || '').includes(String(anchor || '').slice(0, 2)));
  const firstPerson = /(^|[，。！？\s])(我|我今天|我刚|我还|我又|我在|我想|我的)/.test(String(text || ''));
  const templateHits = /(分享一下|顺手说一句|我最近想说|突然想到|今天也是)/.test(String(text || '')) ? 1 : 0;
  const circleNaturalnessScore = scoreCircleNaturalness(text, input.plan || {});
  const edgeTensionScore = scoreEdgeTension(text, input.plan || {});
  const noveltyScore = scoreNovelty(text, input);
  const tropeCollisionScore = scoreTropeCollision(text, input);
  let score = 0.3;
  score += Math.max(0, 1 - Math.min(1, similarityCheck.similarity)) * 0.25;
  score += hasScene ? 0.15 : 0;
  score += firstPerson ? 0.1 : -0.2;
  score += visibleLength >= 24 ? 0.08 : -0.05;
  score += templateHits ? -0.15 : 0.08;
  score += circleNaturalnessScore * CIRCLE_NATURALNESS_WEIGHT;
  score += noveltyScore * 0.16;
  score += edgeTensionScore * (EDGE_VARIANT_ENABLED ? 0.1 : 0.03);
  score -= tropeCollisionScore * 0.24;
  if (String(input?.source || '') === 'recommendation' && !/(最近|又|翻出来|在听|在看|想吃)/.test(String(text || ''))) {
    score -= 0.12;
  }
  if (EDGE_VARIANT_ENABLED && input.variantType === 'edge_variant' && edgeTensionScore < 0.12) {
    score -= 0.08;
  }
  if (EDGE_VARIANT_ENABLED && input.variantType === 'safe_realistic' && circleNaturalnessScore < 0.25) {
    score -= 0.06;
  }
  const rejectionReason = !similarityCheck.ok
    ? similarityCheck.reason
    : (tropeCollisionScore >= TROPE_COLLISION_THRESHOLD ? 'trope-collision' : '');
  return {
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    similarity: similarityCheck.similarity,
    noveltyScore,
    tropeCollisionScore,
    circleNaturalnessScore,
    edgeTensionScore,
    rejectionReason,
    fingerprint: similarityCheck.fingerprint || normalizeDailyShareFingerprint(text),
    tropeFingerprint: (input.plan && input.plan.tropeFingerprint) ? input.plan.tropeFingerprint : ''
  };
}

function rankQzoneCandidates(candidates = [], input = {}) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((item) => {
      const text = normalizeText(item?.text || '', 400);
      const scoring = scoreCandidate(text, {
        recentHistory: input.recentHistory || [],
        plan: item?.plan || input.plan || {},
        source: input.source || '',
        variantType: item?.variantType || ''
      });
      return {
        ...item,
        text,
        score: scoring.score,
        similarity: scoring.similarity,
        noveltyScore: scoring.noveltyScore,
        tropeCollisionScore: scoring.tropeCollisionScore,
        circleNaturalnessScore: scoring.circleNaturalnessScore,
        edgeTensionScore: scoring.edgeTensionScore,
        fingerprint: scoring.fingerprint,
        tropeFingerprint: scoring.tropeFingerprint,
        rejected: Boolean(item?.rejected) || Boolean(scoring.rejectionReason),
        rejectionReason: normalizeText(item?.rejectionReason || scoring.rejectionReason || '', 80).toLowerCase()
      };
    })
    .filter((item) => item.text);
  normalized.sort((a, b) => b.score - a.score);
  return normalized;
}

function pickBestCandidate(candidates = [], options = {}) {
  const ranked = rankQzoneCandidates(candidates, options);
  const top = ranked[0] || null;
  if (!top) return { selected: null, ranked };
  if (top.rejected || top.score < RERANK_MIN_SCORE) {
    return { selected: null, ranked };
  }
  return { selected: top, ranked };
}

function normalizeTelemetryPayload(payload = {}) {
  return {
    source: normalizeText(payload.source || '', 40).toLowerCase(),
    type: normalizeText(payload.type || '', 32).toLowerCase(),
    groupId: normalizeText(payload.groupId || '', 40),
    status: normalizeText(payload.status || '', 32).toLowerCase(),
    selectedFingerprint: normalizeText(payload.selectedFingerprint || '', 240).toLowerCase(),
    selectedScore: Number.isFinite(Number(payload.selectedScore)) ? Number(payload.selectedScore) : 0,
    similarity: Number.isFinite(Number(payload.similarity)) ? Number(payload.similarity) : 0,
    imagePublishMode: normalizeText(payload.imagePublishMode || '', 32).toLowerCase(),
    imageConsistencyScore: Number.isFinite(Number(payload.imageConsistencyScore)) ? Number(payload.imageConsistencyScore) : 0,
    noveltyScore: Number.isFinite(Number(payload.noveltyScore)) ? Number(payload.noveltyScore) : 0,
    tropeCollisionScore: Number.isFinite(Number(payload.tropeCollisionScore)) ? Number(payload.tropeCollisionScore) : 0,
    circleNaturalnessScore: Number.isFinite(Number(payload.circleNaturalnessScore)) ? Number(payload.circleNaturalnessScore) : 0,
    edgeTensionScore: Number.isFinite(Number(payload.edgeTensionScore)) ? Number(payload.edgeTensionScore) : 0,
    failureReasons: uniqueBy((payload.failureReasons || []).map((reason) => normalizeText(reason || '', 80)).filter(Boolean), (reason) => reason),
    planSummary: payload.planSummary || {},
    candidates: payload.candidates || []
  };
}

function summarizeQzoneDebug(limit = 20) {
  const logs = loadQzoneGenerationLog().items.slice(-Math.max(1, Number(limit) || 20));
  const lines = [];
  if (!logs.length) {
    return '最近没有 QZone phase2 生成日志。';
  }
  const byStatus = {};
  const bySource = {};
  const failureReasons = {};
  for (const item of logs) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    bySource[item.source] = (bySource[item.source] || 0) + 1;
    for (const reason of item.failureReasons || []) {
      failureReasons[reason] = (failureReasons[reason] || 0) + 1;
    }
  }
  lines.push(`最近 ${logs.length} 条: status=${Object.entries(byStatus).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  lines.push(`来源分布: ${Object.entries(bySource).map(([k, v]) => `${k}:${v}`).join(', ')}`);
  const topFailures = Object.entries(failureReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  lines.push(`常见失败: ${topFailures.length ? topFailures.map(([k, v]) => `${k}:${v}`).join(', ') : '无'}`);
  const last = logs[logs.length - 1];
  if (last) {
    lines.push(`最近一条: source=${last.source} status=${last.status} score=${last.selectedScore} similarity=${last.similarity}`);
  }
  const topTropes = {};
  const topVariants = {};
  for (const item of logs) {
    if (item?.planSummary?.tropeFingerprint) {
      topTropes[item.planSummary.tropeFingerprint] = (topTropes[item.planSummary.tropeFingerprint] || 0) + 1;
    }
    for (const candidate of item.candidates || []) {
      if (candidate.variantType) {
        topVariants[candidate.variantType] = (topVariants[candidate.variantType] || 0) + 1;
      }
    }
  }
  const tropeLines = Object.entries(topTropes).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const variantLines = Object.entries(topVariants).sort((a, b) => b[1] - a[1]).slice(0, 5);
  lines.push(`常见套路: ${tropeLines.length ? tropeLines.map(([k, v]) => `${k}:${v}`).join(', ') : '无'}`);
  lines.push(`候选风味: ${variantLines.length ? variantLines.map(([k, v]) => `${k}:${v}`).join(', ') : '无'}`);
  return lines.join('\n');
}

function summarizeQzoneWindowStats(days = 7) {
  const cutoff = Date.now() - (Math.max(1, Number(days) || 7) * 24 * 60 * 60 * 1000);
  const logs = loadQzoneGenerationLog().items.filter((item) => item.ts >= cutoff);
  if (!logs.length) {
    return `最近 ${days} 天没有 QZone phase2 数据。`;
  }
  const total = logs.length;
  const sent = logs.filter((item) => item.status === 'sent').length;
  const skipped = logs.filter((item) => item.status === 'skipped').length;
  const failed = logs.filter((item) => item.status === 'failed').length;
  const imageDegraded = logs.filter((item) => item.imagePublishMode === 'image_degraded').length;
  const avgSimilarity = logs.reduce((sum, item) => sum + Number(item.similarity || 0), 0) / total;
  return [
    `最近 ${days} 天 QZone phase2 统计`,
    `总生成: ${total}`,
    `发送成功: ${sent}`,
    `跳过: ${skipped}`,
    `失败: ${failed}`,
    `图片降级: ${imageDegraded}`,
    `平均相似度: ${avgSimilarity.toFixed(3)}`
  ].join('\n');
}

function buildVisualFingerprint(imageIntent = {}) {
  return normalizeText([
    imageIntent.theme,
    imageIntent.composition,
    imageIntent.lighting,
    ...(Array.isArray(imageIntent.promptHints) ? imageIntent.promptHints : [])
  ].filter(Boolean).join('|'), 240).toLowerCase();
}

function evaluateImageConsistency({ text = '', plan = {}, visualHistory = null } = {}) {
  const history = visualHistory || loadQzoneVisualHistory().items;
  const imageIntent = plan.imageIntent || {};
  const visualFingerprint = buildVisualFingerprint(imageIntent);
  const textBody = normalizeText(text || '', 400);
  const sceneHits = (plan.sceneAnchors || []).filter((item) => item && textBody.includes(String(item).slice(0, 2))).length;
  const themeHit = imageIntent.theme && textBody.includes(String(imageIntent.theme).slice(0, 2));
  const historyDuplicate = history.slice(-5).some((item) => item.promptFingerprint === visualFingerprint);
  let score = 0.2;
  score += sceneHits > 0 ? 0.25 : 0;
  score += themeHit ? 0.2 : 0;
  score += historyDuplicate ? -0.35 : 0.15;
  return {
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    consistent: Math.max(0, Math.min(1, score)) >= IMAGE_CONSISTENCY_THRESHOLD,
    duplicate: historyDuplicate,
    visualFingerprint
  };
}

function buildVisualPromptHints(plan = {}) {
  const intent = plan.imageIntent || {};
  return [
    normalizeText(intent.theme || '', 64),
    normalizeText(intent.composition || '', 64),
    normalizeText(intent.lighting || '', 64),
    ...(Array.isArray(intent.promptHints) ? intent.promptHints.map((item) => normalizeText(item || '', 64)) : [])
  ].filter(Boolean);
}

function finalizeSuccessfulQzoneRecord(input = {}) {
  if (input.recordHistory !== false) {
    recordQzoneGenerationHistory({
      source: input.source || 'unknown',
      text: input.text || '',
      topicKey: input.plan?.theme?.key || input.topicKey || '',
      topicGroup: input.plan?.theme?.key ? String(input.plan.theme.key).split('.')[0] : (input.topicGroup || ''),
      variationProfile: input.plan?.variationProfile || input.variationProfile || {},
      type: input.type || input.plan?.type || '',
      at: input.at || Date.now()
    });
  }
  if (input.recordVisual !== false && input.plan?.imageIntent?.enabled) {
    recordQzoneVisualHistory({
      source: input.source || 'unknown',
      theme: input.plan.imageIntent.theme || '',
      composition: input.plan.imageIntent.composition || '',
      lighting: input.plan.imageIntent.lighting || '',
      promptFingerprint: buildVisualFingerprint(input.plan.imageIntent)
    });
  }
}

module.exports = {
  ARC_VALUES,
  CANDIDATE_COUNT,
  CANDIDATE_VARIANT_TYPES,
  DISTANCE_VALUES,
  EDGE_VARIANT_ENABLED,
  IMAGE_CONSISTENCY_THRESHOLD,
  PLAN_RETRY_LIMIT,
  RERANK_MIN_SCORE,
  SCENE_LIBRARY,
  TEMPO_VALUES,
  TOPIC_TREE,
  appendQzoneGenerationLog,
  buildTropeFingerprint,
  buildCandidatePrompt,
  buildPlanFingerprint,
  buildPlanPrompt,
  buildQzonePlan,
  buildVisualFingerprint,
  buildVisualPromptHints,
  evaluateImageConsistency,
  finalizeSuccessfulQzoneRecord,
  getRecentFailureLikeEntries,
  loadQzoneGenerationLog,
  loadQzoneVisualHistory,
  normalizeTelemetryPayload,
  pickBestCandidate,
  rankQzoneCandidates,
  recordQzoneVisualHistory,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
};
