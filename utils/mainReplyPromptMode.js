const WORLD_BOOK_LORE_QUERY_RE = /(世界观|世界书|设定|剧情|剧情节点|事件|角色关系|文化祭|m[1-9]|e5|n25|nightcord|服饰专门学校|open campus|面具|裂缝)/i;
const WORLD_BOOK_CHARACTER_RE = /(瑞希|晓山|真冬|绘名|奏|ena|mafuyu|kanade|mizuki)/i;
const WORLD_BOOK_CHARACTER_CONTEXT_RE = /(关系|过去|未来|身份|秘密|故事|剧情|事件|设定|世界观|文化祭|服饰|专门学校|open campus|n25|nightcord|面具|裂缝|mv|剪辑|服装|搭配|表达|创作|安全通道|发生了什么|怎么变|为什么)/i;
const CASUAL_ONLY_RE = /^(随便聊聊|随便聊|闲聊|今天好累|有点累|好累|累死了|哈哈|在吗|你好|早|晚安|睡了|吃饭了吗|嗯嗯|哦哦|好呀|可以呀)[。！？!?~～\s]*$/i;
const STYLE_DIAGNOSTIC_RE = /(风格诊断|风格测试|回归测试|few[-_ ]?shot|示例对话|对话示例|模仿这个例子|按这个例子|复杂输出格式|json\s*格式|json格式|固定格式|表格|markdown|yaml|xml)/i;
const EMOTION_MODULE_IDS = new Set([
  'care_light',
  'boundary_touch',
  'deep_pain',
  'functional_shutdown',
  'triggered_by_kindness',
  'touched_pause',
  'embarrassed_cover',
  'observer_warmth',
  'escape_philosophy',
  'inner_monologue_light'
]);

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizePromptMode(value = '') {
  const mode = normalizeText(value || getConfigValue('MAIN_REPLY_PROMPT_MODE') || 'balanced').toLowerCase();
  if (mode === 'minimal' || mode === 'legacy') return mode;
  return 'balanced';
}

function getConfigValue(key) {
  try {
    return require('../config')[key];
  } catch (_) {
    return undefined;
  }
}

function isLegacyPromptMode(value = '') {
  return normalizePromptMode(value) === 'legacy';
}

function isBalancedOrMinimalPromptMode(value = '') {
  return normalizePromptMode(value) !== 'legacy';
}

function resolveMainReplyPromptMode(options = {}) {
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  return normalizePromptMode(
    options.mainReplyPromptMode
    || options.promptMode
    || routeMeta.mainReplyPromptMode
    || routeMeta.promptMode
    || getConfigValue('MAIN_REPLY_PROMPT_MODE')
  );
}

function isLikelyWorldbookQuery(input = {}) {
  const text = normalizeText([
    input.question,
    input.routePrompt,
    input.query
  ].filter(Boolean).join('\n'));
  if (!text) return false;
  if (CASUAL_ONLY_RE.test(text)) return false;
  if (WORLD_BOOK_LORE_QUERY_RE.test(text)) return true;
  return WORLD_BOOK_CHARACTER_RE.test(text) && WORLD_BOOK_CHARACTER_CONTEXT_RE.test(text);
}

function shouldUseWorldbookSearch(input = {}) {
  if (input.forceWorldbook === true || input.worldbookForce === true) return true;
  if (isLegacyPromptMode(input.mainReplyPromptMode || input.promptMode)) return true;
  return isLikelyWorldbookQuery(input);
}

function shouldBuildDynamicFewShot(input = {}) {
  if (input.forceDynamicFewShot === true || input.dynamicFewShotEnabled === true) return true;
  if (isLegacyPromptMode(input.mainReplyPromptMode || input.promptMode)) return true;
  if (Array.isArray(input.preferredExampleIds) && input.preferredExampleIds.some((item) => normalizeText(item))) return true;
  if (Array.isArray(input.activeWorldbookIds) && input.activeWorldbookIds.some((item) => normalizeText(item))) return true;
  const text = normalizeText([
    input.question,
    input.routePrompt,
    input.routePolicyKey,
    input.topRouteType
  ].filter(Boolean).join('\n'));
  return STYLE_DIAGNOSTIC_RE.test(text);
}

function getDefaultPersonaModuleLimit(mode = '') {
  return isBalancedOrMinimalPromptMode(mode) ? 2 : 0;
}

function isEmotionPersonaModule(moduleId = '') {
  return EMOTION_MODULE_IDS.has(normalizeText(moduleId));
}

module.exports = {
  getDefaultPersonaModuleLimit,
  isBalancedOrMinimalPromptMode,
  isEmotionPersonaModule,
  isLikelyWorldbookQuery,
  isLegacyPromptMode,
  normalizePromptMode,
  resolveMainReplyPromptMode,
  shouldBuildDynamicFewShot,
  shouldUseWorldbookSearch
};
