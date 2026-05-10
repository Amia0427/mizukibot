const { normalizeToolNames } = require('./localToolAccess');

const COMPANION_TOOL_PRESET = Object.freeze([
  'memory_cli',
  'get_current_time',
  'get_context_stats',
  'url_safety_check',
  'getWeather',
  'skill_weather',
  'notebook_search',
  'notebook_list_docs',
  'notebook_append_journal',
  'notebook_read_recent_journal',
  'create_scheduled_command',
  'list_scheduled_tasks',
  'cancel_scheduled_task'
]);

const COMPANION_PLANNER_SAFE_READ_TOOLS = Object.freeze([
  'getWeather',
  'skill_weather',
  'get_current_time',
  'get_context_stats',
  'memory_cli',
  'notebook_search',
  'notebook_list_docs',
  'url_safety_check'
]);

function parseToolList(value = '') {
  if (Array.isArray(value)) return normalizeToolNames(value);
  return normalizeToolNames(String(value || '').split(',').map((item) => item.trim()));
}

function isCompanionToolModeEnabled(config = {}) {
  const mode = String(config.BOT_TOOL_MODE || config.TOOL_MODE || '').trim().toLowerCase();
  if (mode) return mode === 'companion' || mode === 'chat_companion';
  return config.COMPANION_TOOL_MODE_ENABLED === true;
}

function getCompanionAllowedTools(config = {}) {
  const configured = parseToolList(config.COMPANION_ALLOWED_TOOLS);
  return configured.length > 0 ? configured : [...COMPANION_TOOL_PRESET];
}

function filterCompanionAllowedTools(toolNames = [], config = {}) {
  const normalized = normalizeToolNames(toolNames);
  if (!isCompanionToolModeEnabled(config)) return normalized;
  const allowedSet = new Set(getCompanionAllowedTools(config));
  return normalized.filter((toolName) => allowedSet.has(toolName));
}

function filterCompanionToolSchemas(schemas = [], config = {}) {
  if (!isCompanionToolModeEnabled(config)) return Array.isArray(schemas) ? schemas : [];
  const allowedSet = new Set(getCompanionAllowedTools(config));
  return (Array.isArray(schemas) ? schemas : []).filter((schema) => {
    const toolName = String(schema?.function?.name || '').trim();
    return allowedSet.has(toolName);
  });
}

function filterCompanionToolExecutors(executors = {}, config = {}) {
  if (!executors || typeof executors !== 'object') return {};
  if (!isCompanionToolModeEnabled(config)) return executors;
  const allowedSet = new Set(getCompanionAllowedTools(config));
  return Object.fromEntries(
    Object.entries(executors).filter(([toolName]) => allowedSet.has(String(toolName || '').trim()))
  );
}

module.exports = {
  COMPANION_PLANNER_SAFE_READ_TOOLS,
  COMPANION_TOOL_PRESET,
  filterCompanionAllowedTools,
  filterCompanionToolExecutors,
  filterCompanionToolSchemas,
  getCompanionAllowedTools,
  isCompanionToolModeEnabled,
  parseToolList
};
