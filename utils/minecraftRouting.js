const config = require('../config');

const MC_INTENT_REGEX = /(?:\bminecraft\b|(?:^|[^a-z])mc(?:[^a-z]|$)|我的世界|方块|末地|下界|主世界|苦力怕|僵尸|附魔|熔炉|工作台|背包|坐标|传送|寻路|跟随玩家|minecraft_)/i;

function isMinecraftIntent(text = '', routePrompt = '') {
  const merged = `${String(text || '')}\n${String(routePrompt || '')}`.trim();
  if (!merged) return false;
  return MC_INTENT_REGEX.test(merged);
}

function shouldUseMinecraftLLM(text = '', routePrompt = '') {
  if (!config.MC_USE_SEPARATE_LLM) return false;
  if (!isMinecraftIntent(text, routePrompt)) return false;
  if (!String(config.MC_API_BASE_URL || '').trim()) return false;
  if (!String(config.MC_AI_MODEL || '').trim()) return false;
  return true;
}

function getMinecraftModelOverrides() {
  // Keep API key fallback so users can omit MC_API_KEY when reusing API_KEY.
  const overrides = {
    apiBaseUrl: String(config.MC_API_BASE_URL || '').trim(),
    apiKey: String(config.MC_API_KEY || config.API_KEY || '').trim(),
    model: String(config.MC_AI_MODEL || '').trim()
  };

  if (Number.isFinite(Number(config.MC_AI_TEMPERATURE))) {
    overrides.temperature = Number(config.MC_AI_TEMPERATURE);
  }
  if (Number.isFinite(Number(config.MC_AI_TOP_P))) {
    overrides.topP = Number(config.MC_AI_TOP_P);
  }
  if (Number.isFinite(Number(config.MC_AI_MAX_TOKENS))) {
    overrides.maxTokens = Number(config.MC_AI_MAX_TOKENS);
  }

  return overrides;
}

module.exports = {
  isMinecraftIntent,
  shouldUseMinecraftLLM,
  getMinecraftModelOverrides
};
