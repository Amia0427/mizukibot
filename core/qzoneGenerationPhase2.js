const fs = require('fs');
const path = require('path');
const config = require('../config');
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
const IMAGE_CONSISTENCY_THRESHOLD = Number.isFinite(Number(config.QZONE_IMAGE_CONSISTENCY_THRESHOLD))
  ? Math.max(0, Math.min(1, Number(config.QZONE_IMAGE_CONSISTENCY_THRESHOLD)))
  : 0.6;

const ARC_VALUES = Object.freeze(['flat', 'lift', 'sink', 'rebound', 'tease', 'soften']);
const TEMPO_VALUES = Object.freeze(['crisp', 'drifting', 'clipped', 'airy']);
const DISTANCE_VALUES = Object.freeze(['self_only', 'weak_outer', 'ambient_people']);
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
      distance: normalizeText(item?.planSummary?.distance || '', 32).toLowerCase()
    },
    candidates: candidates
      .map((candidate) => ({
        fingerprint: normalizeText(candidate?.fingerprint || '', 240).toLowerCase(),
        score: Number.isFinite(Number(candidate?.score)) ? Number(candidate.score) : 0,
        similarity: Number.isFinite(Number(candidate?.similarity)) ? Number(candidate.similarity) : 0,
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
    plan.imageIntent?.theme,
    plan.imageIntent?.composition,
    plan.imageIntent?.lighting
  ].filter(Boolean).join('|'), 200).toLowerCase();
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
      distance: pickFromPool(DISTANCE_VALUES, usedDistance, random)
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
      planFingerprints: recentFailures.slice(-3).map((item) => normalizeText(item?.planFingerprint || '', 200)).filter(Boolean)
    },
    targetLength: context.targetLength || (context.source === 'bot_diary' ? '80-180' : '24-120')
  };
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
    `scene_anchors: ${(Array.isArray(plan.sceneAnchors) ? plan.sceneAnchors : []).join(' / ') || 'none'}`,
    `emotional_arc: ${plan.emotionalArc || 'none'}`,
    `target_length: ${plan.targetLength || 'none'}`,
    `taboo_hints: ${(Array.isArray(theme.tabooHints) ? theme.tabooHints : []).join(' / ') || 'none'}`,
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
  let score = 0.3;
  score += Math.max(0, 1 - Math.min(1, similarityCheck.similarity)) * 0.25;
  score += hasScene ? 0.15 : 0;
  score += firstPerson ? 0.1 : -0.2;
  score += visibleLength >= 24 ? 0.08 : -0.05;
  score += templateHits ? -0.15 : 0.08;
  if (String(input?.source || '') === 'recommendation' && !/(最近|又|翻出来|在听|在看|想吃)/.test(String(text || ''))) {
    score -= 0.12;
  }
  return {
    score: Math.max(0, Math.min(1, Number(score.toFixed(4)))),
    similarity: similarityCheck.similarity,
    rejectionReason: similarityCheck.ok ? '' : similarityCheck.reason,
    fingerprint: similarityCheck.fingerprint || normalizeDailyShareFingerprint(text)
  };
}

function rankQzoneCandidates(candidates = [], input = {}) {
  const normalized = (Array.isArray(candidates) ? candidates : [])
    .map((item) => {
      const text = normalizeText(item?.text || '', 400);
      const scoring = scoreCandidate(text, {
        recentHistory: input.recentHistory || [],
        plan: item?.plan || input.plan || {},
        source: input.source || ''
      });
      return {
        ...item,
        text,
        score: scoring.score,
        similarity: scoring.similarity,
        fingerprint: scoring.fingerprint,
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
  DISTANCE_VALUES,
  IMAGE_CONSISTENCY_THRESHOLD,
  PLAN_RETRY_LIMIT,
  RERANK_MIN_SCORE,
  SCENE_LIBRARY,
  TEMPO_VALUES,
  TOPIC_TREE,
  appendQzoneGenerationLog,
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
