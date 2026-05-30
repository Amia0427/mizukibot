const { getToolNames, getToolSchemas, getDynamicToolDescriptors } = require('../api/toolRegistry');
const { GLOBAL_TOOL_NAME_SET } = require('../api/globalToolRuntime');
const { normalizeToolNames } = require('../utils/localToolAccess');
const { getPolicy } = require('../utils/toolPolicy');
const { isAdminUser } = require('../api/qqActionService');
const EXCLUDED_DIRECT_CHAT_TOOL_NAMES = new Set([
  'assistant_task_breakdown'
]);

function isExcludedDirectChatTool(toolName = '') {
  const normalized = String(toolName || '').trim().toLowerCase();
  if (!normalized) return true;
  if (EXCLUDED_DIRECT_CHAT_TOOL_NAMES.has(normalized)) return true;
  if (/^mcp_memos_api_mcp_/i.test(normalized)) return true;
  return false;
}

function resolveToolBucket(toolName = '') {
  const normalized = String(toolName || '').trim();
  if (!normalized) return 'local_tools';
  if (/^mcp_/i.test(normalized)) return 'mcp';
  if (/^skill_/i.test(normalized)) return 'skills';
  if (GLOBAL_TOOL_NAME_SET.has(normalized)) return 'global_tools';
  return 'local_tools';
}

function isWriteCapablePolicy(policy = {}) {
  const capability = String(policy?.capability || '').trim().toLowerCase();
  return capability.includes('write');
}

const TOOL_PLANNER_METADATA = Object.freeze({
  get_current_time: {
    plannerRole: 'time_authority',
    overlapGroup: 'time',
    preferWhen: ['current time questions', 'timezone-aware time lookup'],
    avoidWhen: ['general web lookup'],
    preferredOver: ['web_search']
  },
  get_context_stats: {
    plannerRole: 'context_inspector',
    overlapGroup: 'context_stats',
    preferWhen: ['context usage questions', 'token or remaining context checks'],
    avoidWhen: ['general memory recall'],
    preferredOver: ['web_search', 'memory_cli']
  },
  memory_cli: {
    plannerRole: 'continuity_memory',
    overlapGroup: 'memory',
    preferWhen: ['conversation continuity recall', 'long-term memory lookup'],
    avoidWhen: ['notebook document lookup'],
    preferredOver: ['notebook_search']
  },
  notebook_search: {
    plannerRole: 'notebook_lookup',
    overlapGroup: 'notebook',
    preferWhen: ['notebook knowledge lookup', 'personal document search'],
    avoidWhen: ['conversation continuity recall'],
    preferredOver: ['memory_cli', 'web_search']
  },
  notebook_list_docs: {
    plannerRole: 'notebook_listing',
    overlapGroup: 'notebook',
    preferWhen: ['list notebook documents', 'show notebook inventory'],
    avoidWhen: ['fact lookup inside notebook content'],
    preferredOver: ['notebook_search', 'memory_cli']
  },
  web_search: {
    plannerRole: 'general_web_search',
    overlapGroup: 'web_lookup',
    preferWhen: ['general web lookup', 'latest public web facts'],
    avoidWhen: ['explicit URL fetch', 'weather or finance specialist queries'],
    preferredOver: []
  },
  web_fetch: {
    plannerRole: 'page_fetch',
    overlapGroup: 'web_fetch',
    preferWhen: ['explicit URL input', 'page detail fetch', 'full-text extraction'],
    avoidWhen: ['source discovery when no URL is known'],
    preferredOver: ['web_search']
  },
  getWeather: {
    plannerRole: 'legacy_weather',
    overlapGroup: 'weather',
    preferWhen: ['weather fallback only'],
    avoidWhen: ['when skill_weather is available'],
    preferredOver: []
  },
  skill_weather: {
    plannerRole: 'weather_specialist',
    overlapGroup: 'weather',
    preferWhen: ['weather requests', 'current conditions lookup'],
    avoidWhen: ['non-weather factual lookup'],
    preferredOver: ['getWeather', 'web_search']
  },
  search_academic_paper: {
    plannerRole: 'generic_academic_search',
    overlapGroup: 'academic_search',
    preferWhen: ['generic paper search'],
    avoidWhen: ['explicit arxiv requests'],
    preferredOver: []
  },
  skill_arxiv_search: {
    plannerRole: 'arxiv_search',
    overlapGroup: 'academic_search',
    preferWhen: ['explicit arxiv search'],
    avoidWhen: ['explicit arxiv id fetch'],
    preferredOver: ['search_academic_paper']
  },
  skill_arxiv_get: {
    plannerRole: 'arxiv_fetch',
    overlapGroup: 'academic_search',
    preferWhen: ['explicit arxiv id fetch'],
    avoidWhen: ['broad discovery queries'],
    preferredOver: ['skill_arxiv_search', 'search_academic_paper']
  },
  skill_arxiv_latest: {
    plannerRole: 'arxiv_latest',
    overlapGroup: 'academic_search',
    preferWhen: ['latest or recent arxiv requests'],
    avoidWhen: ['explicit arxiv id fetch'],
    preferredOver: ['skill_arxiv_search', 'search_academic_paper']
  },
  skill_stock_price_query: {
    plannerRole: 'finance_quote',
    overlapGroup: 'finance',
    preferWhen: ['real-time quote', 'price lookup', 'market price'],
    avoidWhen: ['portfolio management', 'dividend-only requests'],
    preferredOver: ['web_search']
  },
  skill_stock_analyze: {
    plannerRole: 'finance_analysis',
    overlapGroup: 'finance',
    preferWhen: ['stock analysis', 'outlook', 'valuation'],
    avoidWhen: ['quote-only requests'],
    preferredOver: ['skill_stock_price_query', 'web_search']
  },
  skill_stock_dividend: {
    plannerRole: 'finance_dividend',
    overlapGroup: 'finance',
    preferWhen: ['dividend or yield lookup'],
    avoidWhen: ['quote-only requests'],
    preferredOver: ['skill_stock_analyze', 'web_search']
  },
  skill_stock_rumor: {
    plannerRole: 'finance_rumor',
    overlapGroup: 'finance',
    preferWhen: ['rumor scan', 'market rumor or sentiment requests'],
    avoidWhen: ['quote-only requests'],
    preferredOver: ['web_search']
  },
  skill_stock_watchlist: {
    plannerRole: 'finance_watchlist',
    overlapGroup: 'finance_action',
    preferWhen: ['watchlist management', 'stock alerts'],
    avoidWhen: ['portfolio holdings management'],
    preferredOver: ['web_search']
  },
  skill_stock_portfolio: {
    plannerRole: 'finance_portfolio',
    overlapGroup: 'finance_action',
    preferWhen: ['portfolio management', 'holdings updates'],
    avoidWhen: ['watchlist-only requests'],
    preferredOver: ['web_search']
  },
  qzone_draft: {
    plannerRole: 'qq_qzone_draft',
    overlapGroup: 'qq_action',
    preferWhen: ['qzone draft or publish requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  publish_qzone: {
    plannerRole: 'qq_qzone_draft_alias',
    overlapGroup: 'qq_action',
    preferWhen: ['legacy qzone publish requests that should become drafts'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  schedule_group_message: {
    plannerRole: 'qq_group_schedule',
    overlapGroup: 'qq_action',
    preferWhen: ['group schedule message requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  create_scheduled_command: {
    plannerRole: 'qq_group_command_schedule',
    overlapGroup: 'qq_action',
    preferWhen: ['scheduled group command or qzone action requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  create_qzone_auto_task: {
    plannerRole: 'qq_qzone_auto_schedule',
    overlapGroup: 'qq_action',
    preferWhen: ['scheduled qzone action requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  list_scheduled_tasks: {
    plannerRole: 'qq_schedule_list',
    overlapGroup: 'qq_action',
    preferWhen: ['scheduled task listing requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  cancel_scheduled_task: {
    plannerRole: 'qq_schedule_cancel',
    overlapGroup: 'qq_action',
    preferWhen: ['scheduled task cancellation requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  },
  delete_scheduled_task: {
    plannerRole: 'qq_schedule_delete',
    overlapGroup: 'qq_action',
    preferWhen: ['scheduled task deletion requests'],
    avoidWhen: ['general planning'],
    preferredOver: ['assistant_weekly_agenda']
  }
});

function getPlannerToolMetadata(toolName = '') {
  const metadata = TOOL_PLANNER_METADATA[String(toolName || '').trim()] || {};
  return {
    plannerRole: String(metadata.plannerRole || '').trim(),
    overlapGroup: String(metadata.overlapGroup || '').trim(),
    preferWhen: Array.isArray(metadata.preferWhen) ? metadata.preferWhen.map((item) => String(item || '').trim()).filter(Boolean) : [],
    avoidWhen: Array.isArray(metadata.avoidWhen) ? metadata.avoidWhen.map((item) => String(item || '').trim()).filter(Boolean) : [],
    preferredOver: Array.isArray(metadata.preferredOver) ? metadata.preferredOver.map((item) => String(item || '').trim()).filter(Boolean) : []
  };
}

function buildSchemaDescriptionMap() {
  const map = new Map();
  for (const schema of getToolSchemas()) {
    const toolName = String(schema?.function?.name || '').trim();
    if (!toolName) continue;
    map.set(toolName, String(schema?.function?.description || '').trim());
  }
  return map;
}

function buildDynamicDescriptorMap() {
  const map = new Map();
  for (const descriptor of getDynamicToolDescriptors()) {
    const toolName = String(descriptor?.functionName || '').trim();
    if (!toolName) continue;
    map.set(toolName, {
      toolName,
      description: String(descriptor?.description || '').trim()
    });
  }
  return map;
}

function isToolVisibleInContext(toolName = '', context = {}) {
  const normalized = String(toolName || '').trim();
  if (!normalized) return false;
  if (new Set(['self_improvement_recent', 'self_improvement_search', 'self_improvement_patterns', 'self_improvement_rules', 'self_improvement_guides']).has(normalized)) {
    return false;
  }
  if (normalized === 'publish_qzone' || normalized === 'qzone_draft' || normalized === 'create_qzone_auto_task') {
    return isAdminUser(context.userId);
  }
  return true;
}

function buildDirectChatToolCatalog(context = {}) {
  const schemaDescriptions = buildSchemaDescriptionMap();
  const dynamicDescriptors = buildDynamicDescriptorMap();
  const toolNames = normalizeToolNames([
    ...getToolNames(),
    ...Array.from(dynamicDescriptors.keys())
  ]).filter((toolName) => !isExcludedDirectChatTool(toolName) && isToolVisibleInContext(toolName, context));

  return toolNames.map((toolName) => {
    const policy = getPolicy(toolName);
    const writeCapable = isWriteCapablePolicy(policy);
    const dynamicDescriptor = dynamicDescriptors.get(toolName);
    const description = String(
      dynamicDescriptor?.description
      || schemaDescriptions.get(toolName)
      || toolName
    ).trim();

    return {
      name: toolName,
      bucket: resolveToolBucket(toolName),
      description,
      readOnly: !writeCapable,
      writeCapable,
      ...getPlannerToolMetadata(toolName)
    };
  });
}

function buildDirectChatToolCatalogSummary() {
  const input = arguments[0];
  const catalog = Array.isArray(input)
    ? input
    : buildDirectChatToolCatalog(input && typeof input === 'object' ? input : {});
  return catalog.map((descriptor) => ({
    name: descriptor.name,
    bucket: descriptor.bucket,
    description: descriptor.description,
    readOnly: descriptor.readOnly,
    writeCapable: descriptor.writeCapable,
    plannerRole: descriptor.plannerRole,
    overlapGroup: descriptor.overlapGroup,
    preferWhen: Array.isArray(descriptor.preferWhen) ? [...descriptor.preferWhen] : [],
    avoidWhen: Array.isArray(descriptor.avoidWhen) ? [...descriptor.avoidWhen] : [],
    preferredOver: Array.isArray(descriptor.preferredOver) ? [...descriptor.preferredOver] : []
  }));
}

module.exports = {
  buildDirectChatToolCatalog,
  buildDirectChatToolCatalogSummary,
  isExcludedDirectChatTool,
  isToolVisibleInContext,
  resolveToolBucket
};
