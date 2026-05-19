const path = require('path');
const config = require('../config');
const { sanitizeUserId, normalizeInsideRoot, mustStayInside } = require('./pathSafety');
const {
  normalizeArxivGetArgs,
  normalizeArxivLatestArgs,
  normalizeArxivSearchArgs,
  normalizeWeatherArgs
} = require('./toolPolicy/skillArgs');
const { createDynamicMcpArgNormalizer } = require('./toolPolicy/dynamicMcp');

const NOTEBOOK_ROOT = path.join(config.DATA_DIR, 'notebook');

function getToolRegistry() {
  return require('../api/toolRegistry');
}

const {
  normalizeDynamicMcpArgs
} = createDynamicMcpArgNormalizer({
  getToolRegistry
});

const TOOL_POLICIES = {
  notebook_reindex_folder: { risk: 'high', capability: 'fs_read' },
  notebook_add_document: { risk: 'medium', capability: 'fs_write' },
  notebook_list_docs: { risk: 'medium', capability: 'fs_read' },
  notebook_search: { risk: 'medium', capability: 'fs_read' },
  memory_cli: { risk: 'medium', capability: 'memory_read' },
  get_context_stats: { risk: 'low', capability: 'general' },
  self_improvement_recent: { risk: 'low', capability: 'memory_read' },
  self_improvement_search: { risk: 'low', capability: 'memory_read' },
  self_improvement_patterns: { risk: 'low', capability: 'memory_read' },
  self_improvement_rules: { risk: 'low', capability: 'memory_read' },
  self_improvement_guides: { risk: 'low', capability: 'memory_read' },
  web_search: { risk: 'medium', capability: 'network' },
  web_fetch: { risk: 'medium', capability: 'network' },
  get_current_time: { risk: 'low', capability: 'general' },
  skill_weather: { risk: 'medium', capability: 'network' },
  notebook_append_journal: { risk: 'medium', capability: 'fs_write' },
  notebook_read_recent_journal: { risk: 'low', capability: 'fs_read' },
  skill_summarize: { risk: 'medium', capability: 'network_or_file' },
  skill_youtube_transcript: { risk: 'medium', capability: 'network' },
  skill_web_search: { risk: 'medium', capability: 'network' },
  skill_arxiv_search: { risk: 'medium', capability: 'network' },
  skill_arxiv_get: { risk: 'medium', capability: 'network' },
  skill_arxiv_latest: { risk: 'medium', capability: 'network' },
  skill_brave_search: { risk: 'medium', capability: 'network' },
  skill_tavily_search: { risk: 'medium', capability: 'network' },
  skill_brave_extract: { risk: 'medium', capability: 'network' },
  skill_tavily_extract: { risk: 'medium', capability: 'network' },
  skill_stock_price_query: { risk: 'medium', capability: 'network' },
  skill_ontology_graph: { risk: 'medium', capability: 'fs_write' },
  qzone_draft: { risk: 'medium', capability: 'local_write' },
  publish_qzone: { risk: 'medium', capability: 'local_write' },
  schedule_group_message: { risk: 'medium', capability: 'local_write' },
  create_qzone_auto_task: { risk: 'high', capability: 'local_write' },
  create_scheduled_command: { risk: 'medium', capability: 'local_write' },
  list_scheduled_tasks: { risk: 'medium', capability: 'local_read' },
  cancel_scheduled_task: { risk: 'medium', capability: 'local_write' },
  delete_scheduled_task: { risk: 'medium', capability: 'local_write' },
  skill_image_generate_pro: { risk: 'high', capability: 'fs_write' },
  minecraft_connect: { risk: 'high', capability: 'network' },
  minecraft_disconnect: { risk: 'medium', capability: 'network' },
  minecraft_status: { risk: 'low', capability: 'network' },
  minecraft_chat: { risk: 'medium', capability: 'network' },
  minecraft_move_to: { risk: 'medium', capability: 'network' },
  minecraft_follow_player: { risk: 'medium', capability: 'network' },
  minecraft_look_at: { risk: 'low', capability: 'network' },
  minecraft_stop: { risk: 'low', capability: 'network' }
};

function getPolicy(toolName) {
  if (String(toolName || '').startsWith('mcp_')) {
    return { risk: 'medium', capability: 'network' };
  }
  return TOOL_POLICIES[toolName] || { risk: 'low', capability: 'general' };
}

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

  if (toolName === 'get_current_time') {
    return normalizeTimeArgs(args);
  }

  if (toolName === 'get_context_stats') {
    return normalizeContextStatsArgs(args);
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

  if (toolName === 'skill_weather') {
    return normalizeWeatherArgs(args);
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
  TOOL_POLICIES,
  getPolicy,
  sanitizeUserId,
  enforceToolPolicy,
  mustStayInside,
  normalizeInsideRoot
};
