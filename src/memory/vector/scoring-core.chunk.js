function getMemoryLayer(doc = {}) {
  const type = normalizeType(doc.type);
  const kind = normalizeMemoryKind(doc.memoryKind ?? doc.meta?.memoryKind);
  const source = classifyDocSource(doc);
  if (type === 'identity' || type === 'summary' || type === 'impression' || kind === 'persona_core') return 'stable_profile';
  if (type === 'like' || type === 'dislike' || type === 'personality' || type === 'hobby' || kind === 'style' || kind === 'jargon') return 'preference_relationship';
  if (source === 'task' || kind === 'task' || type === 'goal') return 'task_commitment';
  if (source === 'recent' || type === 'episode' || type === 'topic') return 'recent_continuity';
  if (normalizeStatus(doc.status, STATUS_ACTIVE) === STATUS_CANDIDATE) return 'candidate';
  return 'personal_fact';
}

function deriveDocCategoryMetadata(doc = {}) {
  try {
    return require('../../../utils/memory-v3/categoryMetadata').deriveMemoryMetadata(doc);
  } catch (_) {
    return { category: '', tags: [], intent: '', privacyLevel: 'private' };
  }
}

function docMatchesCategoryFilters(doc = {}, options = {}) {
  try {
    return require('../../../utils/memory-v3/categoryMetadata').matchesMemoryMetadataFilters(doc, options);
  } catch (_) {
    return true;
  }
}

function calcCategoryBoost(doc = {}, options = {}) {
  try {
    return require('../../../utils/memory-v3/categoryMetadata').categoryFacetBoost(doc, options.queryFacet || options.facet || '');
  } catch (_) {
    return 0;
  }
}

function getLayerHalfLifeDays(doc = {}) {
  const layer = getMemoryLayer(doc);
  const rule = getTypeRule(doc.type);
  if (layer === 'stable_profile') return Math.max(Number(rule.halfLifeDays || 0), 1200);
  if (layer === 'preference_relationship') return Math.max(Number(rule.halfLifeDays || 0), 900);
  if (layer === 'task_commitment') return Math.min(Math.max(Number(rule.halfLifeDays || 0), 90), 240);
  if (layer === 'recent_continuity') return normalizeType(doc.type) === 'topic' ? Math.max(3, Number(config.MEMORY_TOPIC_TTL_DAYS) || 21) / 2 : 90;
  if (layer === 'candidate') return 45;
  return Math.max(1, Number(rule.halfLifeDays) || 180);
}

function calcMemoryStrength(doc = {}, options = {}) {
  const enabled = config.MEMORY_FORGETTING_CURVE_ENABLED !== false;
  const now = nowTs();
  const rule = getTypeRule(doc.type);
  const minRecency = enabled ? Math.max(0, Math.min(1, Number(rule.minRecency ?? 0.5))) : Math.max(0, Math.min(1, Number(rule.minRecency ?? 0.5)));
  const anchor = Number(doc.lastRecalledAt || doc.lastAccessAt || doc.lastConfirmedAt || doc.updatedAt || doc.createdAt || doc.ts || now) || now;
  const ageDays = Math.max(0, (now - anchor) / (24 * 3600 * 1000));
  const halfLife = enabled ? getLayerHalfLifeDays(doc) : Math.max(1, Number(rule.halfLifeDays) || 180);
  const decayScore = minRecency + ((1 - minRecency) * Math.exp(-ageDays / Math.max(1, halfLife)));
  const recallCount = Math.max(0, Number(doc.recallCount ?? doc.accessCount ?? 0) || 0);
  const stabilityScore = Math.max(0, Math.min(1, Number(doc.stabilityScore ?? doc.meta?.stabilityScore ?? 0) || 0));
  const rehearsalBoost = config.MEMORY_REHEARSAL_ENABLED === false
    ? 0
    : Math.min(0.18, (Math.log1p(recallCount) * 0.03) + (stabilityScore * 0.08));
  const layer = getMemoryLayer(doc);
  const continuityBonus = shouldBiasToContinuity(String(options.queryFacet || ''))
    && (layer === 'recent_continuity' || layer === 'task_commitment')
    ? Math.max(0, Number(config.MEMORY_CONTINUITY_RECALL_BONUS || 0.18) || 0.18)
    : 0;
  const memoryStrength = Math.max(0, Math.min(1.5, decayScore + rehearsalBoost + continuityBonus));
  const intervalDays = Math.max(1, Math.round(halfLife * Math.max(0.15, Math.min(1, 1 - stabilityScore))));
  return {
    layer,
    decayScore,
    rehearsalBoost,
    continuityBonus,
    memoryStrength,
    forgettingReason: ageDays > halfLife ? 'past_half_life' : (recallCount > 0 ? 'rehearsed' : 'fresh_or_unrehearsed'),
    nextReviewAt: anchor + (intervalDays * 24 * 3600 * 1000)
  };
}
function calcRecencyScore(doc) {
  const rule = getTypeRule(doc.type);
  const ageDays = Math.max(0, (nowTs() - (doc.updatedAt || doc.ts || nowTs())) / (24 * 3600 * 1000));
  const halfLife = Math.max(1, Number(rule.halfLifeDays) || 180);
  const decay = Math.exp((-Math.log(2) * ageDays) / halfLife);
  return Math.max(rule.minRecency, decay);
}

function calcOverlapBoost(queryTokens, doc) {
  const docTokens = Object.keys(doc.tf || {});
  if (!queryTokens.length || !docTokens.length) return 0;

  const querySet = new Set(queryTokens);
  let overlap = 0;
  for (const token of docTokens) {
    if (querySet.has(token)) overlap += 1;
  }
  return overlap / querySet.size;
}

function calcLexicalScore(question = '', doc = {}, index = {}) {
  const queryCanonical = canonicalizeText(question);
  const queryTokens = tokenize(`${question} ${queryCanonical}`);
  if (!queryTokens.length) return 0;
  const totalDocs = Math.max(1, Number(index.totalDocs || Object.keys(index.docs || {}).length) || 1);
  const queryVec = buildTfidfVec(queryTokens, index.df || {}, totalDocs);
  const docVec = docVecFromTf(doc, index.df || {}, totalDocs);
  return cosineMap(queryVec, docVec);
}

function calcDirectBoost(queryCanonical, doc) {
  const docCanonical = String(doc.canonicalText || '');
  if (!queryCanonical || !docCanonical) return 0;
  if (queryCanonical === docCanonical) return 0.35;
  if (queryCanonical.includes(docCanonical) || docCanonical.includes(queryCanonical)) return 0.22;
  return 0;
}

function calcParticipantBoost(doc = {}, options = {}) {
  const requested = normalizeStringArray(options.participants || []);
  const existing = normalizeStringArray(doc.participants || []);
  if (!requested.length || !existing.length) {
    return { score: 0, matched: [] };
  }
  const requestedSet = new Set(requested.map((item) => item.toLowerCase()));
  const matched = existing.filter((item) => requestedSet.has(item.toLowerCase()));
  if (!matched.length) return { score: -0.08, matched: [] };
  return {
    score: Math.min(0.18, matched.length * 0.09),
    matched
  };
}

function calcGraphBoost(question = '', doc = {}, options = {}) {
  if (!config.MEMORY_GRAPH_RERANK_ENABLED) return 0;
  const q = sanitizeText(question).toLowerCase();
  if (!q) return 0;
  const entities = normalizeStringArray(doc.entities || []);
  const relations = normalizeStringArray(doc.relations || []);
  let score = 0;
  for (const entity of entities) {
    if (q.includes(String(entity).toLowerCase())) score += 0.06;
  }
  for (const relation of relations) {
    const parts = String(relation || '').split('->').map((item) => sanitizeOptionalText(item).toLowerCase()).filter(Boolean);
    if (parts.length < 2) continue;
    if (parts.every((part) => q.includes(part))) score += 0.08;
  }
  if (options.participants && options.participants.length && entities.length) {
    score += Math.min(0.04, entities.length * 0.01);
  }
  return Math.min(0.22, score);
}

function calcScopeBoost(doc = {}, options = {}) {
  let score = 0;
  const requestedScopeType = normalizeScopeType(options.scopeType);
  const docScopeType = normalizeScopeType(doc.scopeType);
  if (requestedScopeType && docScopeType === requestedScopeType) score += 0.08;
  if (options.groupId && String(options.groupId) === String(doc.groupId || '')) score += 0.06;
  if (options.taskType && String(options.taskType) === String(doc.taskType || '')) score += 0.05;
  if (options.routePolicyKey && String(options.routePolicyKey) === String(doc.routePolicyKey || '')) score += 0.04;
  if (options.topRouteType && String(options.topRouteType) === String(doc.topRouteType || '')) score += 0.04;
  if (options.sessionId && String(options.sessionId) === String(doc.sessionId || '')) score += 0.03;
  return score;
}

function calcTierBoost(doc = {}) {
  const tier = normalizeTier(doc.tier) || importanceToTier(doc.importance, doc.confidence, doc.type);
  if (tier === 'S') return 0.12;
  if (tier === 'A') return 0.08;
  if (tier === 'C') return -0.03;
  return 0.02;
}

function calcConfidenceBoost(doc = {}) {
  const confidence = clamp(doc.confidence ?? 0.7, 0.01, 1);
  return (confidence - 0.5) * 0.22;
}

function calcDuplicationPenalty(doc = {}, seenCanonical = new Set()) {
  const canonical = String(doc.canonicalText || '').trim();
  if (!canonical) return 0;
  return seenCanonical.has(canonical) ? 0.24 : 0;
}

function formatReason(doc, lexical, overlap, direct) {
  const reasons = [];
  if (direct >= 0.2) reasons.push('direct-match');
  if (lexical >= 0.2) reasons.push('lexical');
  if (overlap >= 0.3) reasons.push('token-overlap');
  if (doc.type === 'goal') reasons.push('goal-priority');
  if (doc.type === 'impression') reasons.push('user-impression');
  if (doc.type === 'topic') reasons.push('recent-topic');
  if (normalizeStatus(doc.status) === STATUS_CANDIDATE) reasons.push('candidate');
  if (doc.sourceKind === 'explicit') reasons.push('explicit');
  if (doc.type === 'episode') reasons.push('episode');
  return reasons.join(', ') || 'scored';
}

function isStyleOrToneQuery(question = '', options = {}) {
  if (options.forceSignalRecall) return true;
  const text = sanitizeText(question).toLowerCase();
  if (!text) return false;
  return /(\bstyle\b|\btone\b|\bvoice\b|\bjargon\b|\bslang\b|\bphrase\b|\bphrasing\b|\bsound like\b|\blike the user\b|\blike the group\b|语气|风格|说话方式|表达方式|口头禅|黑话|群话|群友|像本人|像群里)/i.test(text);
}

function applySignalRecallAdjustments(score, doc, question = '', options = {}) {
  const kind = getItemMemoryKind(doc);
  if (!isSignalMemoryKind(kind)) return score;
  const styleLikeQuery = isStyleOrToneQuery(question, options);
  if (styleLikeQuery) {
    return score * (kind === 'style' ? 1.08 : 1.04);
  }
  return score * 0.72;
}

function touchAccessStats(userId, ids) {
  if (!Array.isArray(ids) || ids.length === 0) return;

  const wanted = new Set(ids.map((id) => String(id)));
  ensureShardStateHydrated();
  let changed = false;
  for (const entry of listAllShardEntries()) {
    let shardChanged = false;
    for (const item of entry.items.items) {
      if (String(item.userId) !== String(userId)) continue;
      if (!wanted.has(String(item.id))) continue;
      const touchedAt = nowTs();
      item.lastAccessAt = touchedAt;
      if (config.MEMORY_RECALL_TOUCH_ENABLED !== false) item.lastRecalledAt = touchedAt;
      item.accessCount = Math.max(0, Number(item.accessCount || 0)) + 1;
      item.recallCount = Math.max(0, Number(item.recallCount || 0)) + 1;
      item.stabilityScore = clamp((Number(item.stabilityScore || 0) || 0) + 0.03, 0, 1);
      const strength = calcMemoryStrength(item, {});
      item.memoryStrength = strength.memoryStrength;
      item.nextReviewAt = strength.nextReviewAt;
      shardChanged = true;
      changed = true;
    }
    if (!shardChanged) continue;
    entry.index = materializeShardIndex(entry.items.items, entry.meta);
    getShardItemsStore(entry.meta).replace(entry.items);
    getShardIndexStore(entry.meta).replace(entry.index);
    updateManifestForShard(entry);
  }

  if (changed) {
    syncCompatSnapshots();
  }
}

function filterDocIdsByOptions(docs, userId, options = {}) {
  const wantedKinds = getRequestedMemoryKinds(options);
  return Object.keys(docs).filter((id) => {
    const doc = docs[id];
    if (String(doc.userId) !== String(userId)) return false;
    if (isAssistantPersonaPollution(doc)) return false;
    if (doc.notRecallable === true || doc.meta?.notRecallable === true || String(doc.meta?.recallVerification?.status || '').toLowerCase() === 'not_recallable') return false;
    if (options.scopeType && normalizeScopeType(doc.scopeType) !== normalizeScopeType(options.scopeType)) return false;
    if (options.groupId && String(doc.groupId || '') !== String(options.groupId || '')) return false;
    if (options.taskType && String(doc.taskType || '') !== String(options.taskType || '')) return false;
    if (options.routePolicyKey && String(doc.routePolicyKey || '') !== String(options.routePolicyKey || '')) return false;
    if (options.topRouteType && String(doc.topRouteType || '') !== String(options.topRouteType || '')) return false;
    if (options.agentName && String(doc.agentName || '') !== String(options.agentName || '')) return false;
    if (options.toolName && String(doc.toolName || '') !== String(options.toolName || '')) return false;
    if (options.sessionId && String(doc.sessionId || '') !== String(options.sessionId || '')) return false;
    if (options.status && normalizeStatus(doc.status, STATUS_ACTIVE) !== normalizeStatus(options.status, STATUS_ACTIVE)) return false;
    if (!docMatchesCategoryFilters(doc, options)) return false;
    if (options.sourceKind && String(doc.sourceKind || '').toLowerCase() !== String(options.sourceKind || '').toLowerCase()) return false;
    if (options.memoryKind && getItemMemoryKind(doc) !== normalizeMemoryKind(options.memoryKind)) return false;
    if (options.memoryKind === 'episode' && options.rollupLevel && String(doc.rollupLevel || '') !== String(options.rollupLevel || '')) return false;
    if (options.episodeDay && String(doc.episodeDay || '') !== String(options.episodeDay || '')) return false;
    if (options.excludeTopics && normalizeType(doc.type) === 'topic') return false;
    if (options.excludeCandidates && normalizeStatus(doc.status) === STATUS_CANDIDATE) return false;
    if (wantedKinds.length > 0 && !wantedKinds.includes(getItemMemoryKind(doc))) return false;
    return true;
  });
}

function collectDocsFromShardCategories(categories = []) {
  const selected = {};
  const wanted = new Set((Array.isArray(categories) ? categories : []).map((item) => normalizeShardCategory(item)));
  for (const entry of listAllShardEntries()) {
    if (!wanted.has(entry.meta.category)) continue;
    Object.assign(selected, entry.index?.docs || {});
  }
  return selected;
}

function resolveUnifiedShardCategories(options = {}) {
  const categories = new Set(['personal', 'journal', 'style']);
  if (options.includeTask !== false) categories.add('task');
  const groupIds = normalizeStringArray(options.groupIds || (options.groupId ? [options.groupId] : []), MAX_METADATA_LIST);
  if (groupIds.length > 0 && options.includeGroup !== false) {
    categories.add('group');
    categories.add('jargon');
  }
  if (options.includeEpisodes === false) categories.delete('journal');
  if (options.includeSignals === false) {
    categories.delete('style');
    categories.delete('jargon');
  }
  return Array.from(categories);
}

function classifyDocSource(doc = {}) {
  const memoryKind = getItemMemoryKind(doc);
  if (memoryKind === 'style') return 'style';
  if (memoryKind === 'jargon') return 'jargon';
  if (memoryKind === 'episode' || normalizeType(doc.type) === 'episode' || String(doc.sourceKind || '').toLowerCase() === 'journal') {
    return 'journal';
  }
  const scopeType = normalizeScopeType(doc.scopeType);
  if (scopeType === 'task') return 'task';
  if (scopeType === 'group') return 'group';
  return 'personal';
}

function filterUnifiedDocIds(docs, userId, options = {}) {
  const baseUserId = sanitizeOptionalText(userId);
  const requestedSource = sanitizeOptionalText(options.sourceFilter || options.source).toLowerCase() || 'all';
  const groupIds = normalizeStringArray(options.groupIds || (options.groupId ? [options.groupId] : []), MAX_METADATA_LIST);
  const groupOwners = new Set(groupIds.map((groupId) => `group:${groupId}`));
  const includePersonal = options.includePersonal !== false;
  const includeTask = options.includeTask !== false;
  const includeGroup = options.includeGroup !== false;
  const includeSignals = options.includeSignals !== false;
  const includeEpisodes = options.includeEpisodes !== false;
  const allowedSources = requestedSource === 'all'
    ? new Set(['personal', 'task', 'group', 'journal', 'style', 'jargon'])
    : new Set([requestedSource]);

  return Object.keys(docs).filter((id) => {
    const doc = docs[id];
    const source = classifyDocSource(doc);
    if (isAssistantPersonaPollution(doc)) return false;
    if (doc.notRecallable === true || doc.meta?.notRecallable === true || String(doc.meta?.recallVerification?.status || '').toLowerCase() === 'not_recallable') return false;
    if (!allowedSources.has(source)) return false;
    if (!docMatchesCategoryFilters(doc, options)) return false;

    const ownerId = String(doc.userId || '');
    if (source === 'group' || source === 'jargon') {
      if (!includeGroup) return false;
      if (!groupOwners.size || !groupOwners.has(ownerId)) return false;
    } else if (ownerId !== baseUserId) {
      return false;
    }

    if (!includePersonal && source === 'personal') return false;
    if (!includeTask && source === 'task') return false;
    if (!includeSignals && (source === 'style' || source === 'jargon')) return false;
    if (!includeEpisodes && source === 'journal') return false;

    if (options.memoryKind && getItemMemoryKind(doc) !== normalizeMemoryKind(options.memoryKind)) return false;
    if (options.status && normalizeStatus(doc.status, STATUS_ACTIVE) !== normalizeStatus(options.status, STATUS_ACTIVE)) return false;
    if (options.groupId && source !== 'group' && source !== 'jargon' && options.participantStrict) return false;
    return true;
  });
}

