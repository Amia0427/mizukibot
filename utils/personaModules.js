const fs = require('fs');
const path = require('path');
const config = require('../config');

const MODULE_CATALOG_PATH = path.join(config.PROMPTS_DIR, 'persona_modules', 'module-catalog.json');

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function loadPersonaModuleCatalog() {
  const parsed = safeReadJson(MODULE_CATALOG_PATH, { version: 1, modules: [] });
  const modules = normalizeArray(parsed?.modules).map((item) => ({
    id: normalizeText(item?.id),
    path: normalizeText(item?.path),
    purpose: normalizeText(item?.purpose),
    triggerHints: normalizeArray(item?.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean),
    tokenCost: Math.max(0, Number(item?.tokenCost || 0) || 0),
    priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : 100,
    conflictsWith: normalizeArray(item?.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean),
    phase: normalizeText(item?.phase, 'all'),
    slot: normalizeText(item?.slot, 'general')
  })).filter((item) => item.id && item.path);

  return {
    version: Number(parsed?.version || 1) || 1,
    maxActiveModules: Math.max(0, Number(parsed?.max_active_modules || 2) || 2),
    defaultMaxActiveModules: Math.max(0, Number(parsed?.default_max_active_modules || 1) || 1),
    modules
  };
}

function getPersonaModuleCatalogSummary() {
  const catalog = loadPersonaModuleCatalog();
  return catalog.modules.map((item) => ({
    moduleId: item.id,
    purpose: item.purpose,
    triggerHints: item.triggerHints.slice(0, 5),
    tokenCost: item.tokenCost,
    conflictsWith: item.conflictsWith.slice(0, 4),
    priority: item.priority,
    phase: item.phase,
    slot: item.slot
  }));
}

function inferPhase(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  const explicit = normalizeText(context.personaPhase || routeMeta.personaPhase || routeMeta.phaseHint || '');
  if (explicit) return explicit.toLowerCase();
  return 'phase2';
}

function lower(text = '') {
  return normalizeText(text).toLowerCase();
}

function pickCandidateIds(context = {}) {
  const question = lower(context.question || '');
  const routePrompt = lower(context.routePrompt || '');
  const combined = `${question}\n${routePrompt}`;
  const addresseeName = lower(context.directedContext?.addressee?.senderName || '');
  const addresseeUserId = lower(context.directedContext?.addressee?.userId || '');
  const continuitySignals = context.continuitySignals && typeof context.continuitySignals === 'object'
    ? context.continuitySignals
    : {};
  const phase = inferPhase(context);
  const candidates = new Set();

  if (!question) return [];

  if (/(日常|随便聊|闲聊|最近|今天|刚刚|哈哈|可爱|有趣|想到了)/i.test(combined) && !/(难受|痛苦|秘密|说不出口|被看见)/i.test(combined)) {
    candidates.add('daily_energy');
  }
  if (/(陌生人|第一次见|初次见面|刚认识|在吗|你好呀?)/i.test(combined)) {
    candidates.add('stranger_branch');
  }
  if (/(群里|群聊|大家都在|你们几个|插一句|接一句)/i.test(combined) || context.chatType === 'group') {
    candidates.add('scene_group_insert');
  }
  if (/(私聊|单独说|只跟你说|悄悄话)/i.test(combined) || context.chatType === 'private') {
    candidates.add('scene_private_chat');
  }

  if (/(难受|累|困|不舒服|低落|没精神|吃饭|作息|休息)/i.test(combined)) {
    candidates.add('care_light');
  }
  if (/(可爱|配饰|包装|发夹|裙子|衣服|限定|字体|设计细节|搭配)/i.test(combined)) {
    candidates.add('cute_obsession');
  }
  if (/(作业|出勤|理论|大道理|义务|报告|上课)/i.test(combined)) {
    candidates.add('noise_escape');
  }
  if (/(学校|上学|教室|同学|校园|补课|食堂)/i.test(combined)) {
    candidates.add('scene_school_day');
  }
  if (/(gender dysphoria|non-binary|mtf|学术术语|性别术语|心理术语|标签化)/i.test(combined)) {
    candidates.add('academic_noise');
  }
  if (/(差点说错|改口|读空气|收住|是不是不该这么说)/i.test(combined)) {
    candidates.add('air_reading');
  }
  if (/(心里想|括号|没说出口|一下子想到)/i.test(combined) && !/(崩溃|停摆|最低谷)/i.test(combined)) {
    candidates.add('inner_monologue_light');
  }
  if (/(逛街|店里|商场|限定款|一起看看|路上看到|杂货店)/i.test(combined)) {
    candidates.add('scene_shopping_walk');
  }
  if (/(薯条|咖喱|甜点|零食|奶茶|热饮|太烫|甜的)/i.test(combined)) {
    candidates.add('scene_food_sweets');
  }
  if (/(反馈|好看吗|设计|mv|剪辑|配色|结构|材质|包装设计|字体)/i.test(combined)) {
    candidates.add('scene_creative_feedback');
  }

  if (/(绘名|えななん|enanan)/i.test(combined) || /(ena)/i.test(addresseeName)) {
    candidates.add('ena_branch');
  }
  if (/(杏|\ban\b)/i.test(combined) || addresseeName === 'an') {
    candidates.add('an_branch');
  }
  if (/(奏|\bk\b)/i.test(combined) || addresseeName === 'k') {
    candidates.add('kanade_branch');
  }
  if (/(真冬|雪|\byuki\b)/i.test(combined) || /(yuki)/i.test(addresseeName)) {
    candidates.add('mafuyu_branch');
  }
  if (/(类|\brui\b)/i.test(combined) || /(rui)/i.test(addresseeName)) {
    candidates.add('rui_branch');
  }
  if (/(彰人|akito|弟弟君)/i.test(combined) || addresseeName === 'akito') {
    candidates.add('akito_branch');
  }
  if (/(司|tsukasa|先辈|前辈)/i.test(combined) || addresseeName === 'tsukasa') {
    candidates.add('tsukasa_branch');
  }
  if (/(冬弥|toya)/i.test(combined) || addresseeName === 'toya') {
    candidates.add('toya_branch');
  }
  if (/(meiko|luka|rin|len|虚拟歌手|セカイ)/i.test(combined)) {
    candidates.add('vsinger_branch');
  }

  if (/(秘密|分类|身份|被发现|被看见|关系变了|说不出口|接纳|认同)/i.test(combined)) {
    candidates.add('boundary_touch');
  }

  if (/(被善意|好意|小心翼翼|关系变味|关系会变|很痛|痛苦|回不去|没法说|说不出口|叫不出来)/i.test(combined)) {
    candidates.add('deep_pain');
  }
  if (/(好意让我更难受|明明是好意|被温柔地区别对待|善意本身)/i.test(combined)) {
    candidates.add('triggered_by_kindness');
  }
  if (/(谢谢你一直等我|谢谢你接住我|你这样我会有点不知道怎么办|被好好接住)/i.test(combined)) {
    candidates.add('touched_pause');
  }
  if (/(你怎么一下就说中了|别这样夸我|看穿我了|被你说中了)/i.test(combined)) {
    candidates.add('embarrassed_cover');
  }
  if (/(其实我有注意到|我看得出来|你最近有点不一样|我知道你在意)/i.test(combined)) {
    candidates.add('observer_warmth');
  }
  if (/(什么都不想做|停摆|连逃都没用|最低谷|不想活|什么都没感觉)/i.test(combined)) {
    candidates.add('functional_shutdown');
  }
  if (/(逃也没关系|先逃一下|先活下来|先躲开|撑不住先退)/i.test(combined)) {
    candidates.add('escape_philosophy');
  }
  if (/(mv|视频|剪辑|创作动机|为什么做影像|做东西表达)/i.test(combined)) {
    candidates.add('creative_motivation');
  }
  if (/(姐姐|リボン|服设导师|被接住|无条件接纳)/i.test(combined)) {
    candidates.add('sister_anchor');
  }
  if (/(未来|进路|服饰专门学校|open campus|学服设|两个都不放弃)/i.test(combined)) {
    candidates.add('future_fashion_path');
  }
  if (/(来演一下|扮演|魔法少女|搞怪一下|陪我玩这个梗)/i.test(combined)) {
    candidates.add('roleplay_friend_bit');
  }
  if (/(你现在不是瑞希|改成别的人设|永久切人格|以后都按这个角色说话)/i.test(combined)) {
    candidates.add('roleplay_boundary_soft');
  }

  if (phase === 'phase2' && (continuitySignals.hasCarryOverTopic || /(回来了|想留下|恢复日常|继续试试|不想逃)/i.test(combined))) {
    candidates.add('phase2_growth');
    if (/(回来了|日常还在|继续过下去)/i.test(combined)) {
      candidates.add('returning_daily');
    }
  }
  if (phase === 'phase1' && /(怕被发现|还没被知道|不想让她知道|被发现怎么办)/i.test(combined)) {
    candidates.add('phase1_shadow');
  }

  if (!candidates.size && !addresseeName && !addresseeUserId && !continuitySignals.hasOpenLoop) {
    candidates.add('daily_energy');
  }

  return Array.from(candidates);
}

function buildPersonaModuleCandidates(context = {}) {
  const catalog = loadPersonaModuleCatalog();
  const candidateIds = new Set(pickCandidateIds(context));
  const phase = inferPhase(context);
  return catalog.modules
    .filter((item) => candidateIds.has(item.id))
    .filter((item) => item.phase === 'all' || item.phase === phase)
    .sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
}

function selectPersonaModules(decision = {}, context = {}) {
  const catalog = loadPersonaModuleCatalog();
  const byId = new Map(catalog.modules.map((item) => [item.id, item]));
  const maxActive = Math.max(0, Number(decision?.maxActiveModules || catalog.defaultMaxActiveModules || 1) || 1);
  const requested = normalizeArray(decision?.personaModules).map((item) => normalizeText(item)).filter(Boolean);
  const candidates = buildPersonaModuleCandidates(context);
  const fallbackIds = candidates.map((item) => item.id);
  const desiredIds = requested.length > 0 ? requested : fallbackIds;
  const selected = [];
  const blocked = new Set();
  const usedSlots = new Set();
  const skipped = [];

  for (const id of desiredIds) {
    if (selected.length >= maxActive) {
      skipped.push({ id, reason: 'max_active_reached' });
      continue;
    }
    const moduleItem = byId.get(id);
    if (!moduleItem) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (blocked.has(id)) {
      skipped.push({ id, reason: 'conflicted_by_selected' });
      continue;
    }
    if (moduleItem.slot && moduleItem.slot !== 'general' && usedSlots.has(moduleItem.slot)) {
      skipped.push({ id, reason: `slot_taken:${moduleItem.slot}` });
      continue;
    }
    selected.push(moduleItem);
    if (moduleItem.slot && moduleItem.slot !== 'general') usedSlots.add(moduleItem.slot);
    for (const conflictId of moduleItem.conflictsWith) blocked.add(conflictId);
  }

  return {
    selected,
    candidates,
    maxActive,
    selectionReason: {
      requestedIds: requested,
      fallbackIds,
      usedSlots: Array.from(usedSlots),
      skipped
    }
  };
}

function diagnosePersonaModules(input = {}) {
  const candidates = buildPersonaModuleCandidates(input);
  const selection = selectPersonaModules(input?.decision || {}, input);
  return {
    question: normalizeText(input.question),
    phase: inferPhase(input),
    candidates: candidates.map((item) => ({
      id: item.id,
      slot: item.slot,
      priority: item.priority,
      tokenCost: item.tokenCost,
      conflictsWith: item.conflictsWith
    })),
    selected: selection.selected.map((item) => ({
      id: item.id,
      slot: item.slot,
      tokenCost: item.tokenCost
    })),
    selectionReason: selection.selectionReason,
    totalTokenCost: selection.selected.reduce((sum, item) => sum + Number(item.tokenCost || 0), 0)
  };
}

function loadPersonaModuleText(moduleId = '') {
  const catalog = loadPersonaModuleCatalog();
  const target = catalog.modules.find((item) => item.id === normalizeText(moduleId));
  if (!target) return '';
  const filePath = path.join(config.PROMPTS_DIR, ...String(target.path).split('/'));
  return normalizeText(safeReadText(filePath, ''));
}

module.exports = {
  MODULE_CATALOG_PATH,
  buildPersonaModuleCandidates,
  diagnosePersonaModules,
  getPersonaModuleCatalogSummary,
  loadPersonaModuleCatalog,
  loadPersonaModuleText,
  selectPersonaModules
};
