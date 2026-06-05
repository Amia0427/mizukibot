const config = require('../config');
const { buildRuntimePrompt } = require('./runtimePrompts');
const { buildSecuritySystemPrompt } = require('./promptSecurity');
const { loadPersonaModuleText } = require('./personaModules');

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function isAdminPromptContext(options = {}) {
  const routeMeta = normalizeObject(options.routeMeta, {});
  if (options.isAdmin === true || routeMeta.isAdmin === true || routeMeta.admin === true) return true;
  const userId = normalizeText(
    options.userId
    || options.user_id
    || routeMeta.userId
    || routeMeta.user_id
    || routeMeta.senderId
    || routeMeta.sender_id
  );
  if (!userId) return false;
  return (Array.isArray(config.ADMIN_USER_IDS) ? config.ADMIN_USER_IDS : [])
    .map((item) => normalizeText(item))
    .filter(Boolean)
    .includes(userId);
}

function shouldIncludePromptBlockForMainContext(block = {}, options = {}) {
  const appliesWhen = normalizeObject(block.appliesWhen || block.applies_when, {});
  const adminOnly = appliesWhen.adminOnly === true || appliesWhen.admin_only === true;
  if (adminOnly && !isAdminPromptContext(options)) return false;
  return true;
}

function buildMainStageBlocks(options = {}) {
  const blocks = [];
  const optionSystemPrompt = normalizeText(options.systemPrompt);
  const configSystemPrompt = normalizeText(config.SYSTEM_PROMPT);
  const hasSystemPromptOverride = Boolean(optionSystemPrompt && optionSystemPrompt !== configSystemPrompt);
  const configuredSystemBlocks = Array.isArray(options.systemPromptBlocks)
    ? options.systemPromptBlocks
    : (!hasSystemPromptOverride && Array.isArray(config.SYSTEM_PROMPT_BLOCKS) ? config.SYSTEM_PROMPT_BLOCKS : []);
  const normalizedSystemBlocks = configuredSystemBlocks.map((block, index) => ({
    ...block,
    id: normalizeText(block.id, `system_prompt_block_${index + 1}`),
    label: normalizeText(block.label, normalizeText(block.id, `System Prompt Block ${index + 1}`)),
    stage: normalizeText(block.stage, 'main'),
    priority: Number.isFinite(Number(block.priority)) ? Number(block.priority) : 500 + index,
    authority: normalizeText(block.authority, 'persona'),
    kind: normalizeText(block.kind, 'persona'),
    appliesWhen: normalizeObject(block.appliesWhen || block.applies_when, {}),
    content: normalizeText(block.content)
  }))
    .filter((block) => block.content)
    .filter((block) => shouldIncludePromptBlockForMainContext(block, options));
  const rootSystemBlocks = normalizedSystemBlocks.filter((block) => block.authority === 'system_root' || block.kind === 'system_root');
  const nonRootSystemBlocks = normalizedSystemBlocks.filter((block) => !(block.authority === 'system_root' || block.kind === 'system_root'));
  const hasConfiguredSystemBlocks = normalizedSystemBlocks.length > 0;
  blocks.push(...rootSystemBlocks);
  blocks.push({
    id: 'security_contract',
    label: 'Security Contract',
    stage: 'shared',
    priority: 5,
    authority: 'security',
    kind: 'security',
    content: buildSecuritySystemPrompt()
  });
  if (hasConfiguredSystemBlocks) {
    blocks.push(...nonRootSystemBlocks);
  } else {
    const systemPrompt = optionSystemPrompt || configSystemPrompt;
    if (systemPrompt) {
      blocks.push({
        id: 'main_persona_system',
        label: 'Main Persona',
        stage: 'main',
        priority: 500,
        authority: 'persona',
        kind: 'persona',
        content: systemPrompt
      });
    }
  }
  return blocks;
}

function buildMainStableSystemBlocks(options = {}) {
  const blocks = buildMainStageBlocks(options).map((block) => ({
    ...block,
    lane: 'stable_system'
  }));
  const coreBaseline = normalizeText(loadPersonaModuleText('core_baseline'));
  if (coreBaseline) {
    blocks.push({
      id: 'core_baseline_patch',
      label: 'Core Baseline Patch',
      stage: 'main',
      priority: 145,
      authority: 'persona_module',
      kind: 'persona_core_patch',
      content: coreBaseline,
      budgetTokens: 120,
      conflictTags: [],
      source: 'persona_modules/core_baseline.txt',
      lane: 'stable_system',
      meta: {}
    });
  }
  return blocks;
}

function buildReviewStageSystemPrompt(options = {}) {
  return [
    buildSecuritySystemPrompt(),
    'You are the review-stage style and evidence guardian.',
    'Keep Mizuki tone light and natural, but do not import the full main persona contract.',
    'Preserve evidence, limitations, failed steps, and uncertainty exactly.',
    'Never wash tool output into unsupported certainty.',
    'Do not add new facts, sources, or execution details.',
    normalizeText(options.extraInstruction)
  ].filter(Boolean).join('\n');
}

function buildReviewStageRoutePrompt(options = {}) {
  return buildRuntimePrompt('review-route', {
    outputFormatInstruction: normalizeText(options.outputFormatInstruction),
    routePromptBlock: normalizeText(options.routePromptBlock)
  });
}

function buildPlannerStageSystemPrompt(toolCatalog = [], options = {}) {
  const catalogBlock = Array.isArray(toolCatalog) && toolCatalog.length > 0
    ? toolCatalog.map((tool) => {
      const name = normalizeText(tool?.name);
      if (!name) return '';
      const desc = normalizeText(tool?.description || tool?.plannerRole || tool?.bucket);
      return `- ${name}${desc ? `: ${desc}` : ''}`;
    }).filter(Boolean).join('\n')
    : '(none)';

  return [
    buildSecuritySystemPrompt(),
    'You are the direct-chat planner stage.',
    'Your responsibility is task judgment, evidence policy, and tool planning only.',
    'Make the final planner decision in one pass; do not request or depend on a second planner pass.',
    'You may also decide at most 2 persona modules for the main reply.',
    'Only choose persona modules from the provided personaModuleCatalog.',
    'Do not imitate the full main persona.',
    'Optimize for factuality, continuity, and specialized tool choice.',
    'Return JSON only.',
    'Available tools:',
    catalogBlock,
    normalizeText(options.extraInstruction)
  ].filter(Boolean).join('\n');
}

function buildRouterStageSystemPrompt(options = {}) {
  return [
    buildSecuritySystemPrompt(),
    'You are the direct-chat router refinement stage.',
    'Your job is route classification and safety-preserving refinement only.',
    'Do not imitate the full main persona.',
    'Do not invent history, memory, or route-only internals.',
    normalizeText(options.extraInstruction)
  ].filter(Boolean).join('\n');
}

module.exports = {
  buildMainStageBlocks,
  buildMainStableSystemBlocks,
  buildPlannerStageSystemPrompt,
  buildReviewStageRoutePrompt,
  buildReviewStageSystemPrompt,
  buildRouterStageSystemPrompt
};
