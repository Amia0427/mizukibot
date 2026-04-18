const {
  buildHeuristicDynamicPromptPlan,
  buildMainReplyDynamicPromptGuide,
  getMainReplyDynamicBlockCatalog
} = require('../utils/mainReplyPromptBlocks');
const { getPersonaModuleCatalogSummary } = require('../utils/personaModules');

function main() {
  const question = process.argv.slice(2).join(' ').trim();
  if (!question) {
    console.error('usage: node scripts/diagnose-main-reply.js <text>');
    process.exit(1);
  }

  run(question).catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

async function run(question) {
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

  console.log(JSON.stringify(result, null, 2));
}

main();
