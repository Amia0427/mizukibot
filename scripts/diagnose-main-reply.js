const {
  buildHeuristicDynamicPromptPlan,
  buildMainReplyDynamicPromptGuide,
  getMainReplyDynamicBlockCatalog
} = require('../utils/mainReplyPromptBlocks');
const { getPersonaModuleCatalogSummary } = require('../utils/personaModules');
const {
  buildCacheStatsDiagnostic,
  buildMainReplyDiagnosticReport
} = require('../utils/mainReplyDiagnostics');

function parseArgs(argv = []) {
  const args = argv.slice(2);
  const flags = new Set(args.filter((item) => String(item || '').startsWith('--')));
  const text = args.filter((item) => !String(item || '').startsWith('--')).join(' ').trim();
  return {
    text,
    json: flags.has('--json') || true,
    cacheStats: flags.has('--cache-stats'),
    promptBlocks: flags.has('--prompt-blocks'),
    plannerMode: flags.has('--live-planner') ? 'live' : 'rule'
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.text && !args.cacheStats) {
    console.error('usage: node scripts/diagnose-main-reply.js [--live-planner] [--prompt-blocks] [--cache-stats] <text-or-json>');
    process.exit(1);
  }

  run(args).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function run(args) {
  if (args.cacheStats) {
    console.log(JSON.stringify(buildCacheStatsDiagnostic(args), null, 2));
    return;
  }
  if (args.promptBlocks) {
    console.log(JSON.stringify(buildPromptBlockDiagnostic(args.text), null, 2));
    return;
  }
  const result = await buildMainReplyDiagnosticReport(args.text, {
    plannerMode: args.plannerMode
  });
  console.log(JSON.stringify(result, null, 2));
}

function buildPromptBlockDiagnostic(question) {
  const personaModuleCatalog = getPersonaModuleCatalogSummary();
  const dynamicPromptBlockCatalog = getMainReplyDynamicBlockCatalog(personaModuleCatalog);
  const heuristicPlan = buildHeuristicDynamicPromptPlan({
    continuitySignals: {
      hasCarryOverTopic: /(刚才|之前|继续|还记得|聊到哪|where did we leave off)/i.test(question),
      hasOpenLoop: /(怎么办|还是|一直|说不出口|没解决)/i.test(question)
    },
    directedContext: null,
    hasAffinityState: true,
    hasLongTermProfile: true,
    hasImpression: true,
    hasRelationshipState: true,
    hasDynamicFewShot: /难受|说不出口|创作|反馈|群聊|引用/i.test(question)
  });

  const result = {
    question,
    plannerCandidateDynamicBlocks: dynamicPromptBlockCatalog.map((item) => item.blockId),
    plannerChosenDynamicBlocks: heuristicPlan.enabledBlockIds,
    plannerChosenPersonaModules: heuristicPlan.personaModules || [],
    stableSystemBlocks: ['security_contract', 'main_persona_system', 'core_baseline_patch'],
    dynamicContextBlocks: heuristicPlan.enabledBlockIds.filter((item) => item !== 'dynamic_few_shot' && item !== 'retrieved_memory_lite'),
    assistantOnlyContextBlocks: heuristicPlan.enabledBlockIds.filter((item) => item === 'dynamic_few_shot' || item === 'retrieved_memory_lite'),
    estimatedStableCacheLaneTokens: 0,
    estimatedDynamicLaneTokens: 0,
    estimatedAssistantOnlyLaneTokens: 0,
    cacheFriendlyFingerprint: '',
    dynamicPromptGuidePreview: buildMainReplyDynamicPromptGuide(personaModuleCatalog).slice(0, 800)
  };
  return result;
}

if (require.main === module) {
  main();
}

module.exports = {
  buildCacheStatsDiagnostic,
  buildPromptBlockDiagnostic,
  parseArgs,
  run
};
