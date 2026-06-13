const fs = require('fs');
const path = require('path');
const config = require('../config');
const {
  searchPersonaWorldbook,
  searchPersonaWorldbookLexical
} = require('./personaWorldbookSearch');
const {
  getDiagnostics: getWorldbookDbDiagnostics,
  getWorldbookEntry,
  importWorldbookFromCatalog,
  isPrimaryReadEnabled,
  searchWorldbookEntries
} = require('./worldbookDb');
const {
  activateWorldbookSessionCandidates,
  decorateActivatedWorldbookCandidates,
  getActiveWorldbookSessionCandidates,
  getWorldbookSessionState,
  normalizeWorldbookRuntimeMeta
} = require('./personaWorldbookSearch/sessionState');
const { createPersonaModuleRulePicker } = require('./personaModules/rules');
const {
  recallPersonaModules,
  recallPersonaModulesSync
} = require('./localPromptRecall');
const {
  getDefaultPersonaModuleLimit,
  isBalancedOrMinimalPromptMode,
  isEmotionPersonaModule,
  resolveMainReplyPromptMode,
  shouldUseWorldbookSearch
} = require('./mainReplyPromptMode');

const MODULE_CATALOG_PATH = path.join(config.PROMPTS_DIR, 'persona_modules', 'module-catalog.json');

function normalizeText(value, fallback = '') {
  const text = String(value || '').trim();
  return text || fallback;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

function safeReadText(filePath, fallback = '') {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return fallback;
  }
}

function loadPersonaModuleCatalog() {
  const parsed = safeReadJson(MODULE_CATALOG_PATH, { version: 1, modules: [] });
  const modules = normalizeArray(parsed?.modules).map((item) => ({
    id: normalizeText(item?.id),
    path: normalizeText(item?.path),
    purpose: normalizeText(item?.purpose),
    triggerHints: normalizeArray(item?.triggerHints).map((entry) => normalizeText(entry)).filter(Boolean),
    tokenCost: Math.max(0, Number(item?.tokenCost || 0) || 0),
    priority: Number.isFinite(Number(item?.priority)) ? Number(item.priority) : 100,
    conflictsWith: normalizeArray(item?.conflictsWith).map((entry) => normalizeText(entry)).filter(Boolean),
    phase: normalizeText(item?.phase, 'all'),
    slot: normalizeText(item?.slot, 'general'),
    activationMode: normalizeText(item?.activationMode),
    durationTurns: Object.prototype.hasOwnProperty.call(item || {}, 'durationTurns') ? Math.max(0, Number(item.durationTurns || 0) || 0) : undefined,
    durationMs: Object.prototype.hasOwnProperty.call(item || {}, 'durationMs') ? Math.max(0, Number(item.durationMs || 0) || 0) : undefined,
    scope: normalizeArray(item?.scope).map((entry) => normalizeText(entry)).filter(Boolean),
    probability: Object.prototype.hasOwnProperty.call(item || {}, 'probability') ? Math.max(0, Math.min(1, Number(item.probability || 0) || 0)) : undefined,
    template: normalizeText(item?.template),
    exampleIds: normalizeArray(item?.exampleIds).map((entry) => normalizeText(entry)).filter(Boolean)
  })).filter((item) => item.id && item.path);

  return {
    version: Number(parsed?.version || 1) || 1,
    maxActiveModules: Math.max(0, Number(parsed?.max_active_modules || 2) || 2),
    defaultMaxActiveModules: Math.max(0, Number(parsed?.default_max_active_modules || 1) || 1),
    modules
  };
}

function getPersonaModuleCatalogSummary() {
  const catalog = loadPersonaModuleCatalog();
  return catalog.modules.map((item) => ({
    moduleId: item.id,
    purpose: item.purpose,
    triggerHints: item.triggerHints.slice(0, 5),
    tokenCost: item.tokenCost,
    conflictsWith: item.conflictsWith.slice(0, 4),
    priority: item.priority,
    phase: item.phase,
    slot: item.slot,
    activationMode: item.activationMode,
    durationTurns: item.durationTurns,
    durationMs: item.durationMs,
    scope: item.scope,
    probability: item.probability,
    template: item.template,
    exampleIds: item.exampleIds,
    maxActiveModules: catalog.maxActiveModules,
    defaultMaxActiveModules: catalog.defaultMaxActiveModules
  }));
}

function inferPhase(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  const explicit = normalizeText(context.personaPhase || routeMeta.personaPhase || routeMeta.phaseHint || '');
  if (explicit) return explicit.toLowerCase();
  return 'phase2';
}

function lower(text = '') {
  return normalizeText(text).toLowerCase();
}

const {
  pickCandidateIds,
  triggerHintMatches
} = createPersonaModuleRulePicker({
  inferPhase,
  lower,
  normalizeText
});

function addCatalogTriggeredCandidateIds(candidateIds, catalog = { modules: [] }, context = {}) {
  if (!shouldUseWorldbookSearch(context)) return candidateIds;
  const question = lower(context.question || '');
  const routePrompt = lower(context.routePrompt || '');
  const combined = `${question}\n${routePrompt}`;
  if (!question) return candidateIds;
  if (isPrimaryReadEnabled()) {
    const sqlHits = searchWorldbookEntries(combined, {
      limit: config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT || config.PERSONA_WORLDBOOK_SELECTED_MAX || 4
    });
    for (const item of normalizeArray(sqlHits.results)) {
      const moduleId = normalizeText(item?.moduleId || item?.id);
      if (moduleId) candidateIds.add(moduleId);
    }
    return candidateIds;
  }
  for (const item of normalizeArray(catalog.modules)) {
    if (!normalizeText(item?.id).startsWith('wb_mizuki_')) continue;
    if (normalizeArray(item?.triggerHints).some((hint) => triggerHintMatches(hint, combined))) {
      candidateIds.add(item.id);
    }
  }
  return candidateIds;
}

function buildPersonaModuleCandidates(context = {}) {
  const catalog = loadPersonaModuleCatalog();
  const worldbookEnabled = shouldUseWorldbookSearch(context);
  const candidateIds = addCatalogTriggeredCandidateIds(new Set(pickCandidateIds(context)), catalog, context);
  const sqlWorldbookById = new Map();
  if (worldbookEnabled && isPrimaryReadEnabled()) {
    try {
      const sqlHits = searchWorldbookEntries(normalizeText(context.question || context.routePrompt || ''), {
        limit: context.worldbookLimit || config.PERSONA_WORLDBOOK_SELECTED_MAX || 4
      });
      for (const hit of normalizeArray(sqlHits.results)) {
        const moduleId = normalizeText(hit?.moduleId || hit?.id);
        if (!moduleId) continue;
        candidateIds.add(moduleId);
        sqlWorldbookById.set(moduleId, hit);
      }
    } catch (_) {}
  }
  let localRecallModules = [];
  if (config.LOCAL_PROMPT_RECALL_ENABLED !== false && context.disableLocalPromptRecall !== true) {
    try {
      const localRecall = recallPersonaModulesSync(context, {
        limit: context.maxPersonaModuleCandidates || config.PERSONA_MODULE_CANDIDATE_MAX || 16
      });
      if (localRecall.ok) localRecallModules = normalizeArray(localRecall.modules);
      for (const item of localRecallModules) {
        if (normalizeText(item?.id)) candidateIds.add(item.id);
      }
    } catch (_) {}
  }
  if (!worldbookEnabled) {
    for (const id of Array.from(candidateIds)) {
      if (normalizeText(id).startsWith('wb_mizuki_')) candidateIds.delete(id);
    }
  }
  const localById = new Map(localRecallModules.map((item) => [normalizeText(item?.id), item]).filter(([id]) => Boolean(id)));
  const phase = inferPhase(context);
  return catalog.modules
    .filter((item) => candidateIds.has(item.id))
    .filter((item) => item.phase === 'all' || item.phase === phase)
    .map((item) => {
      const local = localById.get(item.id);
      const sqlHit = sqlWorldbookById.get(item.id);
      if (!local && !sqlHit) return item;
      return {
        ...item,
        localPromptRecall: local?.localPromptRecall,
        worldbookScore: Number(sqlHit?.score || local?.worldbookScore || item.worldbookScore || 0) || undefined,
        worldbookMatchMode: normalizeText(sqlHit?.matchMode || local?.worldbookMatchMode || item.worldbookMatchMode),
        worldbookReason: normalizeText(sqlHit?.reason || item.worldbookReason)
      };
    })
    .sort((a, b) => {
      const aWorldbookScore = Number(a.worldbookScore || 0) || 0;
      const bWorldbookScore = Number(b.worldbookScore || 0) || 0;
      if (bWorldbookScore !== aWorldbookScore) return bWorldbookScore - aWorldbookScore;
      const aScore = Number(a.localPromptRecall?.score || 0) || 0;
      const bScore = Number(b.localPromptRecall?.score || 0) || 0;
      if (bScore !== aScore) return bScore - aScore;
      return a.priority - b.priority || a.id.localeCompare(b.id);
    });
}

let worldbookSqlImportAttempted = false;

function ensureWorldbookSqlImported(catalog = null, options = {}) {
  if (!isPrimaryReadEnabled()) return { ok: false, skipped: true, reason: 'sql_primary_read_disabled' };
  const diagnostics = getWorldbookDbDiagnostics({ benchmark: false });
  if (options.force !== true && diagnostics.ok && Number(diagnostics.activeEntries || 0) > 0) {
    return { ok: true, skipped: true, reason: 'already_imported', activeEntries: diagnostics.activeEntries };
  }
  if (worldbookSqlImportAttempted && options.force !== true) {
    return { ok: diagnostics.ok === true, skipped: true, reason: 'import_already_attempted' };
  }
  worldbookSqlImportAttempted = true;
  return importWorldbookFromCatalog(catalog || loadPersonaModuleCatalog(), { apply: true });
}

function mergeCandidateIdsWithWorldbookSearch(ruleCandidates = [], worldbookResults = []) {
  const ids = new Set(normalizeArray(ruleCandidates).map((item) => normalizeText(item?.id)).filter(Boolean));
  for (const item of normalizeArray(worldbookResults)) {
    const moduleId = normalizeText(item?.moduleId || item?.id);
    if (moduleId) ids.add(moduleId);
  }
  return ids;
}

function sortCandidatesWithWorldbookScores(candidates = [], worldbookResults = []) {
  const scoreById = new Map(
    normalizeArray(worldbookResults)
      .map((item) => [normalizeText(item?.moduleId || item?.id), item])
      .filter(([id]) => Boolean(id))
  );
  return normalizeArray(candidates)
    .map((item) => {
      const hit = scoreById.get(item.id);
      if (!hit) return item;
      const hitScore = Number(hit.score || hit.worldbookScore || 0) || 0;
      return {
        ...item,
        worldbookScore: hitScore > 0 ? hitScore : (hit.activationState ? 0.82 : 0),
        worldbookMatchMode: normalizeText(hit.matchMode),
        worldbookReason: normalizeText(hit.reason),
        activationState: hit.activationState,
        linkedExamples: normalizeArray(hit.linkedExamples || hit.exampleIds),
        sessionLinkedExamples: normalizeArray(hit.sessionLinkedExamples || hit.linkedExamples || hit.exampleIds)
      };
    })
    .sort((a, b) => {
      const aScore = Number(a.worldbookScore || 0) || 0;
      const bScore = Number(b.worldbookScore || 0) || 0;
      if (bScore !== aScore) return bScore - aScore;
      return a.priority - b.priority || a.id.localeCompare(b.id);
    });
}

function scorePersonaCandidate(item = {}, context = {}) {
  const question = lower(context.question || '');
  const routePrompt = lower(context.routePrompt || '');
  const combined = `${question}\n${routePrompt}`.replace(/\s+/g, '');
  const priority = Math.max(0, Number(item.priority || 100) || 100);
  let score = Math.max(0, 120 - priority);
  if (Number(item.localPromptRecall?.score || 0) > 0) score += Number(item.localPromptRecall.score || 0) * 1.5;
  if (Number(item.worldbookScore || 0) > 0) score += 120 + (Number(item.worldbookScore || 0) * 100);
  if (normalizeText(item.worldbookMatchMode)) score += 20;
  for (const hint of normalizeArray(item.triggerHints)) {
    if (triggerHintMatches(hint, combined)) score += 18;
  }
  const purpose = lower(item.purpose || '').replace(/\s+/g, '');
  if (purpose && purpose.length >= 3 && combined.includes(purpose.slice(0, Math.min(8, purpose.length)))) score += 8;
  if (context.chatType === 'group' && item.id === 'scene_group_insert') score += 80;
  if (context.chatType === 'private' && item.id === 'scene_private_chat') score += 80;
  if (normalizeText(context.directedContext?.addressee?.senderName) && /branch$/.test(item.id)) score += 20;
  return score;
}

function prunePersonaModuleCandidates(candidates = [], context = {}, options = {}) {
  const normalized = normalizeArray(candidates).filter((item) => item && typeof item === 'object');
  const limit = Math.max(1, Math.floor(Number(options.maxCandidates || context.maxPersonaModuleCandidates || config.PERSONA_MODULE_CANDIDATE_MAX || 16) || 16));
  const alwaysKeep = new Set(
    normalizeArray(options.alwaysKeepIds || context.alwaysKeepPersonaModuleIds)
      .map((item) => normalizeText(item))
      .filter(Boolean)
  );
  for (const item of normalized) {
    if (Number(item.worldbookScore || 0) > 0) alwaysKeep.add(item.id);
    if (item.activationState && normalizeText(item.id).startsWith('wb_mizuki_')) alwaysKeep.add(item.id);
    if (item.id === 'scene_group_insert' && context.chatType === 'group') alwaysKeep.add(item.id);
    if (item.id === 'scene_private_chat' && context.chatType === 'private') alwaysKeep.add(item.id);
  }
  const scored = normalized
    .map((item, index) => ({
      item,
      index,
      score: scorePersonaCandidate(item, context),
      keep: alwaysKeep.has(item.id)
    }))
    .sort((a, b) => {
      if (b.keep !== a.keep) return Number(b.keep) - Number(a.keep);
      if (b.score !== a.score) return b.score - a.score;
      return a.item.priority - b.item.priority || a.item.id.localeCompare(b.item.id);
    });
  const selectedIds = new Set();
  const selected = [];
  for (const row of scored) {
    if (selected.length >= limit && !row.keep) continue;
    if (selectedIds.has(row.item.id)) continue;
    selectedIds.add(row.item.id);
    selected.push({
      ...row.item,
      candidateScore: row.score,
      linkedExamples: normalizeArray(row.item.linkedExamples || row.item.exampleIds),
      sessionLinkedExamples: normalizeArray(row.item.sessionLinkedExamples || row.item.linkedExamples || row.item.exampleIds)
    });
  }
  const selectedSorted = selected.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));
  selectedSorted.candidatePruning = {
    schemaVersion: 'persona_candidate_pruning_v1',
    originalCount: normalized.length,
    keptCount: selectedSorted.length,
    limit,
    droppedCount: Math.max(0, normalized.length - selectedSorted.length),
    keptIds: selectedSorted.map((item) => item.id),
    droppedIds: normalized.map((item) => item.id).filter((id) => !selectedIds.has(id)).slice(0, 40),
    alwaysKeepIds: Array.from(alwaysKeep)
  };
  if (candidates && typeof candidates === 'object' && candidates.personaWorldbookSearch) {
    selectedSorted.personaWorldbookSearch = candidates.personaWorldbookSearch;
  }
  return selectedSorted;
}

async function buildPersonaModuleCandidatesAsync(context = {}) {
  const catalog = loadPersonaModuleCatalog();
  const phase = inferPhase(context);
  const ruleCandidates = buildPersonaModuleCandidates(context);
  const query = normalizeText(context.question || context.routePrompt || '');
  const worldbookSessionReadOnly = context.worldbookSessionReadOnly === true || context.readOnly === true;
  let localRecall = { ok: false, modules: [] };
  if (config.LOCAL_PROMPT_RECALL_ENABLED !== false && context.disableLocalPromptRecall !== true) {
    try {
      localRecall = await recallPersonaModules(context, {
        limit: context.maxPersonaModuleCandidates || config.PERSONA_MODULE_CANDIDATE_MAX || 16,
        requestEmbedding: context.requestEmbedding,
        queryEmbedding: context.localPromptRecallQueryEmbedding
      });
    } catch (error) {
      localRecall = { ok: false, reason: 'local_prompt_recall_failed', error: String(error?.message || error), modules: [] };
    }
  }
  const worldbookEnabled = shouldUseWorldbookSearch(context);
  const worldbookSearch = worldbookEnabled
    ? await searchPersonaWorldbook(catalog, {
      query,
      limit: context.worldbookLimit || config.PERSONA_WORLDBOOK_SELECTED_MAX,
      lexicalLimit: context.worldbookLexicalLimit,
      semanticLimit: context.worldbookSemanticLimit,
      hotPath: context.worldbookEmbeddingHotPath,
      embeddingIndex: context.worldbookEmbeddingIndex,
      queryEmbedding: context.worldbookQueryEmbedding,
      requestEmbedding: context.requestEmbedding,
      shouldUseRemoteEmbedding: context.shouldUseRemoteEmbedding,
      rerankCandidates: context.rerankCandidates,
      maxCandidates: context.worldbookRerankMaxCandidates,
      rerankTimeoutMs: context.worldbookRerankTimeoutMs,
      promptMode: resolveMainReplyPromptMode(context)
    })
    : {
      results: [],
      diagnostics: {
        enabled: false,
        disabledReason: 'prompt_mode_worldbook_gate',
        lexicalCandidates: 0,
        selected: 0,
        embedding: {
          enabled: false,
          ready: 0,
          pending: 0,
          semanticCandidates: 0,
          hotPathUsed: false,
          fallbackReason: 'prompt_mode_worldbook_gate'
        },
        rerank: {
          applied: false,
          candidates: 0,
          reason: 'prompt_mode_worldbook_gate'
        },
        latency: {
          worldbook_lexical_ms: 0,
          worldbook_semantic_ms: 0,
          worldbook_rerank_ms: 0
        }
      }
    };
  const sessionContext = {
    ...context,
    sessionKey: context.sessionKey || context.sessionId || context.routeMeta?.sessionKey || context.routeMeta?.session_key
  };
  const activationResult = worldbookEnabled && !worldbookSessionReadOnly
    ? activateWorldbookSessionCandidates(worldbookSearch.results, sessionContext, {
      now: context.worldbookSessionNow,
      random: context.worldbookSessionRandom
    })
    : { activated: [], skipped: worldbookEnabled && worldbookSessionReadOnly ? [{ reason: 'read_only_diagnostic' }] : [] };
  const activatedWorldbookResults = worldbookSessionReadOnly
    ? normalizeArray(worldbookSearch.results)
    : decorateActivatedWorldbookCandidates(worldbookSearch.results, activationResult);
  const activeSessionWorldbook = getActiveWorldbookSessionCandidates(catalog, sessionContext, {
    now: context.worldbookSessionNow,
    consume: !worldbookSessionReadOnly && context.worldbookSessionConsume !== false
  });
  const effectiveWorldbookResults = activatedWorldbookResults.concat(
    activeSessionWorldbook.filter((item) => !activatedWorldbookResults.some((hit) => normalizeText(hit.moduleId || hit.id) === normalizeText(item.moduleId || item.id)))
  );
  worldbookSearch.sessionState = {
    enabled: config.PERSONA_WORLDBOOK_SESSION_STATE_ENABLED !== false,
    readOnly: worldbookSessionReadOnly,
    activated: activationResult.activated,
    skipped: activationResult.skipped,
    active: activeSessionWorldbook.map((item) => ({
      moduleId: item.moduleId || item.id,
      activationState: item.activationState,
      linkedExamples: normalizeArray(item.linkedExamples || item.exampleIds)
    }))
  };
  const localModules = normalizeArray(localRecall.modules)
    .filter((item) => worldbookEnabled || !normalizeText(item?.id).startsWith('wb_mizuki_'));
  const candidateIds = mergeCandidateIdsWithWorldbookSearch(ruleCandidates, effectiveWorldbookResults);
  for (const item of localModules) {
    if (normalizeText(item?.id)) candidateIds.add(item.id);
  }
  const localById = new Map(localModules.map((item) => [normalizeText(item?.id), item]).filter(([id]) => Boolean(id)));
  const candidates = catalog.modules
    .filter((item) => candidateIds.has(item.id))
    .filter((item) => item.phase === 'all' || item.phase === phase)
    .map((item) => {
      const local = localById.get(item.id);
      if (!local) return item;
      return {
        ...item,
        localPromptRecall: local.localPromptRecall,
        worldbookScore: local.worldbookScore || item.worldbookScore,
        worldbookMatchMode: local.worldbookMatchMode || item.worldbookMatchMode
      };
    });
  const sorted = sortCandidatesWithWorldbookScores(candidates, effectiveWorldbookResults);
  sorted.sort((a, b) => {
    const aScore = Number(a.localPromptRecall?.score || 0) || 0;
    const bScore = Number(b.localPromptRecall?.score || 0) || 0;
    if (bScore !== aScore) return bScore - aScore;
    return 0;
  });
  sorted.personaWorldbookSearch = worldbookSearch.diagnostics;
  sorted.localPromptRecall = {
    ok: localRecall.ok === true,
    reason: normalizeText(localRecall.reason),
    usedEmbedding: localRecall.usedEmbedding === true,
    selected: localModules.map((item) => item.id)
  };
  const pruned = prunePersonaModuleCandidates(sorted, context, {
    maxCandidates: context.maxPersonaModuleCandidates
  });
  pruned.personaWorldbookSearch = {
    ...(worldbookSearch.diagnostics || {}),
    sessionState: worldbookSearch.sessionState
  };
  pruned.localPromptRecall = sorted.localPromptRecall;
  return pruned;
}

function buildPlannerPersonaModuleCatalog(personaModuleCatalog = [], context = {}, options = {}) {
  const catalog = loadPersonaModuleCatalog();
  const ruleCandidates = buildPersonaModuleCandidates(context);
  const lexicalResults = shouldUseWorldbookSearch(context)
    ? searchPersonaWorldbookLexical(catalog, normalizeText(context.question || context.routePrompt || ''), {
      limit: options.limit || config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT
    })
    : [];
  const limit = Math.max(0, Number(options.limit || config.PERSONA_WORLDBOOK_PLANNER_CANDIDATE_LIMIT || 12) || 12);
  const rankedWorldbookIds = new Set(
    ruleCandidates
      .filter((item) => normalizeText(item.id).startsWith('wb_mizuki_'))
      .map((item) => item.id)
      .concat(lexicalResults.map((item) => item.moduleId || item.id))
      .filter((id, index, list) => id && list.indexOf(id) === index)
      .slice(0, limit)
  );
  return normalizeArray(personaModuleCatalog).filter((item) => {
    const moduleId = normalizeText(item?.moduleId || item?.id);
    if (!moduleId.startsWith('wb_mizuki_')) return true;
    return rankedWorldbookIds.has(moduleId);
  });
}

function selectPersonaModules(decision = {}, context = {}) {
  const catalog = loadPersonaModuleCatalog();
  const byId = new Map(catalog.modules.map((item) => [item.id, item]));
  const promptMode = resolveMainReplyPromptMode({
    ...context,
    promptMode: context.promptMode || decision.promptMode || context.mainReplyPromptMode || decision.mainReplyPromptMode
  });
  const defaultLimit = getDefaultPersonaModuleLimit(promptMode);
  const maxActive = Math.max(0, Number(
    decision?.maxActiveModules
    || context.maxActiveModules
    || defaultLimit
    || catalog.defaultMaxActiveModules
    || 1
  ) || 1);
  const conservativePromptMode = isBalancedOrMinimalPromptMode(promptMode);
  const requested = normalizeArray(decision?.personaModules).map((item) => normalizeText(item)).filter(Boolean);
  const candidates = normalizeArray(context.personaModuleCandidates).length > 0
    ? normalizeArray(context.personaModuleCandidates)
    : buildPersonaModuleCandidates(context);
  const fallbackIds = candidates.map((item) => item.id);
  const stickyWorldbookIds = fallbackIds.filter((id) => (
    normalizeText(id).startsWith('wb_mizuki_')
    && candidates.some((item) => item.id === id && item.activationState)
  ));
  const candidateById = new Map(candidates.map((item) => [normalizeText(item.id), item]).filter(([id]) => Boolean(id)));
  const scoredWorldbookIds = fallbackIds.filter((id) => (
    normalizeText(id).startsWith('wb_mizuki_')
    && !stickyWorldbookIds.includes(id)
    && candidates.some((item) => item.id === id && Number(item.worldbookScore || 0) > 0)
  )).sort((a, b) => {
    const aItem = candidateById.get(a) || {};
    const bItem = candidateById.get(b) || {};
    const aScore = Number(aItem.worldbookScore || aItem.candidateScore || 0) || 0;
    const bScore = Number(bItem.worldbookScore || bItem.candidateScore || 0) || 0;
    if (bScore !== aScore) return bScore - aScore;
    return Number(aItem.priority || 100) - Number(bItem.priority || 100) || a.localeCompare(b);
  });
  const sceneIds = fallbackIds.filter((id) => id === 'scene_private_chat' || id === 'scene_group_insert');
  const emotionIds = fallbackIds.filter((id) => isEmotionPersonaModule(id));
  const conservativeFallbackIds = conservativePromptMode
    ? Array.from(new Set([
      context.chatType === 'group' ? 'scene_group_insert' : '',
      context.chatType === 'private' ? 'scene_private_chat' : '',
      ...sceneIds,
      ...stickyWorldbookIds,
      ...scoredWorldbookIds,
      ...emotionIds,
      ...fallbackIds.filter((id) => !String(id || '').startsWith('wb_mizuki_'))
    ].filter(Boolean)))
    : fallbackIds;
  const desiredIds = requested.length > 0 ? requested : fallbackIds;
  const effectiveDesiredIds = requested.length > 0
    ? requested
    : conservativeFallbackIds;
  const selected = [];
  const blocked = new Set();
  const usedSlots = new Set();
  let selectedEmotionCount = 0;
  const skipped = [];

  for (const id of effectiveDesiredIds) {
    if (selected.length >= maxActive) {
      skipped.push({ id, reason: 'max_active_reached' });
      continue;
    }
    const moduleItem = byId.get(id);
    if (!moduleItem) {
      skipped.push({ id, reason: 'not_found' });
      continue;
    }
    if (blocked.has(id)) {
      skipped.push({ id, reason: 'conflicted_by_selected' });
      continue;
    }
    if (moduleItem.slot && moduleItem.slot !== 'general' && usedSlots.has(moduleItem.slot)) {
      skipped.push({ id, reason: `slot_taken:${moduleItem.slot}` });
      continue;
    }
    if (conservativePromptMode && isEmotionPersonaModule(id) && selectedEmotionCount >= 1) {
      skipped.push({ id, reason: 'emotion_slot_taken' });
      continue;
    }
    selected.push(moduleItem);
    if (isEmotionPersonaModule(id)) selectedEmotionCount += 1;
    if (moduleItem.slot && moduleItem.slot !== 'general') usedSlots.add(moduleItem.slot);
    for (const conflictId of moduleItem.conflictsWith) blocked.add(conflictId);
  }

  return {
    selected,
    candidates,
    activeWorldbookIds: selected
      .map((item) => normalizeText(item.id))
      .filter((id) => id.startsWith('wb_mizuki_')),
    linkedExamples: Array.from(new Set(selected.flatMap((item) => normalizeArray(item.linkedExamples || item.exampleIds)))),
    maxActive,
    selectionReason: {
      requestedIds: requested,
      fallbackIds,
      effectiveFallbackIds: conservativePromptMode ? conservativeFallbackIds : fallbackIds,
      promptMode,
      usedSlots: Array.from(usedSlots),
      skipped
    }
  };
}

function diagnosePersonaModules(input = {}) {
  const candidates = buildPersonaModuleCandidates(input);
  const selection = selectPersonaModules(input?.decision || {}, input);
  const sessionKey = input.sessionKey || input.sessionId || input.routeMeta?.sessionKey || input.routeMeta?.session_key || '';
  return {
    question: normalizeText(input.question),
    phase: inferPhase(input),
    candidates: candidates.map((item) => ({
      id: item.id,
      slot: item.slot,
      priority: item.priority,
      tokenCost: item.tokenCost,
      conflictsWith: item.conflictsWith,
      runtimeMeta: normalizeWorldbookRuntimeMeta(item),
      activationState: item.activationState || null,
      linkedExamples: normalizeArray(item.linkedExamples || item.exampleIds)
    })),
    selected: selection.selected.map((item) => ({
      id: item.id,
      slot: item.slot,
      tokenCost: item.tokenCost,
      activationState: item.activationState || null,
      linkedExamples: normalizeArray(item.linkedExamples || item.exampleIds)
    })),
    selectionReason: selection.selectionReason,
    activeWorldbookIds: selection.activeWorldbookIds,
    linkedExamples: selection.linkedExamples,
    worldbookSessionState: getWorldbookSessionState(sessionKey),
    totalTokenCost: selection.selected.reduce((sum, item) => sum + Number(item.tokenCost || 0), 0)
  };
}

function loadPersonaModuleText(moduleId = '') {
  const catalog = loadPersonaModuleCatalog();
  const target = catalog.modules.find((item) => item.id === normalizeText(moduleId));
  if (!target) return '';
  if (isPrimaryReadEnabled() && normalizeText(target.id).startsWith('wb_mizuki_')) {
    const entry = getWorldbookEntry(target.id);
    if (entry && normalizeText(entry.body)) return normalizeText(entry.body);
    return '';
  }
  const filePath = path.join(config.PROMPTS_DIR, ...String(target.path).split('/'));
  return normalizeText(safeReadText(filePath, ''));
}

module.exports = {
  MODULE_CATALOG_PATH,
  buildPersonaModuleCandidatesAsync,
  buildPersonaModuleCandidates,
  buildPlannerPersonaModuleCatalog,
  diagnosePersonaModules,
  getPersonaModuleCatalogSummary,
  ensureWorldbookSqlImported,
  loadPersonaModuleCatalog,
  loadPersonaModuleText,
  prunePersonaModuleCandidates,
  selectPersonaModules
};
