const path = require('path');
const config = require('../../config');
const { sanitizeUserId, normalizeInsideRoot, mustStayInside } = require('../pathSafety');
const {
  normalizeArxivGetArgs,
  normalizeArxivLatestArgs,
  normalizeArxivSearchArgs,
  normalizeEarthquakeArgs,
  normalizeWeatherArgs,
  normalizeWeatherCloudArgs
} = require('./skillArgs');
const { createDynamicMcpArgNormalizer } = require('./dynamicMcp');
const {
  POLICY_VERSION,
  TOOL_POLICIES,
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy
} = require('./manifest');

const NOTEBOOK_ROOT = path.join(config.DATA_DIR, 'notebook');

function getToolRegistry() {
  return require('../../api/toolRegistry');
}

const {
  normalizeDynamicMcpArgs
} = createDynamicMcpArgNormalizer({
  getToolRegistry
});

function resolveNotebookUserId(args = {}, context = {}) {
  const requested = sanitizeUserId(args.userId ?? args.user_id);
  const fromContext = sanitizeUserId(context.userId);
  const effective = requested || fromContext;
  if (!effective) {
    throw new Error('Notebook tools require a scoped userId');
  }
  if (requested && fromContext && requested !== fromContext) {
    throw new Error('Notebook tools cannot access another user scope');
  }
  return effective;
}

function normalizeNotebookArgs(toolName, args = {}, context = {}) {
  const next = { ...args };
  const userId = resolveNotebookUserId(args, context);
  next.userId = userId;
  next.user_id = userId;

  if (toolName === 'notebook_reindex_folder') {
    const requestedFolder = String(args.folderPath ?? args.folder ?? '').trim();
    const defaultFolder = path.join(NOTEBOOK_ROOT, userId);
    const folderPath = requestedFolder || defaultFolder;
    next.folderPath = mustStayInside(path.join(NOTEBOOK_ROOT, userId), folderPath, 'Notebook folderPath');
    next.folder = next.folderPath;
  }

  if (toolName === 'notebook_add_document') {
    next.title = String(args.title || '').trim().slice(0, 120);
    next.content = String(args.content || '').trim();
    if (!next.title) throw new Error('notebook_add_document requires a title');
    if (!next.content) throw new Error('notebook_add_document requires content');
    if (next.content.length > 20000) throw new Error('notebook_add_document content too large');
  }

  if (toolName === 'notebook_search') {
    next.query = String(args.query || '').trim();
    if (!next.query) throw new Error('notebook_search requires query');
  }

  return next;
}

function normalizeSummarizeArgs(args = {}) {
  const next = { ...args };
  const rawInput = String(args.input ?? args.url ?? args.file ?? '').trim();
  if (!rawInput) throw new Error('skill_summarize requires input');

  if (!/^https?:\/\//i.test(rawInput)) {
    const resolved = mustStayInside(config.DATA_DIR, rawInput, 'Local summarize input');
    next.input = resolved;
    next.file = resolved;
  } else {
    next.input = rawInput;
  }

  return next;
}

function normalizeImageArgs(args = {}) {
  const next = { ...args };
  const prompt = String(args.prompt || '').trim();
  if (!prompt) throw new Error('skill_image_generate_pro requires prompt');

  if (args.filename) {
    const safeOutputDir = path.join(config.DATA_DIR, 'skill_cache', 'nano-banana-pro');
    next.filename = mustStayInside(safeOutputDir, args.filename, 'Image output path');
  }

  return next;
}

function normalizeMemoryCliArgs(args = {}) {
  const next = { ...args };
  next.command = String(args.command || '').trim();
  if (!next.command) throw new Error('memory_cli requires command');
  if (next.command.length > 1000) throw new Error('memory_cli command too long');
  return next;
}

function normalizeWebSearchArgs(args = {}) {
  const next = {};
  const query = String(args.query ?? args.keyword ?? args.q ?? '').trim();
  if (!query) throw new Error('web_search requires query');
  if (query.length > 300) throw new Error('web_search query too long');
  next.query = query;
  return next;
}

function normalizeWebFetchArgs(args = {}) {
  const next = {};
  const url = String(args.url ?? args.link ?? '').trim();
  if (!url) throw new Error('web_fetch requires url');
  if (url.length > 2048) throw new Error('web_fetch url too long');
  if (!/^https?:\/\//i.test(url)) throw new Error('web_fetch requires http/https url');
  next.url = url;
  return next;
}

function normalizeVisualRenderArgs(args = {}) {
  const renderer = String(args.renderer || '').trim().toLowerCase();
  const markup = String(args.markup || '').trim();
  if (!new Set(['svg', 'html']).has(renderer)) throw new Error('render_qq_visual renderer must be svg or html');
  if (!markup) throw new Error('render_qq_visual requires markup');
  if (markup.length > 100000) throw new Error('render_qq_visual markup too large');

  const normalized = { renderer, markup };
  if (args.width !== undefined) {
    const width = Number(args.width);
    if (!Number.isInteger(width) || width < 320 || width > 1200) {
      throw new Error('render_qq_visual width must be an integer between 320 and 1200');
    }
    normalized.width = width;
  }
  if (args.max_height !== undefined) {
    const maxHeight = Number(args.max_height);
    if (!Number.isInteger(maxHeight) || maxHeight < 200 || maxHeight > 2000) {
      throw new Error('render_qq_visual max_height must be an integer between 200 and 2000');
    }
    normalized.max_height = maxHeight;
  }
  return normalized;
}

function sanitizeToolArgsForLog(toolName = '', args = {}) {
  const sanitized = { ...(args && typeof args === 'object' ? args : {}) };
  delete sanitized.__context;
  if (String(toolName || '').trim() === 'render_qq_visual' && Object.prototype.hasOwnProperty.call(sanitized, 'markup')) {
    sanitized.markup = `[redacted markup ${String(sanitized.markup || '').length} chars]`;
  }
  return sanitized;
}

function normalizeSharedLinkArgs(args = {}) {
  const { parseSharedLinkUrl } = require('../../api/skills_native/sharedLink/url');
  const parsed = parseSharedLinkUrl(args.url);
  if (!parsed) throw new Error('read_shared_link requires a supported public URL');
  return { url: parsed.canonicalUrl || parsed.url };
}

function normalizeTimeArgs(args = {}) {
  const next = {};
  const timezone = String(args.timezone || '').trim();
  if (!timezone) {
    next.timezone = config.TIMEZONE;
    return next;
  }

  const safeTimezone = timezone.replace(/[^A-Za-z0-9_+\-/:]/g, '').slice(0, 80);
  next.timezone = safeTimezone || config.TIMEZONE;
  return next;
}

function normalizeContextStatsArgs(args = {}) {
  const next = {};
  const format = String(args.format || '').trim().toLowerCase();
  if (!format) return next;
  if (!new Set(['text']).has(format)) {
    throw new Error('get_context_stats format must be text');
  }
  next.format = format;
  return next;
}

function normalizeMaimaiArgs(toolName, args = {}) {
  const next = {};
  const query = String(args.query || '').trim();
  if (!query) throw new Error(`${toolName} requires query`);
  if (query.length > 300) throw new Error(`${toolName} query too long`);
  next.query = query;
  if (toolName === 'maimai_chart_search') {
    for (const [key, alias] of [['level_min', 'level_min'], ['level_max', 'level_max']]) {
      if (args[key] === undefined) continue;
      const value = Number(args[key]);
      if (!Number.isFinite(value) || value < 0 || value > 20) throw new Error(`${key} must be between 0 and 20`);
      next[alias] = value;
    }
    if (args.chart_type !== undefined) {
      const chartType = String(args.chart_type).trim().toUpperCase();
      if (!new Set(['SD', 'DX']).has(chartType)) throw new Error('chart_type must be SD or DX');
      next.chart_type = chartType;
    }
    if (args.difficulty !== undefined) next.difficulty = String(args.difficulty).trim().slice(0, 20);
  }
  if (toolName === 'maimai_chart_analyze') {
    if (args.title !== undefined) next.title = String(args.title).trim().slice(0, 160);
    if (args.chart_type !== undefined) {
      const chartType = String(args.chart_type).trim().toUpperCase();
      if (!new Set(['SD', 'DX']).has(chartType)) throw new Error('chart_type must be SD or DX');
      next.chart_type = chartType;
    }
    if (args.difficulty !== undefined) next.difficulty = String(args.difficulty).trim().slice(0, 20);
  }
  if (toolName === 'maimai_player_analysis' && args.focus !== undefined) {
    next.focus = String(args.focus).trim().slice(0, 80);
  }
  if (args.limit !== undefined) {
    const limit = Number(args.limit);
    const max = toolName === 'maimai_player_analysis' ? 50 : 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new Error(`limit must be between 1 and ${max}`);
    next.limit = limit;
  }
  return next;
}

function normalizePjskArgs(toolName, args = {}) {
  const query = String(args.query || '').trim();
  if (!query) throw new Error(`${toolName} requires query`);
  if (query.length > 300) throw new Error(`${toolName} query too long`);
  const next = { query };
  if (args.difficulty !== undefined) {
    const difficulty = String(args.difficulty).trim().toLowerCase();
    if (!new Set(['easy', 'normal', 'hard', 'expert', 'master', 'append']).has(difficulty)) {
      throw new Error('invalid PJSK difficulty');
    }
    next.difficulty = difficulty;
  }
  if (toolName === 'pjsk_song_search') {
    for (const key of ['level_min', 'level_max']) {
      if (args[key] === undefined) continue;
      const value = Number(args[key]);
      if (!Number.isFinite(value) || value < 1 || value > 40) throw new Error(`${key} must be between 1 and 40`);
      next[key] = value;
    }
    if (args.limit !== undefined) {
      const limit = Number(args.limit);
      if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error('limit must be between 1 and 10');
      next.limit = limit;
    }
  }
  if (toolName === 'pjsk_chart_analyze' && args.title !== undefined) {
    next.title = String(args.title).trim().slice(0, 160);
  }
  return next;
}

function normalizeSelfImprovementArgs(toolName, args = {}) {
  if (toolName === 'self_improvement_recent') {
    const next = {};
    next.limit = Math.max(1, Math.min(50, Number(args.limit) || 10));
    if (args.kind) next.kind = String(args.kind).trim().toLowerCase();
    if (args.status) next.status = String(args.status).trim().toLowerCase();
    return next;
  }

  if (toolName === 'self_improvement_search') {
    const query = String(args.query || '').trim();
    if (!query) throw new Error('self_improvement_search requires query');
    if (query.length > 300) throw new Error('self_improvement_search query too long');
    return {
      query,
      top_k: Math.max(1, Math.min(20, Number(args.top_k) || 5)),
      kind: args.kind ? String(args.kind).trim().toLowerCase() : undefined,
      promoted_only: Boolean(args.promoted_only)
    };
  }

  if (toolName === 'self_improvement_patterns') {
    return {
      limit: Math.max(1, Math.min(50, Number(args.limit) || 10)),
      route_policy_key: args.route_policy_key ? String(args.route_policy_key).trim() : undefined,
      tool_name: args.tool_name ? String(args.tool_name).trim() : undefined
    };
  }

  if (toolName === 'self_improvement_rules') {
    return {
      limit: Math.max(1, Math.min(50, Number(args.limit) || 10)),
      pattern_key: args.pattern_key ? String(args.pattern_key).trim() : undefined,
      top_route_type: args.top_route_type ? String(args.top_route_type).trim() : undefined,
      tool_name: args.tool_name ? String(args.tool_name).trim() : undefined
    };
  }

  if (toolName === 'self_improvement_guides') {
    return {
      limit: Math.max(1, Math.min(50, Number(args.limit) || 10)),
      pattern_key: args.pattern_key ? String(args.pattern_key).trim() : undefined,
      active_only: args.active_only === undefined ? true : Boolean(args.active_only)
    };
  }

  return { ...args };
}

function normalizeTaskIdArgs(args = {}, key = 'job_id') {
  const value = String(args[key] ?? args.jobId ?? '').trim();
  if (!value) throw new Error(`${key} is required`);
  if (value.length > 80) throw new Error(`${key} too long`);
  if (/[\r\n\u0000-\u001f]/.test(value)) throw new Error(`${key} contains unsafe characters`);
  return { [key]: value };
}

function normalizeQqActionArgs(toolName, args = {}) {
  if (toolName === 'publish_qzone' || toolName === 'qzone_draft') {
    const content = String(args.content || '').trim();
    const mode = String(args.mode || (content ? 'manual' : 'agent')).trim().toLowerCase();
    const hint = String(args.hint || '').trim();
    if (!content && !hint && mode === 'manual') throw new Error(`${toolName} requires content or hint`);
    if (content.length > 5000) throw new Error(`${toolName} content too large`);
    if (hint.length > 5000) throw new Error(`${toolName} hint too large`);
    return {
      content,
      mode: new Set(['manual', 'bot_diary', 'agent', 'generic_autodraft']).has(mode) ? mode : 'agent',
      hint
    };
  }

  if (toolName === 'schedule_group_message') {
    const message = String(args.message || '').trim();
    const when = String(args.when || '').trim();
    if (!message) throw new Error('schedule_group_message requires message');
    if (!when) throw new Error('schedule_group_message requires when');
    if (message.length > 5000) throw new Error('schedule_group_message message too large');
    return { message, when };
  }

  if (toolName === 'create_scheduled_command' || toolName === 'create_qzone_auto_task') {
    const action = String(args.action || '').trim();
    const when = String(args.when || '').trim();
    const content = String(args.content || '').trim();
    const hint = String(args.hint || '').trim();
    const mode = String(args.mode || '').trim().toLowerCase();
    const normalizedAction = toolName === 'create_qzone_auto_task' ? 'qzone_post' : action;
    if (!normalizedAction) throw new Error(`${toolName} requires action`);
    if (!when) throw new Error(`${toolName} requires when`);
    if (normalizedAction === 'group_message' && !content) throw new Error(`${toolName} requires content`);
    if (normalizedAction === 'qzone_post' && content.length > 5000) throw new Error(`${toolName} content too large`);
    if (hint.length > 5000) throw new Error(`${toolName} hint too large`);
    if (!new Set(['group_message', 'qzone_post']).has(normalizedAction)) {
      throw new Error('create_scheduled_command action must be group_message or qzone_post');
    }
    if (content.length > 5000) throw new Error(`${toolName} content too large`);
    return {
      action: normalizedAction,
      when,
      content,
      mode: new Set(['manual', 'bot_diary', 'agent', 'generic_autodraft']).has(mode) ? mode : (normalizedAction === 'qzone_post' ? 'agent' : ''),
      hint
    };
  }

  if (toolName === 'list_scheduled_tasks') {
    const scope = String(args.scope || 'mine').trim().toLowerCase() || 'mine';
    if (!new Set(['mine', 'all']).has(scope)) {
      throw new Error('list_scheduled_tasks scope must be mine or all');
    }
    return { scope };
  }

  if (toolName === 'cancel_scheduled_task') {
    return normalizeTaskIdArgs(args, 'job_id');
  }

  if (toolName === 'delete_scheduled_task') {
    return normalizeTaskIdArgs(args, 'job_id');
  }

  return { ...args };
}

function normalizeCompanionFollowupArgs(args = {}) {
  const action = String(args.action || '').trim().toLowerCase();
  if (!new Set(['add', 'list', 'complete', 'snooze', 'abandon', 'delete']).has(action)) {
    throw new Error('companion_followup action 无效');
  }
  const next = { action };
  if (action === 'add') {
    const title = String(args.title || '').trim();
    if (!title) throw new Error('companion_followup add requires title');
    if (title.length > 160) throw new Error('companion_followup title too long');
    next.title = title;
    next.note = String(args.note || '').trim().slice(0, 500);
    next.due_at = String(args.due_at || args.dueAt || '').trim();
    return next;
  }
  if (action === 'list') {
    next.include_closed = Boolean(args.include_closed);
    return next;
  }
  const id = String(args.id || '').trim();
  if (!id || id.length > 80 || /[\r\n\u0000-\u001f]/.test(id)) {
    throw new Error('companion_followup requires a valid id');
  }
  next.id = id;
  if (action === 'snooze') {
    next.due_at = String(args.due_at || args.dueAt || args.when || '').trim();
    if (!next.due_at) throw new Error('companion_followup snooze requires due_at');
  }
  return next;
}

function normalizeCompanionReviewArgs(args = {}) {
  const range = String(args.range || '').trim().toLowerCase();
  if (!new Set(['today', 'yesterday', 'week']).has(range)) {
    throw new Error('companion_review range 无效');
  }
  return { range };
}

function normalizeCompanionMemoryArgs(args = {}) {
  const action = String(args.action || '').trim().toLowerCase();
  if (!new Set(['list', 'remember', 'correct', 'forget', 'settings', 'set_auto']).has(action)) {
    throw new Error('companion_memory action 无效');
  }
  if (action === 'list') {
    return {
      action,
      limit: Math.max(1, Math.min(50, Number(args.limit || 20) || 20)),
      query: String(args.query || '').trim().slice(0, 200)
    };
  }
  if (action === 'settings') return { action };
  if (action === 'set_auto') {
    if (typeof args.enabled !== 'boolean') throw new Error('companion_memory set_auto requires enabled');
    return { action, enabled: args.enabled };
  }
  const next = { action };
  if (action === 'correct' || action === 'forget') {
    next.id = String(args.id || '').trim();
    if (!next.id || next.id.length > 100 || /[\r\n\u0000-\u001f]/.test(next.id)) {
      throw new Error('companion_memory requires a valid id');
    }
  }
  if (action === 'remember' || action === 'correct') {
    next.text = String(args.text || '').replace(/\s+/g, ' ').trim();
    if (!next.text) throw new Error('companion_memory requires text');
    if (next.text.length > 1000) throw new Error('companion_memory text too long');
  }
  return next;
}

function enforceToolPolicy(toolName, args = {}, context = {}) {
  if (
    toolName === 'notebook_reindex_folder' ||
    toolName === 'notebook_add_document' ||
    toolName === 'notebook_list_docs' ||
    toolName === 'notebook_search'
  ) {
    return normalizeNotebookArgs(toolName, args, context);
  }

  if (toolName === 'skill_summarize') {
    return normalizeSummarizeArgs(args);
  }

  if (toolName === 'skill_image_generate_pro') {
    return normalizeImageArgs(args);
  }

  if (toolName === 'render_qq_visual') {
    return normalizeVisualRenderArgs(args);
  }

  if (toolName === 'memory_cli') {
    return normalizeMemoryCliArgs(args, context);
  }

  if (toolName === 'web_search') {
    return normalizeWebSearchArgs(args);
  }

  if (
    toolName === 'web_fetch' ||
    toolName === 'skill_brave_extract' ||
    toolName === 'skill_tavily_extract'
  ) {
    return normalizeWebFetchArgs(args);
  }

  if (toolName === 'read_shared_link') {
    return normalizeSharedLinkArgs(args);
  }

  if (toolName === 'get_current_time') {
    return normalizeTimeArgs(args);
  }

  if (toolName === 'get_context_stats') {
    return normalizeContextStatsArgs(args);
  }

  if (
    toolName === 'maimai_chart_search'
    || toolName === 'maimai_chart_analyze'
    || toolName === 'maimai_player_analysis'
  ) {
    return normalizeMaimaiArgs(toolName, args);
  }

  if (toolName === 'pjsk_song_search' || toolName === 'pjsk_chart_analyze') {
    return normalizePjskArgs(toolName, args);
  }

  if (
    toolName === 'self_improvement_recent'
    || toolName === 'self_improvement_search'
    || toolName === 'self_improvement_patterns'
    || toolName === 'self_improvement_rules'
    || toolName === 'self_improvement_guides'
  ) {
    return normalizeSelfImprovementArgs(toolName, args);
  }

  if (
    toolName === 'publish_qzone' ||
    toolName === 'qzone_draft' ||
    toolName === 'schedule_group_message' ||
    toolName === 'create_qzone_auto_task' ||
    toolName === 'create_scheduled_command' ||
    toolName === 'list_scheduled_tasks' ||
    toolName === 'cancel_scheduled_task' ||
    toolName === 'delete_scheduled_task'
  ) {
    return normalizeQqActionArgs(toolName, args);
  }

  if (toolName === 'companion_followup') {
    return normalizeCompanionFollowupArgs(args);
  }

  if (toolName === 'companion_memory') {
    return normalizeCompanionMemoryArgs(args);
  }

  if (toolName === 'companion_review') {
    return normalizeCompanionReviewArgs(args);
  }

  if (toolName === 'skill_weather') {
    return normalizeWeatherArgs(args);
  }

  if (toolName === 'skill_earthquake_latest') {
    return normalizeEarthquakeArgs(args);
  }

  if (toolName === 'skill_weather_cloud') {
    return normalizeWeatherCloudArgs(args);
  }

  if (toolName === 'skill_arxiv_search') {
    return normalizeArxivSearchArgs(args);
  }

  if (toolName === 'skill_arxiv_get') {
    return normalizeArxivGetArgs(args);
  }

  if (toolName === 'skill_arxiv_latest') {
    return normalizeArxivLatestArgs(args);
  }

  if (String(toolName || '').startsWith('mcp_')) {
    return normalizeDynamicMcpArgs(toolName, args);
  }

  return { ...args };
}

module.exports = {
  NOTEBOOK_ROOT,
  POLICY_VERSION,
  TOOL_POLICIES,
  getPolicy,
  hasPublicToolPolicy,
  resolveToolPolicy,
  sanitizeToolArgsForLog,
  sanitizeUserId,
  enforceToolPolicy,
  mustStayInside,
  normalizeInsideRoot
};
