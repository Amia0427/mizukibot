const {
  buildHeuristicDynamicPromptPlan,
  buildMainReplyDynamicPromptGuide,
  getMainReplyDynamicBlockCatalog
} = require('../utils/mainReplyPromptBlocks');
const {
  buildPersonaModuleCandidates,
  getPersonaModuleCatalogSummary,
  selectPersonaModules
} = require('../utils/personaModules');
const {
  buildCacheStatsDiagnostic,
  buildMainReplyTruncationDiagnostic,
  buildMainReplyDiagnosticReport
} = require('../utils/mainReplyDiagnostics');

function parseArgs(argv = []) {
  const args = argv.slice(2);
  const flags = new Set();
  const positional = [];
  let maxCandidates = 0;
  let limit = 0;
  let readLimit = 0;
  let logFile = '';
  let traceFile = '';
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    if (item === '--max-candidates') {
      maxCandidates = Math.max(0, Math.floor(Number(args[i + 1] || 0) || 0));
      i += 1;
      continue;
    }
    if (item.startsWith('--max-candidates=')) {
      maxCandidates = Math.max(0, Math.floor(Number(item.slice('--max-candidates='.length) || 0) || 0));
      continue;
    }
    if (item === '--limit') {
      limit = Math.max(0, Math.floor(Number(args[i + 1] || 0) || 0));
      i += 1;
      continue;
    }
    if (item.startsWith('--limit=')) {
      limit = Math.max(0, Math.floor(Number(item.slice('--limit='.length) || 0) || 0));
      continue;
    }
    if (item === '--read-limit') {
      readLimit = Math.max(0, Math.floor(Number(args[i + 1] || 0) || 0));
      i += 1;
      continue;
    }
    if (item.startsWith('--read-limit=')) {
      readLimit = Math.max(0, Math.floor(Number(item.slice('--read-limit='.length) || 0) || 0));
      continue;
    }
    if (item === '--log-file') {
      logFile = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (item.startsWith('--log-file=')) {
      logFile = item.slice('--log-file='.length).trim();
      continue;
    }
    if (item === '--trace-file') {
      traceFile = String(args[i + 1] || '').trim();
      i += 1;
      continue;
    }
    if (item.startsWith('--trace-file=')) {
      traceFile = item.slice('--trace-file='.length).trim();
      continue;
    }
    flags.add(item);
  }
  const text = positional.join(' ').trim();
  return {
    text,
    json: flags.has('--json') || true,
    cacheStats: flags.has('--cache-stats'),
    promptBlocks: flags.has('--prompt-blocks'),
    realPrompt: flags.has('--real-prompt'),
    explainBudget: flags.has('--explain-budget'),
    truncation: flags.has('--truncation') || flags.has('--truncations') || flags.has('--truncated'),
    maxCandidates,
    limit,
    readLimit,
    logFile,
    traceFile,
    plannerMode: flags.has('--live-planner') ? 'live' : 'rule'
  };
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.text && !args.cacheStats && !args.truncation) {
    console.error('usage: node scripts/diagnose-main-reply.js [--live-planner] [--prompt-blocks] [--real-prompt] [--explain-budget] [--max-candidates n] [--cache-stats] [--truncation --limit n] <text-or-json>');
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
  if (args.truncation) {
    console.log(JSON.stringify(buildMainReplyTruncationDiagnostic(args), null, 2));
    return;
  }
  if (args.promptBlocks) {
    console.log(JSON.stringify(buildPromptBlockDiagnostic(args.text), null, 2));
    return;
  }
  if (args.realPrompt) {
    console.log(JSON.stringify(await buildRealPromptDiagnostic(args), null, 2));
    return;
  }
  const result = await buildMainReplyDiagnosticReport(args.text, {
    plannerMode: args.plannerMode
  });
  console.log(JSON.stringify(result, null, 2));
}

async function buildRealPromptDiagnostic(args = {}) {
  const input = parseDiagnosticText(args.text);
  const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
  const result = await buildDynamicPrompt(
    { level: input.level || 'friend', points: Number(input.points || 0) || 0 },
    input.userId || 'diagnose_user',
    input.requestText || input.cleanText || input.rawText || args.text,
    null,
    {
      routePolicyKey: input.routePolicyKey || 'chat/default',
      topRouteType: input.topRouteType || 'direct_chat',
      sessionKey: input.sessionKey || 'diagnose-main-reply',
      routeMeta: {
        ...(input.routeMeta || {}),
        groupId: input.groupId || input.group_id || input.routeMeta?.groupId || input.routeMeta?.group_id || '',
        chatType: input.chatType || input.chat_type || input.routeMeta?.chatType || input.routeMeta?.chat_type || '',
        directedContext: input.directedContext || input.routeMeta?.directedContext
      },
      continuitySignals: input.continuitySignals || {},
      memoryContext: input.memoryContext,
      maxPersonaModuleCandidates: args.maxCandidates || input.maxPersonaModuleCandidates
    }
  );
  const snapshot = result.promptSnapshot || {};
  return {
    schemaVersion: 'main_reply_real_prompt_diagnostic_v1',
    question: input.requestText || input.cleanText || input.rawText || args.text,
    cacheMeta: result.cacheMeta || {},
    freshness: result.freshness || {},
    latencyMeta: result.latencyMeta || {},
    stableBlockIds: snapshot.stableBlockIds || [],
    dynamicBlockIds: snapshot.dynamicBlockIds || [],
    assistantOnlyBlockIds: snapshot.assistantOnlyBlockIds || [],
    plannerIncludedBlocks: snapshot.plannerIncludedBlocks || [],
    plannerSkippedBlocks: snapshot.plannerSkippedBlocks || [],
    runtimeAddedBlocks: snapshot.runtimeAddedBlocks || [],
    runtimeRejectedBlocks: snapshot.runtimeRejectedBlocks || [],
    selectionTrace: snapshot.selectionTrace || [],
    budgetReport: args.explainBudget ? (snapshot.budgetReport || null) : undefined,
    trimDecisions: snapshot.trimDecisions || [],
    cacheLanes: snapshot.cacheLanes || {},
    candidatePruning: snapshot.candidatePruning || {},
    personaWorldbookSearch: snapshot.personaWorldbookSearch || {}
  };
}

function parseDiagnosticText(text = '') {
  const raw = String(text || '').trim();
  if (!raw || !raw.startsWith('{')) {
    return {
      rawText: raw,
      cleanText: raw,
      requestText: raw
    };
  }
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : { rawText: raw, cleanText: raw, requestText: raw };
  } catch (_) {
    return { rawText: raw, cleanText: raw, requestText: raw };
  }
}

function buildPromptBlockDiagnostic(question) {
  const personaModuleCatalog = getPersonaModuleCatalogSummary();
  const personaModuleCandidates = buildPersonaModuleCandidates({
    question,
    continuitySignals: {
      hasCarryOverTopic: /(刚才|之前|继续|还记得|聊到哪|where did we leave off)/i.test(question),
      hasOpenLoop: /(怎么办|还是|一直|说不出口|没解决)/i.test(question)
    },
    mainReplyPromptMode: 'balanced'
  });
  const personaModuleDecision = selectPersonaModules({}, {
    question,
    continuitySignals: {
      hasCarryOverTopic: /(刚才|之前|继续|还记得|聊到哪|where did we leave off)/i.test(question),
      hasOpenLoop: /(怎么办|还是|一直|说不出口|没解决)/i.test(question)
    },
    personaModuleCandidates,
    mainReplyPromptMode: 'balanced'
  });
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
    plannerChosenPersonaModules: personaModuleDecision.selected.map((item) => item.id),
    personaModuleCandidates: personaModuleCandidates.map((item) => item.id),
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
  buildRealPromptDiagnostic,
  buildPromptBlockDiagnostic,
  parseArgs,
  run
};
