const fs = require('fs');
const path = require('path');

const config = require('../config');
const { buildDynamicPrompt } = require('../api/runtimeV2/context/service');
const {
  normalizeArray,
  normalizeDiagnosticContext,
  normalizeObject,
  normalizeText: baseNormalizeText,
  parseMainReplyDiagnosticInput
} = require('./mainReplyDiagnostics/input');
const {
  getDiagnostics: getWorldbookDbDiagnostics,
  getWorldbookEntry,
  isPrimaryReadEnabled
} = require('./worldbookDb');
const { loadPersonaModuleCatalog } = require('./personaModules');
const { flushRequestTraceEventsSync } = require('./requestTrace');
const { flushMemoryRecallObservabilitySync } = require('./memoryRecallObservability');

const SCHEMA_VERSION = 'main_reply_prompt_assembly_diagnostic_v1';
const MAIN_REPLY_MODEL_CALL_SOURCES = new Set(['v2_assistant_message', 'v2_streaming_reply']);

function normalizeText(value = '', fallback = '') {
  const text = baseNormalizeText(value);
  return text || fallback;
}

function toFiniteNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function resolveDataFile(options = {}, fileName = '') {
  const direct = normalizeText(options[fileName.replace(/\.ndjson$/, 'File')]);
  if (direct) return direct;
  const dataDir = normalizeText(options.dataDir) || config.DATA_DIR || path.join(process.cwd(), 'data');
  return path.join(dataDir, fileName);
}

function readJsonLineFileRows(filePath = '', limit = 5000) {
  const normalized = normalizeText(filePath);
  if (!normalized || !fs.existsSync(normalized)) return [];
  const text = fs.readFileSync(normalized, 'utf8');
  return text
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .slice(-Math.max(1, Math.floor(Number(limit || 5000) || 5000)))
    .map((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function readDiagnosticRows(options = {}) {
  const readLimit = Math.max(1, Math.floor(Number(options.readLimit || options.maxLines || 5000) || 5000));
  const modelCallFile = normalizeText(options.modelCallFile || options.logFile)
    || path.join(normalizeText(options.dataDir) || config.DATA_DIR || path.join(process.cwd(), 'data'), 'model-calls.ndjson');
  const traceFile = normalizeText(options.traceFile) || resolveDataFile(options, 'request-trace.ndjson');
  const observationFile = normalizeText(options.observationFile) || resolveDataFile(options, 'memory-recall-observability.ndjson');
  try {
    const { flushBatchedLogWritesSync } = require('./logRotation');
    flushBatchedLogWritesSync(modelCallFile);
  } catch (_) {}
  flushRequestTraceEventsSync();
  flushMemoryRecallObservabilitySync();
  return {
    files: { modelCallFile, traceFile, observationFile },
    modelRows: Array.isArray(options.modelRows) ? options.modelRows : readJsonLineFileRows(modelCallFile, readLimit),
    traceRows: Array.isArray(options.traceRows) ? options.traceRows : readJsonLineFileRows(traceFile, readLimit),
    observationRows: Array.isArray(options.observationRows) ? options.observationRows : readJsonLineFileRows(observationFile, readLimit)
  };
}

function getRequestId(row = {}) {
  return normalizeText(row.requestId || row.request_id || row.trace?.requestId || row.routeMeta?.requestTrace?.requestId);
}

function rowTimestamp(row = {}) {
  return normalizeText(row.recordedAt || row.ts || row.completed_at || row.started_at);
}

function isMainReplyModelCall(row = {}) {
  const source = normalizeText(row.source);
  const trigger = normalizeText(row.trigger_branch || row.triggerBranch);
  const dispatch = normalizeText(row.dispatch_branch || row.dispatchBranch);
  if (MAIN_REPLY_MODEL_CALL_SOURCES.has(source)) return true;
  return /direct_reply|draft_reply/i.test(trigger) || /direct_reply|tool_plan/i.test(dispatch);
}

function latestRow(rows = []) {
  return normalizeArray(rows)[normalizeArray(rows).length - 1] || null;
}

function uniqueTexts(values = []) {
  return Array.from(new Set(normalizeArray(values).map((item) => normalizeText(item)).filter(Boolean)));
}

function promptIntegrityBlockIds(integrity = {}) {
  const markers = normalizeObject(integrity.memory_markers || integrity.memoryMarkers, {});
  const ids = [];
  if (integrity.has_retrieved_memory === true || markers.retrieved_memory) ids.push('retrieved_memory_lite');
  if (integrity.has_daily_journal === true || markers.daily_journal) ids.push('daily_journal');
  if (integrity.has_short_term_continuity === true || markers.short_term_continuity) ids.push('short_term_continuity');
  if (integrity.has_memos_recall === true || markers.memos_recall) ids.push('memos_recall');
  if (integrity.has_openviking_recall === true || markers.openviking_recall) ids.push('openviking_recall');
  return uniqueTexts(ids);
}

function collectObservedBlockIds(modelCall = {}, observation = {}) {
  const prompt = normalizeObject(observation.prompt, {});
  const integrity = normalizeObject(modelCall.prompt_integrity || modelCall.promptIntegrity, {});
  return {
    stable: uniqueTexts(prompt.stableBlockIds || prompt.stable_block_ids),
    dynamic: uniqueTexts(prompt.dynamicBlockIds || prompt.dynamic_block_ids),
    assistantOnly: uniqueTexts(prompt.assistantOnlyBlockIds || prompt.assistant_only_block_ids),
    inferredFromModelCall: promptIntegrityBlockIds(integrity)
  };
}

function buildBlockSourceCatalog() {
  const personaCatalog = loadPersonaModuleCatalog();
  const catalogById = new Map(
    normalizeArray(personaCatalog.modules)
      .map((item) => [normalizeText(item.id), item])
      .filter(([id]) => Boolean(id))
  );
  return { personaCatalog, catalogById };
}

function buildStableBlockSourceIndex() {
  const byId = new Map();
  for (const block of normalizeArray(config.SYSTEM_PROMPT_BLOCKS)) {
    const id = normalizeText(block.id);
    if (!id) continue;
    byId.set(id, {
      id,
      sourceFile: normalizeText(block.source, 'config/system_prompt'),
      sourcePolicy: block.source === 'config/system_prompt'
        ? 'compiled_prompt_manifest'
        : 'prompt_manifest_stable_system',
      sourceKind: 'stable_system',
      sourceConfidence: 'current_code_inference'
    });
  }
  byId.set('security_contract', {
    id: 'security_contract',
    sourceFile: 'utils/promptSecurity.js',
    sourcePolicy: 'runtime_security_contract',
    sourceKind: 'stable_system',
    sourceConfidence: 'current_code_inference'
  });
  byId.set('core_baseline_patch', {
    id: 'core_baseline_patch',
    sourceFile: 'persona_modules/core_baseline.txt',
    sourcePolicy: 'persona_module_catalog_file',
    sourceKind: 'stable_system',
    sourceConfidence: 'current_code_inference'
  });
  return byId;
}

function resolvePersonaModuleSource(moduleId = '', fallbackSource = '', catalogById = null) {
  const normalizedId = normalizeText(moduleId);
  const source = normalizeText(fallbackSource);
  const catalogItem = catalogById?.get(normalizedId);
  if (normalizedId.startsWith('wb_mizuki_')) {
    const entry = isPrimaryReadEnabled() ? getWorldbookEntry(normalizedId) : null;
    return {
      sourceFile: normalizeText(entry?.sourcePath || catalogItem?.path || source),
      sourcePolicy: isPrimaryReadEnabled()
        ? 'persona_worldbook_sql_primary_read'
        : 'persona_worldbook_catalog_file_fallback'
    };
  }
  return {
    sourceFile: normalizeText(catalogItem?.path || source),
    sourcePolicy: 'persona_module_catalog_file'
  };
}

function summarizeObservedBlockSource(blockId = '', lane = '', catalogById = null, stableIndex = null) {
  const id = normalizeText(blockId);
  if (!id) return null;
  const stable = stableIndex?.get(id);
  if (stable) return { ...stable, lane: normalizeText(lane, 'stable_system') };
  if (id.startsWith('persona_module:') || id.startsWith('persona_module_')) {
    const moduleId = id.replace(/^persona_module[:_]/, '');
    const source = resolvePersonaModuleSource(moduleId, '', catalogById);
    return {
      id,
      lane: normalizeText(lane, 'dynamic_context'),
      moduleId,
      sourceFile: source.sourceFile,
      sourcePolicy: source.sourcePolicy,
      sourceKind: moduleId.startsWith('wb_mizuki_') ? 'persona_worldbook' : 'persona_module',
      sourceConfidence: 'current_code_inference'
    };
  }
  const dynamicSourceById = {
    roleplay_runtime_context: ['runtime', 'runtime_roleplay_context'],
    chat_liveness_discipline: ['runtime', 'runtime_liveness_policy'],
    roleplay_inner_protocol: ['runtime', 'runtime_inner_protocol'],
    group_direct_chat_style_guard: ['runtime', 'runtime_group_direct_style_guard'],
    directed_context: ['runtime', 'runtime_directed_context'],
    context_stats_instruction: ['runtime', 'runtime_tool_policy'],
    retrieved_memory_lite: ['runtime memory context', 'memory_context_runtime_materialization'],
    retrieved_memory_compact: ['runtime memory context', 'memory_context_runtime_materialization'],
    daily_journal: ['runtime memory context', 'memory_context_runtime_materialization'],
    daily_journal_compact: ['runtime memory context', 'memory_context_runtime_materialization'],
    short_term_continuity: ['runtime short-term context', 'short_term_runtime_context'],
    short_term_continuity_compact: ['runtime short-term context', 'short_term_runtime_context'],
    memory_recall_policy: ['utils/memory-v3/recallPolicyResource.js', 'memory_v3_recall_policy_runtime'],
    memory_recall_policy_compact: ['utils/memory-v3/recallPolicyResource.js', 'memory_v3_recall_policy_runtime'],
    memos_recall: ['memos_recall', 'memos_recall_runtime'],
    memos_recall_compact: ['memos_recall', 'memos_recall_runtime'],
    openviking_recall: ['openviking_recall', 'openviking_recall_runtime'],
    openviking_recall_compact: ['openviking_recall', 'openviking_recall_runtime'],
    dynamic_few_shot: ['few_shot', 'few_shot_runtime'],
    long_term_profile: ['runtime memory context', 'memory_context_runtime_materialization'],
    impression: ['runtime memory context', 'memory_context_runtime_materialization'],
    summary: ['runtime memory context', 'memory_context_runtime_materialization'],
    continuity_state: ['runtime', 'runtime_continuity_state']
  };
  const source = dynamicSourceById[id] || ['runtime', 'runtime_assembled_block'];
  return {
    id,
    lane: normalizeText(lane, 'dynamic_context'),
    sourceFile: source[0],
    sourcePolicy: source[1],
    sourceKind: 'dynamic_context',
    sourceConfidence: 'current_code_inference'
  };
}

function inferBlockSourcePolicy(block = {}, catalogById = null) {
  const id = normalizeText(block.id);
  const moduleId = normalizeText(block.meta?.moduleId || block.moduleId);
  if (moduleId || id.startsWith('persona_module_') || id.startsWith('persona_module:')) {
    const effectiveModuleId = moduleId || id.replace(/^persona_module[:_]/, '');
    return {
      ...resolvePersonaModuleSource(effectiveModuleId, block.source, catalogById),
      sourceKind: effectiveModuleId.startsWith('wb_mizuki_') ? 'persona_worldbook' : 'persona_module'
    };
  }
  const authority = normalizeText(block.authority);
  const kind = normalizeText(block.kind);
  const source = normalizeText(block.source);
  if (normalizeText(block.lane) === 'stable_system') {
    if (source && source !== 'runtime') {
      return {
        sourceFile: source,
        sourcePolicy: source.startsWith('persona_modules/')
          ? 'persona_module_catalog_file'
          : (source === 'config/system_prompt'
          ? 'compiled_prompt_manifest'
          : 'prompt_manifest_stable_system'),
        sourceKind: 'stable_system'
      };
    }
    if (authority === 'security' || kind === 'security') {
      return {
        sourceFile: 'utils/promptSecurity.js',
        sourcePolicy: 'runtime_security_contract',
        sourceKind: 'stable_system'
      };
    }
  }
  if (source === 'memory_v3_recall_policy') {
    return {
      sourceFile: 'utils/memory-v3/recallPolicyResource.js',
      sourcePolicy: 'memory_v3_recall_policy_runtime',
      sourceKind: 'memory_policy'
    };
  }
  if (source && source !== 'runtime') {
    return {
      sourceFile: source,
      sourcePolicy: `${source}_runtime`,
      sourceKind: authority || kind || 'runtime'
    };
  }
  if (authority.startsWith('memory_') || authority === 'memory_fact') {
    return {
      sourceFile: 'runtime memory context',
      sourcePolicy: 'memory_context_runtime_materialization',
      sourceKind: 'memory'
    };
  }
  return {
    sourceFile: 'runtime',
    sourcePolicy: 'runtime_assembled_block',
    sourceKind: authority || kind || 'runtime'
  };
}

function summarizeBlock(block = {}, laneFallback = '', catalogById = null) {
  const source = inferBlockSourcePolicy(block, catalogById);
  const moduleId = normalizeText(block.meta?.moduleId || block.moduleId);
  return {
    id: normalizeText(block.id),
    lane: normalizeText(block.lane, laneFallback),
    label: normalizeText(block.label),
    authority: normalizeText(block.authority),
    kind: normalizeText(block.kind),
    priority: Number.isFinite(Number(block.priority)) ? Number(block.priority) : null,
    tokens: Math.max(0, Number(block.estimatedTokens || 0) || 0),
    sourceFile: source.sourceFile,
    sourcePolicy: source.sourcePolicy,
    sourceKind: source.sourceKind,
    selectedBy: summarizeSelectedBy(block),
    ...(moduleId ? { moduleId } : {})
  };
}

function summarizeSelectedBy(block = {}) {
  const meta = normalizeObject(block.meta, {});
  if (meta.moduleId) return 'persona_module_selection';
  if (meta.optional === true) return 'dynamic_plan_or_runtime';
  if (normalizeText(block.lane) === 'stable_system') return 'stable_manifest';
  return 'required_runtime';
}

function summarizeBlocks(snapshot = {}, catalogById = null) {
  const blocks = normalizeArray(snapshot.assembledBlocks);
  const stableIds = new Set(normalizeArray(snapshot.stableBlockIds).map((item) => normalizeText(item)));
  const dynamicIds = new Set(normalizeArray(snapshot.dynamicBlockIds).map((item) => normalizeText(item)));
  const assistantIds = new Set(normalizeArray(snapshot.assistantOnlyBlockIds).map((item) => normalizeText(item)));
  const laneFor = (block = {}) => {
    const id = normalizeText(block.id);
    if (stableIds.has(id)) return 'stable_system';
    if (dynamicIds.has(id)) return 'dynamic_context';
    if (assistantIds.has(id)) return 'assistant_only';
    return normalizeText(block.lane, 'dynamic_context');
  };
  return {
    stable: blocks.filter((block) => laneFor(block) === 'stable_system').map((block) => summarizeBlock(block, 'stable_system', catalogById)),
    dynamic: blocks.filter((block) => laneFor(block) === 'dynamic_context').map((block) => summarizeBlock(block, 'dynamic_context', catalogById)),
    assistantOnly: blocks.filter((block) => laneFor(block) === 'assistant_only').map((block) => summarizeBlock(block, 'assistant_only', catalogById))
  };
}

function summarizePlanner(snapshot = {}, traceRows = [], observation = {}) {
  const plan = normalizeObject(snapshot.dynamicPromptPlan || snapshot.plannerDynamicContextPlan || observation.planner, {});
  const source = normalizeText(plan.source || plan._source || observation.planner?.dynamicPromptPlanSource);
  const traceSignals = normalizeArray(traceRows)
    .map((row) => {
      const text = [
        row.tracePhase,
        row.stage,
        row.source,
        row.reason,
        row.error,
        row.finalErrorCode,
        row.final_error_code
      ].map((item) => normalizeText(item).toLowerCase()).filter(Boolean).join(' ');
      if (!text) return '';
      if (text.includes('timeout')) return 'planner_timeout';
      if (text.includes('disabled')) return 'planner_disabled';
      if (text.includes('fallback')) return 'planner_fallback';
      return '';
    })
    .filter(Boolean);
  const provided = plan.plannerProvided === true
    || Boolean(source && !['heuristic', 'rule', 'fallback', 'unknown'].includes(source));
  return {
    provided,
    source: source || (provided ? 'planner' : 'unknown'),
    bypassedOrFallback: !provided || traceSignals.length > 0,
    traceSignals: uniqueTexts(traceSignals),
    enabledBlockIds: uniqueTexts(plan.enabledBlockIds),
    personaModules: uniqueTexts(plan.personaModules),
    includedBlocks: normalizeArray(snapshot.plannerIncludedBlocks),
    skippedBlocks: normalizeArray(snapshot.plannerSkippedBlocks)
  };
}

function summarizePersona(snapshot = {}, catalogById = null) {
  const selectedIds = uniqueTexts(snapshot.activatedPersonaModules);
  const blocks = normalizeArray(snapshot.assembledBlocks)
    .filter((block) => normalizeText(block?.meta?.moduleId))
    .map((block) => {
      const moduleId = normalizeText(block.meta.moduleId);
      const source = resolvePersonaModuleSource(moduleId, block.source, catalogById);
      return {
        id: moduleId,
        blockId: normalizeText(block.id),
        tokenCost: Math.max(0, Number(block.budgetTokens || block.estimatedTokens || 0) || 0),
        sourceFile: source.sourceFile,
        sourcePolicy: source.sourcePolicy
      };
    });
  const candidates = normalizeArray(snapshot.personaModuleCandidates).map((item) => {
    if (typeof item === 'string') return { id: normalizeText(item) };
    return {
      id: normalizeText(item?.id || item?.moduleId),
      score: Number.isFinite(Number(item?.candidateScore || item?.worldbookScore)) ? Number(item.candidateScore || item.worldbookScore) : null,
      matchMode: normalizeText(item?.worldbookMatchMode || item?.matchMode),
      sourcePolicy: normalizeText(item?.id || item?.moduleId).startsWith('wb_mizuki_')
        ? (isPrimaryReadEnabled() ? 'persona_worldbook_sql_primary_read' : 'persona_worldbook_catalog_file_fallback')
        : 'persona_module_catalog_file'
    };
  }).filter((item) => item.id);
  return {
    selected: selectedIds,
    candidates,
    blocks,
    tokenUsage: normalizeArray(snapshot.personaModuleTokenUsage)
  };
}

function summarizeWorldbook(snapshot = {}, catalogById = null) {
  const persona = summarizePersona(snapshot, catalogById);
  const selectedWorldbook = persona.blocks.filter((item) => item.id.startsWith('wb_mizuki_'));
  const worldbookSearch = normalizeObject(snapshot.personaWorldbookSearch, {});
  return {
    db: getWorldbookDbDiagnostics({ benchmark: false }),
    search: worldbookSearch,
    selected: selectedWorldbook,
    candidateIds: persona.candidates.filter((item) => item.id.startsWith('wb_mizuki_')).map((item) => item.id),
    sqlPrimaryRead: isPrimaryReadEnabled(),
    sqlEvidence: {
      primaryRead: worldbookSearch.sql?.primaryRead === true || isPrimaryReadEnabled(),
      dbFile: normalizeText(worldbookSearch.sql?.dbFile || getWorldbookDbDiagnostics({ benchmark: false }).dbFile),
      ftsCandidates: Math.max(0, Number(worldbookSearch.sql?.ftsCandidates || 0) || 0),
      lexicalCandidates: Math.max(0, Number(worldbookSearch.sql?.lexicalCandidates || 0) || 0),
      selected: Math.max(0, Number(worldbookSearch.selected || selectedWorldbook.length || 0) || 0)
    }
  };
}

function summarizeRuntimeLocalInjection(snapshot = {}) {
  const plannerProvided = snapshot.dynamicPromptPlan?.plannerProvided === true;
  const runtimeAdded = normalizeArray(snapshot.runtimeAddedBlocks);
  const selectedTrace = normalizeArray(snapshot.selectionTrace)
    .filter((item) => item.selected === true && (item.runtimeAdded === true || normalizeText(item.id).startsWith('persona_module:')))
    .map((item) => ({
      id: normalizeText(item.id),
      blockId: normalizeText(item.blockId),
      moduleId: normalizeText(item.moduleId),
      reason: normalizeText(item.reason),
      runtimeAdded: item.runtimeAdded === true,
      includedByPlanner: item.includedByPlanner === true
    }));
  return {
    runtimeAddedBlocks: runtimeAdded,
    runtimeRejectedBlocks: normalizeArray(snapshot.runtimeRejectedBlocks),
    selectedWithoutPlanner: plannerProvided
      ? selectedTrace.filter((item) => item.includedByPlanner !== true)
      : selectedTrace,
    evidenceNote: 'When planner.provided=false or planner times out, runtime-added blocks and selected persona_module blocks are still eligible through local heuristic/persona selection before final prompt compile.'
  };
}

async function buildFromTestInput(rawInput = {}, options = {}) {
  const input = parseMainReplyDiagnosticInput(rawInput);
  const context = normalizeDiagnosticContext(input);
  const routeMeta = normalizeObject(input.routeMeta, {});
  const effectiveRouteMeta = {
    ...routeMeta,
    userId: context.userId || routeMeta.userId || routeMeta.user_id,
    groupId: context.groupId || routeMeta.groupId || routeMeta.group_id,
    chatType: context.chatType || routeMeta.chatType || routeMeta.chat_type
  };
  const explicitDynamicPromptPlan = input.dynamicPromptPlan && typeof input.dynamicPromptPlan === 'object' && !Array.isArray(input.dynamicPromptPlan)
    && Object.keys(input.dynamicPromptPlan).length > 0
    ? input.dynamicPromptPlan
    : null;
  const promptOptions = {
    routePolicyKey: normalizeText(input.routePolicyKey, 'chat/default'),
    topRouteType: normalizeText(input.topRouteType, 'direct_chat'),
    sessionKey: normalizeText(input.sessionKey, 'diagnose-main-reply-prompt-assembly'),
    routeMeta: effectiveRouteMeta,
    continuitySignals: normalizeObject(input.continuitySignals, {}),
    memoryContext: normalizeObject(input.memoryContext, { segments: {} }),
    mainReplyPromptMode: normalizeText(input.mainReplyPromptMode || input.promptMode),
    forceDynamicFewShot: false,
    dynamicFewShotEnabled: false,
    includeOptionalContextBlocks: false,
    optionalBuildEnabled: false,
    maxPersonaModuleCandidates: Math.max(0, Number(input.maxPersonaModuleCandidates || options.maxPersonaModuleCandidates || 0) || 0) || undefined,
    worldbookSemanticLimit: Object.prototype.hasOwnProperty.call(input, 'worldbookSemanticLimit')
      ? Number(input.worldbookSemanticLimit)
      : (Object.prototype.hasOwnProperty.call(options, 'worldbookSemanticLimit') ? options.worldbookSemanticLimit : 0),
    worldbookEmbeddingHotPath: input.worldbookEmbeddingHotPath ?? options.worldbookEmbeddingHotPath ?? false,
    worldbookSessionReadOnly: true,
    worldbookSessionConsume: false,
    readOnly: true
  };
  if (explicitDynamicPromptPlan) promptOptions.dynamicPromptPlan = explicitDynamicPromptPlan;
  const result = await buildDynamicPrompt(
    {
      level: normalizeText(input.level, 'friend'),
      points: toFiniteNumber(input.points, 0)
    },
    context.userId || normalizeText(input.userId, 'diagnose_user'),
    context.requestText,
    null,
    promptOptions
  );
  const snapshot = normalizeObject(result.promptSnapshot, {});
  const { catalogById } = buildBlockSourceCatalog();
  const blocks = summarizeBlocks(snapshot, catalogById);
  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    mode: 'test_input',
    exactPromptRebuilt: true,
    input: {
      requestText: context.requestText,
      userId: context.userId || normalizeText(input.userId, 'diagnose_user'),
      groupId: context.groupId,
      chatType: context.chatType,
      routePolicyKey: normalizeText(input.routePolicyKey, 'chat/default'),
      topRouteType: normalizeText(input.topRouteType, 'direct_chat'),
      sessionKey: normalizeText(input.sessionKey, 'diagnose-main-reply-prompt-assembly')
    },
    summary: {
      stableBlocks: blocks.stable.length,
      dynamicBlocks: blocks.dynamic.length,
      assistantOnlyBlocks: blocks.assistantOnly.length,
      personaModules: normalizeArray(snapshot.activatedPersonaModules).length,
      worldbookModules: blocks.dynamic.filter((item) => normalizeText(item.moduleId).startsWith('wb_mizuki_')).length,
      plannerProvided: snapshot.dynamicPromptPlan?.plannerProvided === true,
      plannerSource: normalizeText(snapshot.dynamicPromptPlan?.source || snapshot.dynamicPromptPlan?._source)
    },
    promptAssembly: {
      stableBlocks: blocks.stable,
      dynamicBlocks: blocks.dynamic,
      assistantOnlyBlocks: blocks.assistantOnly,
      tokenUsageByBlock: normalizeArray(snapshot.tokenUsageByBlock),
      trimDecisions: normalizeArray(snapshot.trimDecisions),
      cacheLanes: normalizeObject(snapshot.cacheLanes, {})
    },
    planner: summarizePlanner(snapshot),
    personaModules: summarizePersona(snapshot, catalogById),
    personaWorldbook: summarizeWorldbook(snapshot, catalogById),
    runtimeLocalInjection: summarizeRuntimeLocalInjection(snapshot),
    budgetReport: normalizeObject(snapshot.budgetReport, null),
    cacheMeta: normalizeObject(result.cacheMeta, {}),
    freshness: normalizeObject(result.freshness, {}),
    latencyMeta: normalizeObject(result.latencyMeta, {})
  };
}

function summarizeModelCall(row = {}) {
  const integrity = normalizeObject(row.prompt_integrity || row.promptIntegrity, {});
  const tokenBudget = normalizeObject(integrity.token_budget || integrity.tokenBudget, {});
  return {
    id: normalizeText(row.id),
    requestId: getRequestId(row),
    ts: rowTimestamp(row),
    status: normalizeText(row.status),
    source: normalizeText(row.source),
    provider: normalizeText(row.provider),
    model: normalizeText(row.model),
    routePolicyKey: normalizeText(row.route_policy_key || row.routePolicyKey),
    topRouteType: normalizeText(row.top_route_type || row.topRouteType),
    dispatchBranch: normalizeText(row.dispatch_branch || row.dispatchBranch),
    triggerBranch: normalizeText(row.trigger_branch || row.triggerBranch),
    promptIntegrity: {
      systemMessageCount: Math.max(0, Number(integrity.system_message_count || integrity.systemMessageCount || 0) || 0),
      hasSystemPrompt: integrity.has_system_prompt === true || integrity.hasSystemPrompt === true,
      memoryMarkerCount: Math.max(0, Number(integrity.memory_marker_count || integrity.memoryMarkerCount || 0) || 0),
      inferredBlockIds: promptIntegrityBlockIds(integrity),
      estimatedInputTokens: Number.isFinite(Number(tokenBudget.estimated_input_tokens || tokenBudget.estimatedInputTokens))
        ? Number(tokenBudget.estimated_input_tokens || tokenBudget.estimatedInputTokens)
        : null
    }
  };
}

function summarizeObservation(row = {}) {
  const prompt = normalizeObject(row.prompt, {});
  const planner = normalizeObject(row.planner, {});
  return {
    requestId: getRequestId(row),
    recordedAt: rowTimestamp(row),
    stage: normalizeText(row.stage),
    routePolicyKey: normalizeText(row.routePolicyKey || row.route_policy_key),
    topRouteType: normalizeText(row.topRouteType || row.top_route_type),
    prompt: {
      stableBlockIds: uniqueTexts(prompt.stableBlockIds || prompt.stable_block_ids),
      dynamicBlockIds: uniqueTexts(prompt.dynamicBlockIds || prompt.dynamic_block_ids),
      assistantOnlyBlockIds: uniqueTexts(prompt.assistantOnlyBlockIds || prompt.assistant_only_block_ids),
      assembledBlockCount: Math.max(0, Number(prompt.assembledBlockCount || prompt.assembled_block_count || 0) || 0),
      tokenUsageByBlock: normalizeArray(prompt.tokenUsageByBlock),
      trimDecisions: normalizeArray(prompt.trimDecisions)
    },
    planner: {
      source: normalizeText(planner.dynamicPromptPlanSource || planner.source || planner._source),
      enabledBlockIds: uniqueTexts(planner.enabledBlockIds),
      includedMemosRecall: planner.includedMemosRecall === true,
      includedOpenVikingRecall: planner.includedOpenVikingRecall === true
    },
    localMemory: normalizeObject(row.localMemory, {}),
    memoryTrace: normalizeObject(row.memoryTrace, null)
  };
}

function buildFromRequestId(requestId = '', options = {}) {
  const target = normalizeText(requestId);
  const rows = readDiagnosticRows(options);
  const modelRows = normalizeArray(rows.modelRows).filter((row) => getRequestId(row) === target && isMainReplyModelCall(row));
  const traceRows = normalizeArray(rows.traceRows).filter((row) => getRequestId(row) === target);
  const observationRows = normalizeArray(rows.observationRows)
    .filter((row) => getRequestId(row) === target && /prepare_main_prompt_blocks|prompt/i.test(normalizeText(row.stage)));
  const modelCall = latestRow(modelRows);
  const observation = latestRow(observationRows);
  const observedBlockIds = collectObservedBlockIds(modelCall || {}, observation || {});
  const planner = summarizePlanner({}, traceRows, observation || {});
  const { catalogById } = buildBlockSourceCatalog();
  const stableIndex = buildStableBlockSourceIndex();
  const observedSourceIndex = {
    stableBlocks: observedBlockIds.stable
      .map((id) => summarizeObservedBlockSource(id, 'stable_system', catalogById, stableIndex))
      .filter(Boolean),
    dynamicBlocks: observedBlockIds.dynamic
      .map((id) => summarizeObservedBlockSource(id, 'dynamic_context', catalogById, stableIndex))
      .filter(Boolean),
    assistantOnlyBlocks: observedBlockIds.assistantOnly
      .map((id) => summarizeObservedBlockSource(id, 'assistant_only', catalogById, stableIndex))
      .filter(Boolean),
    inferredRuntimeBlocksFromModelCall: observedBlockIds.inferredFromModelCall
      .map((id) => summarizeObservedBlockSource(id, 'dynamic_context', catalogById, stableIndex))
      .filter(Boolean)
  };
  const observedPersonaBlocks = observedSourceIndex.dynamicBlocks
    .filter((item) => item.sourceKind === 'persona_module' || item.sourceKind === 'persona_worldbook');
  const observedWorldbookBlocks = observedPersonaBlocks
    .filter((item) => item.sourceKind === 'persona_worldbook');
  const observedPersonaSummary = {
    selected: uniqueTexts(observedPersonaBlocks.map((item) => item.moduleId)),
    candidates: [],
    blocks: observedPersonaBlocks.map((item) => ({
      id: item.moduleId,
      blockId: item.id,
      sourceFile: item.sourceFile,
      sourcePolicy: item.sourcePolicy,
      sourceConfidence: item.sourceConfidence
    })),
    tokenUsage: normalizeArray(observation?.prompt?.tokenUsageByBlock)
  };
  const observedRuntimeLocalInjection = {
    runtimeAddedBlocks: [],
    runtimeRejectedBlocks: [],
    selectedWithoutPlanner: planner.provided
      ? []
      : observedPersonaBlocks.map((item) => ({
        id: item.id,
        blockId: item.id,
        moduleId: item.moduleId,
        reason: planner.traceSignals.length > 0
          ? planner.traceSignals.join(',')
          : 'planner_not_provided_observed_persona_module',
        runtimeAdded: false,
        includedByPlanner: false,
        sourceConfidence: item.sourceConfidence
      })),
    evidenceNote: 'Request-id mode reports stored block observations only. When planner.provided=false, observed persona_module blocks indicate local runtime/persona selection entered the final prompt despite planner bypass/fallback.'
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: new Date().toISOString(),
    mode: 'request_id',
    exactPromptRebuilt: false,
    requestId: target,
    files: rows.files,
    summary: {
      foundModelCall: Boolean(modelCall),
      foundPromptObservation: Boolean(observation),
      traceEvents: traceRows.length,
      plannerProvided: planner.provided,
      plannerSource: planner.source,
      stableBlocksObserved: observedBlockIds.stable.length,
      dynamicBlocksObserved: observedBlockIds.dynamic.length,
      assistantOnlyBlocksObserved: observedBlockIds.assistantOnly.length,
      inferredRuntimeBlocksFromModelCall: observedBlockIds.inferredFromModelCall.length
    },
    observed: {
      modelCall: modelCall ? summarizeModelCall(modelCall) : null,
      promptObservation: observation ? summarizeObservation(observation) : null,
      blockIds: observedBlockIds,
      blockSourceIndex: observedSourceIndex,
      traceEvents: traceRows.map((row) => ({
        recordedAt: rowTimestamp(row),
        phaseSeq: Math.max(0, Number(row.phaseSeq || row.phase_seq || 0) || 0),
        tracePhase: normalizeText(row.tracePhase),
        stage: normalizeText(row.stage),
        source: normalizeText(row.source),
        routePolicyKey: normalizeText(row.routePolicyKey || row.route_policy_key),
        topRouteType: normalizeText(row.topRouteType || row.top_route_type),
        reason: normalizeText(row.reason || row.finalErrorCode || row.final_error_code || row.error).slice(0, 240)
      }))
    },
    promptAssembly: {
      stableBlocks: observedSourceIndex.stableBlocks,
      dynamicBlocks: observedSourceIndex.dynamicBlocks,
      assistantOnlyBlocks: observedSourceIndex.assistantOnlyBlocks,
      inferredRuntimeBlocksFromModelCall: observedSourceIndex.inferredRuntimeBlocksFromModelCall,
      tokenUsageByBlock: normalizeArray(observation?.prompt?.tokenUsageByBlock),
      trimDecisions: normalizeArray(observation?.prompt?.trimDecisions)
    },
    planner,
    personaModules: observedPersonaSummary,
    personaWorldbook: {
      db: getWorldbookDbDiagnostics({ benchmark: false }),
      selected: observedWorldbookBlocks.map((item) => ({
        id: item.moduleId,
        blockId: item.id,
        sourceFile: item.sourceFile,
        sourcePolicy: item.sourcePolicy,
        sourceConfidence: item.sourceConfidence
      })),
      candidateIds: uniqueTexts(observedWorldbookBlocks.map((item) => item.moduleId)),
      sqlPrimaryRead: isPrimaryReadEnabled(),
      requestIdModeNote: 'Request-id mode reports stored evidence only; run test-input mode to rebuild current assembled block source details.'
    },
    runtimeLocalInjection: observedRuntimeLocalInjection
  };
}

function looksLikeRequestId(value = '') {
  return /^req_[A-Za-z0-9_-]+$/.test(normalizeText(value));
}

function parseArgs(argv = process.argv) {
  const args = argv.slice(2);
  const out = {
    requestId: '',
    text: '',
    json: true,
    readLimit: 5000,
    dataDir: '',
    modelCallFile: '',
    traceFile: '',
    observationFile: '',
    worldbookSemanticLimit: 0,
    worldbookEmbeddingHotPath: false
  };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const item = String(args[i] || '').trim();
    if (!item.startsWith('--')) {
      positional.push(item);
      continue;
    }
    const readNext = () => {
      const value = String(args[i + 1] || '').trim();
      i += 1;
      return value;
    };
    if (item === '--request-id' || item === '--requestId') out.requestId = readNext();
    else if (item.startsWith('--request-id=')) out.requestId = item.slice('--request-id='.length).trim();
    else if (item.startsWith('--requestId=')) out.requestId = item.slice('--requestId='.length).trim();
    else if (item === '--text' || item === '--question') out.text = readNext();
    else if (item.startsWith('--text=')) out.text = item.slice('--text='.length).trim();
    else if (item.startsWith('--question=')) out.text = item.slice('--question='.length).trim();
    else if (item === '--data-dir' || item === '--dataDir') out.dataDir = readNext();
    else if (item.startsWith('--data-dir=')) out.dataDir = item.slice('--data-dir='.length).trim();
    else if (item === '--model-call-file' || item === '--log-file') out.modelCallFile = readNext();
    else if (item.startsWith('--model-call-file=')) out.modelCallFile = item.slice('--model-call-file='.length).trim();
    else if (item === '--trace-file') out.traceFile = readNext();
    else if (item.startsWith('--trace-file=')) out.traceFile = item.slice('--trace-file='.length).trim();
    else if (item === '--observation-file') out.observationFile = readNext();
    else if (item.startsWith('--observation-file=')) out.observationFile = item.slice('--observation-file='.length).trim();
    else if (item === '--read-limit' || item === '--max-lines') out.readLimit = Math.max(1, Number(readNext()) || out.readLimit);
    else if (item.startsWith('--read-limit=')) out.readLimit = Math.max(1, Number(item.slice('--read-limit='.length)) || out.readLimit);
    else if (item === '--worldbook-semantic-limit') out.worldbookSemanticLimit = Number(readNext());
    else if (item.startsWith('--worldbook-semantic-limit=')) out.worldbookSemanticLimit = Number(item.slice('--worldbook-semantic-limit='.length));
    else if (item === '--worldbook-hot-path') out.worldbookEmbeddingHotPath = true;
    else if (item === '--no-worldbook-hot-path') out.worldbookEmbeddingHotPath = false;
    else if (item === '--json') out.json = true;
  }
  const positionalText = positional.join(' ').trim();
  if (!out.requestId && looksLikeRequestId(positionalText)) out.requestId = positionalText;
  else if (!out.text) out.text = positionalText;
  return out;
}

async function buildMainReplyPromptAssemblyDiagnostic(rawInput = {}, options = {}) {
  const input = rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
    ? rawInput
    : parseMainReplyDiagnosticInput(rawInput);
  const requestId = normalizeText(input.requestId || input.request_id || options.requestId);
  if (requestId) return buildFromRequestId(requestId, { ...options, ...input });
  const textInput = normalizeText(input.text || input.question || input.requestText || input.rawText || options.text);
  if (!textInput) {
    return {
      schemaVersion: SCHEMA_VERSION,
      checkedAt: new Date().toISOString(),
      mode: 'empty',
      exactPromptRebuilt: false,
      error: 'missing_request_id_or_text'
    };
  }
  return buildFromTestInput({
    ...input,
    requestText: input.requestText || textInput
  }, options);
}

module.exports = {
  SCHEMA_VERSION,
  buildMainReplyPromptAssemblyDiagnostic,
  buildFromRequestId,
  buildFromTestInput,
  parseArgs,
  readDiagnosticRows,
  summarizeBlocks
};
