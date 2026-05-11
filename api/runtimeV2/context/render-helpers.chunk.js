async function renderPromptLayers(materials = {}, policy = {}) {
  const normalizedMaterials = materials && typeof materials === 'object' ? materials : {};
  return buildBaseDynamicPrompt(
    normalizedMaterials.userInfo,
    normalizedMaterials.userId,
    normalizedMaterials.question,
    normalizedMaterials.customPrompt,
    {
      ...policy,
      routeMeta: policy.routeMeta || normalizedMaterials.routeMeta,
      routePolicyKey: policy.routePolicyKey || normalizedMaterials.routePolicyKey,
      topRouteType: policy.topRouteType || normalizedMaterials.topRouteType,
      promptMaterials: normalizedMaterials
    }
  );
}

function shouldExposeMemoryCli(options = {}) {
  const currentConfig = getConfig();
  if (!currentConfig.MEMORY_CLI_ENABLED || !currentConfig.MEMORY_CLI_CHAT_ENABLED) return false;
  if (options?.disableTools) return false;
  if (String(options?.customPrompt || '').trim()) return false;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();

  if (reviewMode) return false;
  const blockedRoutePrefixes = ['review', 'admin', 'refuse', 'ignore', 'proactive'];
  if (new Set(blockedRoutePrefixes).has(topRouteType)) return false;
  if (blockedRoutePrefixes.some((prefix) => routePolicyKey.startsWith(`${prefix}/`))) return false;
  return topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
    || (!topRouteType && !routePolicyKey);
}

function mergeAllowedToolsWithMemoryCli(allowedTools, options = {}) {
  const base = Array.isArray(allowedTools) ? normalizeToolNames(allowedTools) : [];
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  const shouldExposeContextStats = !options?.disableTools
    && !reviewMode
    && (
      topRouteType === 'direct_chat'
      || routePolicyKey.startsWith('direct_chat/')
      || (!topRouteType && !routePolicyKey)
    );
  const withContextStats = (!shouldExposeContextStats || base.includes('get_context_stats'))
    ? base
    : [...base, 'get_context_stats'];
  const withMemoryCli = (!shouldExposeMemoryCli(options) || withContextStats.includes('memory_cli'))
    ? withContextStats
    : [...withContextStats, 'memory_cli'];
  return filterCompanionAllowedTools(
    filterAllowedToolsForMemoryCliTurn(withMemoryCli, options?.memoryCliTurn),
    currentConfig
  );
}

function buildV2MemoryCliInstruction(memoryCliTurn = null) {
  const currentConfig = getConfig();
  if (!currentConfig.MEMORY_CLI_ENABLED || !currentConfig.MEMORY_CLI_CHAT_ENABLED) return '';
  const lines = [
    '[MemoryCLI]',
    'Use tool memory_cli only when the injected memory context is not enough and you need to verify long-term or recent bridge memory.',
    'The `command` field must contain only a bare command string. Do not add natural language, JSON, code fences, or a `command:` prefix.',
    'Prefer `mem search --query "..."` first. If search already gives enough digest evidence, answer directly without `open`.',
    'Do not issue a second `mem search` in the same turn after one search has already succeeded.',
    'Use `mem open --ref "mc_ref:..."` only with a real ref returned by the immediately preceding memory search. Never invent placeholders or temporary refs.',
    'If the user asks what they like or prefer, bias the search toward preference recall such as `mem search --query "what the user likes"`.',
    'If the user asks where you left off or what you were just discussing, prefer `mem search --query "where did we leave off" --source recent`.',
    'Valid examples: `mem search --query "what the user likes"`; `mem search --query "where did we leave off" --source recent`; `mem open --ref "mc_ref:..."`; `mem open --source profile`.',
    'Invalid examples: `command: mem search --query "..."`; ````mem search --query "..."````; `Please run mem search for me`.',
    'Do not use `mem ls` or `mem stats` in normal chat.',
    'Do not blindly open large memory sources when a search can narrow the target.'
  ];
  const followup = buildMemoryCliFollowupInstruction(memoryCliTurn);
  if (followup) lines.push(followup);
  return lines.join('\n');
}

function shouldInjectLifeScheduler(options = {}) {
  const currentConfig = getConfig();
  if (!currentConfig.LIFE_SCHEDULER_ENABLED) return false;
  if (options?.systemInitiated) return false;
  if (String(options?.customPrompt || '').trim()) return false;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (reviewMode) return false;
  return topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
    || (!topRouteType && !routePolicyKey);
}

function shouldInjectSelfImprovement(options = {}) {
  const currentConfig = getConfig();
  if (!currentConfig.SELF_IMPROVEMENT_ENABLED || !currentConfig.SELF_IMPROVEMENT_PROMPT_ENABLED) return false;
  if (options?.systemInitiated) return false;
  if (String(options?.customPrompt || '').trim()) return false;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (reviewMode) return false;
  if (new Set(['review', 'admin', 'refuse', 'ignore', 'proactive']).has(topRouteType)) return false;
  if (['review/', 'admin/', 'refuse/', 'ignore/', 'proactive/', 'systeminitiated/', 'customprompt/'].some((prefix) => routePolicyKey.startsWith(prefix))) {
    return false;
  }
  return topRouteType === 'direct_chat'
    || topRouteType === 'tool_plan'
    || routePolicyKey.startsWith('direct_chat/')
    || routePolicyKey.startsWith('tool_plan/')
    || (!topRouteType && !routePolicyKey);
}

function shouldInjectStyleProfile(options = {}) {
  const currentConfig = getConfig();
  if (!currentConfig.STYLE_PROFILE_ENABLED) return false;
  if (options?.systemInitiated) return false;
  if (String(options?.customPrompt || '').trim()) return false;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const reviewMode = String(options?.reviewMode || '').trim().toLowerCase();
  const routePolicyKey = String(options?.routePolicyKey || '').trim().toLowerCase();
  const topRouteType = String(options?.topRouteType || routeMeta.topRouteType || '').trim().toLowerCase();
  if (reviewMode) return false;
  if (new Set(['review', 'admin', 'refuse', 'ignore', 'proactive']).has(topRouteType)) return false;
  return topRouteType === 'direct_chat'
    || routePolicyKey.startsWith('direct_chat/')
    || (!topRouteType && !routePolicyKey);
}

function shouldInjectSocialContext(options = {}) {
  const currentConfig = getConfig();
  if (!currentConfig.SOCIAL_CONTEXT_ENABLED) return false;
  if (!shouldInjectStyleProfile(options)) return false;
  const routeMeta = options?.routeMeta && typeof options.routeMeta === 'object' ? options.routeMeta : {};
  const groupId = String(routeMeta.groupId || routeMeta.group_id || '').trim();
  return Boolean(groupId);
}


function formatResearchBriefsForPrompt(briefs = []) {
  const list = Array.isArray(briefs) ? briefs : [];
  if (list.length === 0) return '';
  return ['[BackgroundResearch]', ...list.map((brief, index) => {
    const sources = Array.isArray(brief.sources)
      ? brief.sources.slice(0, 3).map((source) => String(source.url || source.title || '').trim()).filter(Boolean)
      : [];
    return `${index + 1}. query=${brief.query || ''}\nsummary=${brief.summary || ''}${sources.length ? `\nsources=${sources.join(' | ')}` : ''}`;
  })].join('\n');
}

