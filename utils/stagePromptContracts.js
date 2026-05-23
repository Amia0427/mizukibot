const config = require('../config');
const { buildRuntimePrompt } = require('./runtimePrompts');
const { buildSecuritySystemPrompt } = require('./promptSecurity');
const { loadPersonaModuleText } = require('./personaModules');

function normalizeText(value) {
  return String(value || '').trim();
}

function buildMainStageBlocks(options = {}) {
  const blocks = [];
  blocks.push({
    id: 'security_contract',
    label: 'Security Contract',
    stage: 'shared',
    priority: 5,
    authority: 'security',
    kind: 'security',
    content: buildSecuritySystemPrompt()
  });
  const systemPrompt = normalizeText(options.systemPrompt || config.SYSTEM_PROMPT);
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
