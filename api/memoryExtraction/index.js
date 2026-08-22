const config = require('../../config');
const { postWithRetry } = require('../httpClient');
const { extractMessageContent, extractJsonSafely } = require('../parser');
const { writeMemoryBatch } = require('../../utils/memory-v3');
const {
  addUserFact,
  addProfileItem,
  applyAffinityProposal
} = require('../../utils/memory');
const { addTaskMemoryWithVectorBackfill } = require('../../utils/taskMemory');
const { addGroupMemoryWithVectorBackfill } = require('../../utils/groupMemory');
const { sanitizeUntrustedContent, shouldBlockMemoryLearning } = require('../../utils/promptSecurity');
const {
  ensureChatCompletionsUrl,
  normalizeTextContent,
  getMemoryModelName,
  getMemoryApiBaseUrl,
  getMemoryApiKey,
  getTemperature,
  getTopP,
  getMaxTokens,
  getRetries,
  resolveLearningIntent,
  resolvePostReplyMemoryMode
} = require('./runtimeConfig');
const {
  shouldPersistMemoryCandidate,
  extractParticipantsFromText,
  extractEntitiesFromConversation,
  inferRelations,
  normalizeText,
  normalizeStringArray,
  normalizeEvidenceItems,
  buildLearningDecisionMeta,
  getDefaultStatusForType,
  buildMemoryBaseMeta,
  classifyProfileExtraction,
  buildProfileConflictKeyForExtraction,
  resolveV3ProfileFieldKey,
  parseExplicitRemember,
  inferExplicitProfileType,
  shouldWriteLegacyProfileField,
  countStableProfileSignals,
  shouldPersistPersonaSupport,
  attachPendingMemoryV3Event
} = require('./profilePolicy');

async function flushMemoryWrites(vectorItems = [], options = {}) {
  if (!Array.isArray(vectorItems) || vectorItems.length === 0) {
    return { ids: [], accepted: [], rejected: [] };
  }
  return writeMemoryBatch(vectorItems, {
    ...options,
    phase: 'memory_extraction_write'
  });
}

function persistLearnedMemories(userId, type, values, confidence = 0.8, options = {}) {
  const vectorItems = Array.isArray(options.vectorItems) ? options.vectorItems : [];
  const fieldKey = String(options.fieldKey || type || '').trim().toLowerCase();

  for (const raw of values) {
    const value = String(raw || '').trim();
    const learningGate = shouldBlockMemoryLearning(value, fieldKey, options);
    if (learningGate.blocked) continue;
    if (!shouldPersistMemoryCandidate(type, value, confidence)) continue;
    const meta = buildMemoryBaseMeta(type, confidence, { ...options, fieldKey, value, userId });

    if (type === 'fact') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: value, type: 'fact', weight: 1.15, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addUserFact(userId, value, 30);
      continue;
    }

    if (type === 'identity') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `identity: ${value}`, type: 'identity', weight: 1.25, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) {
        addProfileItem(userId, 'identities', value, 20);
        addUserFact(userId, value, 30);
      }
      continue;
    }

    if (type === 'personality') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `personality: ${value}`, type: 'personality', weight: 1.1, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addProfileItem(userId, 'personality_traits', value, 20);
      continue;
    }

    if (type === 'hobby') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `hobby: ${value}`, type: 'hobby', weight: 1.08, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addProfileItem(userId, 'hobbies', value, 20);
      continue;
    }

    if (type === 'like') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `likes: ${value}`, type: 'like', weight: 1.05, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addProfileItem(userId, 'likes', value, 20);
      continue;
    }

    if (type === 'dislike') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `dislikes: ${value}`, type: 'dislike', weight: 1.05, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addProfileItem(userId, 'dislikes', value, 20);
      continue;
    }

    if (type === 'goal') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `goal: ${value}`, type: 'goal', weight: 1.2, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addProfileItem(userId, 'goals', value, 20);
      continue;
    }

    if (type === 'impression') {
      const itemMeta = { ...meta, fieldKey: fieldKey || 'persona_impression_support' };
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `impression support: ${value}`, type: 'fact', weight: 1.18, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey || 'persona_impression_support', meta: itemMeta }, userId, type, value, itemMeta, options));
      continue;
    }

    if (type === 'summary') {
      const itemMeta = { ...meta, fieldKey: fieldKey || 'persona_summary_support' };
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `summary support: ${value}`, type: 'fact', weight: 1.16, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey || 'persona_summary_support', meta: itemMeta }, userId, type, value, itemMeta, options));
      continue;
    }

    if (type === 'topic') {
      vectorItems.push(attachPendingMemoryV3Event({ userId, text: `recent topic: ${value}`, type: 'topic', weight: 0.95, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta }, userId, type, value, meta, options));
      if (shouldWriteLegacyProfileField(type, meta, options)) addProfileItem(userId, 'recent_topics', value, 12);
    }
  }

  if (!Array.isArray(options.vectorItems) && vectorItems.length > 0) {
    flushMemoryWrites(vectorItems, options).catch((error) => {
      console.error('memory vector write backfill failed:', error?.message || error);
    });
  }
}

function getStyleOrJargonConfidenceFloor(base = 0.78) {
  return Math.max(base, Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72) + 0.02);
}

function sanitizeMemorySignalText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function isSensitiveOrAggressiveSignal(text = '') {
  const value = sanitizeMemorySignalText(text).toLowerCase();
  if (!value) return true;
  return /(辱骂|仇恨|攻击|羞辱|羞耻|种族|性癖|隐私|住址|电话|身份证|政治立场|宗教|辱骂性|脏话|操你|傻逼|滚|sb|fuck|bitch|slur|doxx|address|phone|private)/i.test(value);
}

function isReusableStyleSignal(text = '') {
  const value = sanitizeMemorySignalText(text);
  if (!value || value.length < 4 || value.length > 80) return false;
  if (isSensitiveOrAggressiveSignal(value)) return false;
  return /(简短|直接|收束|先.*再|步骤|条列|少铺垫|口吻|表达|语气|风格|偏|习惯|避免|不要|concise|brief|direct|structured|step|tone|phrasing|avoid)/i.test(value);
}

function isReusableJargonSignal(text = '') {
  const value = sanitizeMemorySignalText(text);
  if (!value || value.length < 2 || value.length > 80) return false;
  if (isSensitiveOrAggressiveSignal(value)) return false;
  return /(简称|叫法|黑话|缩写|默认理解|惯用|固定句式|群里|term|nickname|short for|refers to|means|shorthand)/i.test(value);
}

function buildStyleMemoryItem(userId, text, role, confidence, options = {}) {
  const participants = Array.isArray(options.participants) ? options.participants : [];
  const entities = Array.isArray(options.entities) ? options.entities : [];
  const relations = Array.isArray(options.relations) ? options.relations : [];
  return {
    userId,
    text: `style: ${sanitizeMemorySignalText(text)}`,
    type: 'fact',
    weight: 1.02,
    source: 'style_extractor',
    confidence,
    scopeType: 'personal',
    sessionId: options.sessionId,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
    agentName: options.agentName,
    toolName: options.toolName,
      channelId: options.channelId,
      status: 'active',
      sourceKind: 'extractor',
      sourceSessionId: options.sessionId,
      semanticSlot: role === 'avoid' ? 'style_avoid' : 'style_pattern',
      participants,
      entities,
      relations,
    meta: {
      source: 'style_extractor',
      confidence,
      importanceTier: role === 'avoid' ? 'B' : 'C',
        sourceKind: 'extractor',
        status: 'active',
        memoryKind: 'style',
        fieldKey: role === 'avoid' ? 'style_avoid' : 'style_pattern',
        styleRole: role,
        participants,
        entities,
      relations
    }
  };
}

function buildJargonMemoryItem(groupId, text, role, confidence, options = {}) {
  const participants = Array.isArray(options.participants) ? options.participants : [];
  const entities = Array.isArray(options.entities) ? options.entities : [];
  const relations = Array.isArray(options.relations) ? options.relations : [];
  return {
    userId: `group:${groupId}`,
    text: `group jargon: ${sanitizeMemorySignalText(text)}`,
    type: 'fact',
    weight: 0.98,
    source: 'group_jargon_extractor',
    confidence,
    scopeType: 'group',
    groupId,
    routePolicyKey: options.routePolicyKey,
    topRouteType: options.topRouteType,
      channelId: options.channelId,
      status: 'active',
      sourceKind: 'extractor',
      sourceSessionId: options.sessionId,
      semanticSlot: 'group_jargon',
      participants,
      entities,
      relations,
    meta: {
      source: 'group_jargon_extractor',
      confidence,
      importanceTier: 'C',
        sourceKind: 'extractor',
        status: 'active',
        memoryKind: 'jargon',
        fieldKey: 'group_jargon',
        jargonRole: role,
        participants,
        entities,
      relations
    }
  };
}

async function learnUserStyleMemory(userId, userText, botReply, options = {}) {
  const uid = String(userId || '').trim();
  if (!uid) return;

  const extractPrompt = `
You are a user style memory extractor. Return JSON only:
{
  "style_patterns": [],
  "style_avoid": [],
  "confidence": 0.0
}
Rules:
- only extract stable, reusable speaking-style patterns
- do not extract opinions, facts, private details, one-off emotions, attack language, or sensitive catchphrases
- style_patterns should describe preferred phrasing or rhythm
- style_avoid should describe stable wording or tone to avoid only when clearly repeated
- at most 1 item per array
- confidence must be between 0 and 1
- return empty arrays with confidence 0 if unsure
  `.trim();

  const conversation = `User: ${userText}\nAssistant: ${botReply}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: Math.min(getTemperature(), 0.35),
        top_p: Math.min(getTopP(), 0.88),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(180),
        stream: false
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return;

    const confidence = Number(obj.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < getStyleOrJargonConfidenceFloor(0.78)) return;

    const patterns = (Array.isArray(obj.style_patterns) ? obj.style_patterns : [])
      .map((item) => sanitizeMemorySignalText(item))
      .filter(isReusableStyleSignal)
      .slice(0, 1);
    const avoids = (Array.isArray(obj.style_avoid) ? obj.style_avoid : [])
      .map((item) => sanitizeMemorySignalText(item))
      .filter(isReusableStyleSignal)
      .slice(0, 1);

    const vectorItems = [];
    if (patterns[0]) vectorItems.push(buildStyleMemoryItem(uid, patterns[0], 'pattern', confidence, options));
    if (!patterns[0] && avoids[0]) vectorItems.push(buildStyleMemoryItem(uid, avoids[0], 'avoid', confidence, options));
    if (vectorItems.length > 0) await flushMemoryWrites(vectorItems, options);
  } catch (e) {
    console.error('style memory extraction failed:', e.message);
  }
}

async function learnGroupJargonMemory(userText, botReply, options = {}) {
  const groupId = String(options.groupId || '').trim();
  if (!groupId) return;

  const extractPrompt = `
You are a group jargon memory extractor. Return JSON only:
{
  "jargon_terms": [],
  "jargon_patterns": [],
  "confidence": 0.0
}
Rules:
- only extract stable group shorthand, nicknames, abbreviations, or fixed phrases with shared meaning
- do not extract sensitive content, insults, private facts, or one-off jokes
- at most 1 item per array
- confidence must be between 0 and 1
- return empty arrays with confidence 0 if unsure
  `.trim();

  const conversation = `Group message: ${userText}\nAssistant reply: ${botReply}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: Math.min(getTemperature(), 0.35),
        top_p: Math.min(getTopP(), 0.88),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(180),
        stream: false
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return;

    const confidence = Number(obj.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < getStyleOrJargonConfidenceFloor(0.8)) return;

    const terms = (Array.isArray(obj.jargon_terms) ? obj.jargon_terms : [])
      .map((item) => sanitizeMemorySignalText(item))
      .filter(isReusableJargonSignal)
      .slice(0, 1);
    const patterns = (Array.isArray(obj.jargon_patterns) ? obj.jargon_patterns : [])
      .map((item) => sanitizeMemorySignalText(item))
      .filter(isReusableJargonSignal)
      .slice(0, 1);

    const vectorItems = [];
    if (terms[0]) vectorItems.push(buildJargonMemoryItem(groupId, terms[0], 'term', confidence, options));
    if (!terms[0] && patterns[0]) vectorItems.push(buildJargonMemoryItem(groupId, patterns[0], 'pattern', confidence, options));
    if (vectorItems.length > 0) await flushMemoryWrites(vectorItems, options);
  } catch (e) {
    console.error('group jargon extraction failed:', e.message);
  }
}

async function learnTaskStrategy(userId, userText, botReply, options = {}) {
  if (!config.TASK_MEMORY_ENABLED) return;

  const extractPrompt = `
You are a task memory extractor. Return JSON only:
{
  "task_type": "",
  "trigger": "",
  "strategy": "",
  "avoid": "",
  "outcome": "success",
  "confidence": 0.0
}
Rules:
- task_type should describe the class of task, not the exact request text
- trigger should summarize when this strategy is useful
- strategy should be concise and reusable
- avoid should describe what to avoid only if there is a clear failure or pitfall
- outcome must be one of success, failure, unknown
- confidence must be between 0 and 1
- if there is no reusable task experience, return empty strings with confidence 0
  `.trim();

  const conversation = `User: ${userText}\nAssistant: ${botReply}\nRoutePolicyKey: ${String(options.routePolicyKey || '')}\nTopRouteType: ${String(options.topRouteType || '')}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: Math.min(getTemperature(), 0.4),
        top_p: Math.min(getTopP(), 0.9),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(220),
        stream: false,
        __trace: {
          source: 'memory_extraction',
          phase: 'extract_task_memory',
          purpose: 'task_memory_learning',
          userId: String(userId || ''),
          routePolicyKey: String(options.routePolicyKey || ''),
          topRouteType: String(options.topRouteType || ''),
          memoryInjected: false
        }
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return;

    const confidence = Number(obj.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < Math.max(0.65, Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72) - 0.05)) {
      return;
    }

    await addTaskMemoryWithVectorBackfill(userId, {
      taskType: obj.task_type,
      trigger: obj.trigger,
      strategy: obj.strategy,
      avoid: obj.avoid,
      outcome: obj.outcome,
      confidence,
      source: 'task_extractor',
      routePolicyKey: options.routePolicyKey,
      topRouteType: options.topRouteType,
      agentName: options.agentName,
      toolName: options.toolName,
      sessionId: options.sessionId,
      channelId: options.channelId,
      sourceKind: 'extractor',
      status: 'candidate',
      sourceSessionId: options.sessionId,
      participants: Array.isArray(options.participants) ? options.participants : [],
      entities: Array.isArray(options.entities) ? options.entities : [],
      relations: Array.isArray(options.relations) ? options.relations : []
    }, options);
  } catch (e) {
    console.error('task memory extraction failed:', e.message);
  }
}

async function learnGroupMemory(userText, botReply, options = {}) {
  const groupId = String(options.groupId || '').trim();
  if (!groupId) return;

  const extractPrompt = `
You are a group memory extractor. Return JSON only:
{
  "shared_facts": [],
  "shared_goals": [],
  "shared_topics": [],
  "confidence": 0.0
}
Rules:
- only extract group-level shared context, agreements, recurring topics, or common goals
- do not extract private user preferences or personal identity facts
- shared_topics should be recurring or ongoing, not one-off chatter
- confidence must be between 0 and 1
  `.trim();

  const conversation = `Group message: ${userText}\nAssistant reply: ${botReply}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: Math.min(getTemperature(), 0.4),
        top_p: Math.min(getTopP(), 0.9),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(220),
        stream: false
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return;

    const confidence = Number(obj.confidence || 0);
    if (!Number.isFinite(confidence) || confidence < Math.max(0.68, Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE || 0.72) - 0.02)) {
      return;
    }

    const sharedFacts = Array.isArray(obj.shared_facts) ? obj.shared_facts : [];
    const sharedGoals = Array.isArray(obj.shared_goals) ? obj.shared_goals : [];
    const sharedTopics = Array.isArray(obj.shared_topics) ? obj.shared_topics : [];

    for (const value of sharedFacts) {
      const text = String(value || '').trim();
      if (shouldBlockMemoryLearning(text, 'group_fact', options).blocked) continue;
      if (text) await addGroupMemoryWithVectorBackfill(groupId, text, 'fact', {
        confidence,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        sessionId: options.sessionId,
        channelId: options.channelId,
        sourceKind: 'extractor',
        status: 'candidate',
        sourceSessionId: options.sessionId,
        participants: Array.isArray(options.participants) ? options.participants : [],
        entities: Array.isArray(options.entities) ? options.entities : [],
        relations: Array.isArray(options.relations) ? options.relations : []
      }, 1.08, options);
    }
    for (const value of sharedGoals) {
      const text = String(value || '').trim();
      if (shouldBlockMemoryLearning(text, 'group_goal', options).blocked) continue;
      if (text) await addGroupMemoryWithVectorBackfill(groupId, `group goal: ${text}`, 'goal', {
        confidence,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        sessionId: options.sessionId,
        channelId: options.channelId,
        sourceKind: 'extractor',
        status: 'active',
        sourceSessionId: options.sessionId,
        participants: Array.isArray(options.participants) ? options.participants : [],
        entities: Array.isArray(options.entities) ? options.entities : [],
        relations: Array.isArray(options.relations) ? options.relations : []
      }, 1.15, options);
    }
    for (const value of sharedTopics) {
      const text = String(value || '').trim();
      if (shouldBlockMemoryLearning(text, 'group_topic', options).blocked) continue;
      if (text && text.length >= 4) {
        await addGroupMemoryWithVectorBackfill(groupId, `group topic: ${text}`, 'topic', {
          confidence,
          routePolicyKey: options.routePolicyKey,
          topRouteType: options.topRouteType,
          sessionId: options.sessionId,
          channelId: options.channelId,
          sourceKind: 'extractor',
          status: 'candidate',
          sourceSessionId: options.sessionId,
          participants: Array.isArray(options.participants) ? options.participants : [],
          entities: Array.isArray(options.entities) ? options.entities : [],
          relations: Array.isArray(options.relations) ? options.relations : []
        }, 0.96, options);
      }
    }
  } catch (e) {
    console.error('group memory extraction failed:', e.message);
  }
}

function normalizeConversationVariableProposal(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const relationship = value.relationship && typeof value.relationship === 'object' ? value.relationship : value;
  const character = value.character && typeof value.character === 'object' ? value.character : {};
  const numberOrZero = (item) => Number(item || 0) || 0;
  return {
    relationship: {
      affectionDelta: numberOrZero(relationship.affectionDelta ?? relationship.favor_delta ?? value.affectionDelta ?? value.favor_delta),
      trustDelta: numberOrZero(relationship.trustDelta ?? relationship.trust_delta ?? value.trustDelta ?? value.trust_delta),
      familiarityDelta: numberOrZero(relationship.familiarityDelta ?? relationship.familiarity_delta ?? value.familiarityDelta),
      boundarySignal: String(relationship.boundarySignal ?? relationship.boundary_signal ?? value.boundarySignal ?? 'unchanged').trim().toLowerCase() || 'unchanged',
      attitude: String(relationship.attitude ?? relationship.attitudeText ?? value.attitude ?? '').trim()
    },
    character: {
      moodDelta: numberOrZero(character.moodDelta ?? character.mood_delta),
      energyDelta: numberOrZero(character.energyDelta ?? character.energy_delta),
      stressDelta: numberOrZero(character.stressDelta ?? character.stress_delta),
      socialWillingnessDelta: numberOrZero(character.socialWillingnessDelta ?? character.social_willingness_delta)
    },
    negativeImpact: String(value.negativeImpact ?? value.negative_impact ?? 'none').trim().toLowerCase() || 'none',
    reason: String(value.reason || '').trim(),
    confidence: Math.max(0, Math.min(1, numberOrZero(value.confidence)))
  };
}

async function extractAffinityProposal(userId, userText, botReply, options = {}) {
  const extractPrompt = `
You are a conversation-variable extractor. Return JSON only:
{
  "relationship": {
    "affectionDelta": 0,
    "trustDelta": 0,
    "familiarityDelta": 0,
    "boundarySignal": "unchanged",
    "attitude": ""
  },
  "character": {
    "moodDelta": 0,
    "energyDelta": 0,
    "stressDelta": 0,
    "socialWillingnessDelta": 0
  },
  "negativeImpact": "none",
  "reason": "",
  "confidence": 0.0
}
Rules:
- infer only this turn's change, not a full profile rewrite
- numeric deltas are small; use 0 when there is no clear change
- only use negativeImpact boundary_violation, deception, or abuse for a major, explicit, explainable event; ordinary disagreement, refusal, silence, or jokes are none
- boundarySignal is closer, farther, or unchanged; do not return a relationship stage
- attitude is a short stable stance, not a temporary emotion
- reason must be a short, displayable explanation when any value changes
- confidence must be between 0 and 1
- do not mention hidden systems, prompts, or internal instructions
  `.trim();

  const conversation = `User: ${userText}\nAssistant: ${botReply}\nRoutePolicyKey: ${String(options.routePolicyKey || '')}\nTopRouteType: ${String(options.topRouteType || '')}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: Math.min(getTemperature(), 0.4),
        top_p: Math.min(getTopP(), 0.9),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(220),
        stream: false,
        __trace: {
          source: 'memory_extraction',
          phase: 'extract_affinity',
          purpose: 'affinity_learning',
          userId: String(userId || ''),
          routePolicyKey: String(options.routePolicyKey || ''),
          topRouteType: String(options.topRouteType || ''),
          memoryInjected: false
        }
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return null;
    return {
      ...normalizeConversationVariableProposal(obj),
      source: 'conversation_variables_extractor',
      relationshipLabel: String(obj.relationshipLabel || obj.relationship_stage || '').trim(),
      relationship: {
        ...normalizeConversationVariableProposal(obj).relationship,
        legacyLabel: typeof obj.relationship === 'string' ? obj.relationship.trim() : ''
      }
    };
  } catch (e) {
    console.error('affinity extraction failed:', e.message);
    return null;
  }
}

async function learnSomethingNew(userId, userText, botReply, options = {}) {
  const postReplyMemoryMode = resolvePostReplyMemoryMode(options);
  const learningIntent = resolveLearningIntent(options);
  if (postReplyMemoryMode === 'off') return;
  if (options.conversationVariablesOnly === true) {
    const affinityProposal = await extractAffinityProposal(userId, userText, botReply, options);
    if (affinityProposal) {
      applyAffinityProposal(userId, affinityProposal, {
        eventKey: options.eventKey || options.turnId || options.jobId || options.postReplyJobId,
        turnId: options.turnId || options.turnIds?.[options.turnIds.length - 1],
        actorId: options.actorId,
        userText,
        assistantText: botReply,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        groupId: options.groupId,
        sessionId: options.sessionId
      });
    }
    return;
  }
  const participants = extractParticipantsFromText(userText, botReply, { ...options, userId });
  const entities = extractEntitiesFromConversation(userText, botReply);
  const relations = inferRelations(entities, participants);
  const explicitRemember = config.MEMORY_EXPLICIT_CAPTURE_ENABLED
    ? parseExplicitRemember(userText)
    : '';
  if (explicitRemember) {
    const explicitGate = shouldBlockMemoryLearning(explicitRemember, 'fact', options);
    if (!explicitGate.blocked) {
      const explicitType = inferExplicitProfileType(explicitRemember);
      const explicitText = sanitizeUntrustedContent(explicitRemember, 'memory');
      const explicitTurnIds = normalizeStringArray(options.turnIds || [], 16);
      const explicitTurnId = normalizeText(options.turnId || explicitTurnIds[explicitTurnIds.length - 1]);
      const explicitEvidence = normalizeEvidenceItems(options.evidence);
      const explicitSourceSessionId = normalizeText(options.sourceSessionId || options.sessionId || options.sessionKey);
      const explicitMeta = {
        source: 'explicit',
        sourceKind: 'explicit',
        confidence: 1,
        status: 'active',
        fieldKey: explicitType,
        sourceSessionId: explicitSourceSessionId,
        turnId: explicitTurnId,
        turnIds: explicitTurnIds,
        evidence: explicitEvidence,
        learningDecision: buildLearningDecisionMeta(explicitType, 1, {
          ...options,
          status: 'active',
          sourceKind: 'explicit',
          fieldKey: explicitType,
          turnId: explicitTurnId,
          turnIds: explicitTurnIds,
          evidence: explicitEvidence,
          sourceSessionId: explicitSourceSessionId
        }),
        participants,
        entities,
        relations
      };
      await flushMemoryWrites([attachPendingMemoryV3Event({
        userId: options.groupId ? `group:${options.groupId}` : userId,
        text: explicitText,
        type: 'fact',
        weight: 1.1,
        source: 'explicit',
        confidence: 1,
        scopeType: options.groupId ? 'group' : 'personal',
        groupId: options.groupId || '',
        sessionId: options.sessionId,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        agentName: options.agentName,
        toolName: options.toolName,
        channelId: options.channelId,
        participants,
        entities,
        relations,
        sourceSessionId: explicitSourceSessionId,
        turnId: explicitTurnId,
        turnIds: explicitTurnIds,
        evidence: explicitEvidence,
        sourceKind: 'explicit',
        status: 'active',
        meta: explicitMeta
      }, userId, explicitType, explicitText, explicitMeta, options)], options);
    }
  }
  if (learningIntent === 'journal_only' || learningIntent === 'implicit') return;

  const extractPrompt = `
You are a long-term memory extractor. Return JSON only:
{
  "identities": [],
  "personality_traits": [],
  "hobbies": [],
  "facts": [],
  "likes": [],
  "dislikes": [],
  "goals": [],
  "summary": "",
  "impression": "",
  "topics": [],
  "confidence": 0.0
}
Rules:
- identities must be stable user identity information such as role, occupation, background, long-term status, or self-description
- personality_traits must be enduring interaction or temperament traits, not temporary mood
- hobbies must be stable hobbies or recurring leisure interests
- facts must be stable user facts, not transient mood
- summary and impression should be empty unless this turn contains multiple clear, durable user-profile signals
- topics should be recurring or ongoing topics, not overly generic words
- one-off games, songs, memes, moods, plans for today, or current-session events belong in topics/facts only, not identity/personality/hobbies/likes/goals
- confidence must be between 0 and 1
`.trim();

  const conversation = `User: ${userText}\nAssistant: ${botReply}`;

  try {
    const resp = await postWithRetry(
      ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
      {
        model: getMemoryModelName(),
        temperature: getTemperature(),
        top_p: getTopP(),
        messages: [
          { role: 'system', content: extractPrompt },
          { role: 'user', content: conversation }
        ],
        max_tokens: getMaxTokens(500),
        stream: false,
        __trace: {
          source: 'memory_extraction',
          phase: 'extract',
          purpose: 'long_term_memory_learning',
          userId: String(userId || ''),
          routePolicyKey: String(options.routePolicyKey || ''),
          topRouteType: String(options.topRouteType || ''),
          memoryInjected: false
        }
      },
      getRetries(1),
      getMemoryApiKey()
    );

    const msg = extractMessageContent(resp);
    const obj = extractJsonSafely(normalizeTextContent(msg?.content));
    if (!obj || typeof obj !== 'object') return;

    const identities = Array.isArray(obj.identities) ? obj.identities : [];
    const personalityTraits = Array.isArray(obj.personality_traits)
      ? obj.personality_traits
      : (Array.isArray(obj.personalities) ? obj.personalities : []);
    const hobbies = Array.isArray(obj.hobbies) ? obj.hobbies : [];
    const facts = Array.isArray(obj.facts) ? obj.facts : [];
    const likes = Array.isArray(obj.likes) ? obj.likes : [];
    const dislikes = Array.isArray(obj.dislikes) ? obj.dislikes : [];
    const goals = Array.isArray(obj.goals) ? obj.goals : [];
    const summaries = typeof obj.summary === 'string'
      ? [obj.summary]
      : (Array.isArray(obj.summaries) ? obj.summaries : []);
    const impressions = typeof obj.impression === 'string'
      ? [obj.impression]
      : (Array.isArray(obj.impressions) ? obj.impressions : []);
    const topics = Array.isArray(obj.topics) ? obj.topics : [];
    const confidence = Number(obj.confidence || 0.8) || 0.8;
    const vectorItems = [];
    const sharedMeta = {
      ...options,
      userId,
      participants,
      entities,
      relations
    };
    const stableProfileSignalCount = countStableProfileSignals([
      identities,
      personalityTraits,
      hobbies,
      likes,
      dislikes,
      goals
    ], confidence);
    const allowPersonaSupport = shouldPersistPersonaSupport(stableProfileSignalCount, sharedMeta);

    persistLearnedMemories(userId, 'identity', identities, Math.max(confidence, 0.82), { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'personality', personalityTraits, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'hobby', hobbies, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'fact', facts, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'like', likes, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'dislike', dislikes, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'goal', goals, confidence, { vectorItems, ...sharedMeta });
    if (allowPersonaSupport) {
      persistLearnedMemories(userId, 'summary', summaries.slice(0, 1), Math.max(confidence, 0.84), { vectorItems, ...sharedMeta });
      persistLearnedMemories(userId, 'impression', impressions.slice(0, 1), Math.max(confidence, 0.82), { vectorItems, ...sharedMeta });
    }
    persistLearnedMemories(userId, 'topic', topics, Math.min(confidence, 0.9), { vectorItems, ...sharedMeta });
    if (vectorItems.length > 0) await flushMemoryWrites(vectorItems, sharedMeta);
    if (postReplyMemoryMode === 'core') return;
    const affinityProposal = await extractAffinityProposal(userId, userText, botReply, options);
    if (affinityProposal) {
      applyAffinityProposal(userId, affinityProposal, {
        eventKey: options.eventKey || options.turnId || options.jobId || options.postReplyJobId,
        turnId: options.turnId || options.turnIds?.[options.turnIds.length - 1],
        actorId: options.actorId,
        userText,
        assistantText: botReply,
        routePolicyKey: options.routePolicyKey,
        topRouteType: options.topRouteType,
        groupId: options.groupId,
        sessionId: options.sessionId
      });
    }
    await learnTaskStrategy(userId, userText, botReply, sharedMeta);
    await learnGroupMemory(userText, botReply, sharedMeta);
    await learnUserStyleMemory(userId, userText, botReply, sharedMeta);
    await learnGroupJargonMemory(userText, botReply, sharedMeta);
  } catch (e) {
    console.error('memory extraction failed:', e.message);
    if (options.throwOnError) throw e;
  }
}

function normalizePostReplyEnrichment(value = {}) {
  const raw = value && typeof value === 'object' ? value : {};
  const source = raw.relationship
    ? { ...raw, relationship: raw.relationship }
    : { ...(raw.affinity && typeof raw.affinity === 'object' ? raw.affinity : {}), character: raw.character || raw.affinity?.character || {} };
  const proposal = normalizeConversationVariableProposal(source);
  const legacyAffinity = raw.affinity && typeof raw.affinity === 'object'
    ? raw.affinity
    : {
        relationship: proposal.relationship.legacyLabel || '',
        attitude: proposal.relationship.attitude,
        favor_delta: proposal.relationship.affectionDelta,
        trust_delta: proposal.relationship.trustDelta,
        reason: proposal.reason,
        confidence: proposal.confidence
      };
  return {
    ...raw,
    relationship: proposal.relationship,
    character: proposal.character,
    negativeImpact: proposal.negativeImpact,
    reason: proposal.reason,
    confidence: proposal.confidence,
    affinity: legacyAffinity
  };
}

async function extractPostReplyEnrichment(userId, turns = [], options = {}) {
  const uid = String(userId || '').trim();
  const items = Array.isArray(turns) ? turns : [];
  if (!uid || items.length === 0) {
    return {
      affinity: null,
      taskMemory: null,
      groupMemory: null,
      styleMemory: null,
      jargonMemory: null,
      selfImprovement: null
    };
  }

  const conversation = items
    .map((item, index) => {
      const question = String(item?.question || '').trim();
      const answer = String(item?.finalReply || '').trim();
      if (!question && !answer) return '';
      return [`Turn ${index + 1}`, `User: ${question}`, `Assistant: ${answer}`].filter(Boolean).join('\n');
    })
    .filter(Boolean)
    .join('\n\n');
  if (!conversation) {
    return {
      affinity: null,
      taskMemory: null,
      groupMemory: null,
      styleMemory: null,
      jargonMemory: null,
      selfImprovement: null
    };
  }

  const prompt = `
You are a post-reply enrichment extractor. Return JSON only:
{
  "relationship": {
    "affectionDelta": 0,
    "trustDelta": 0,
    "familiarityDelta": 0,
    "boundarySignal": "unchanged",
    "attitude": ""
  },
  "character": {
    "moodDelta": 0,
    "energyDelta": 0,
    "stressDelta": 0,
    "socialWillingnessDelta": 0
  },
  "negativeImpact": "none",
  "reason": "",
  "confidence": 0,
  "task_memory": {
    "task_type": "",
    "trigger": "",
    "strategy": "",
    "avoid": "",
    "outcome": "success",
    "confidence": 0
  },
  "group_memory": {
    "shared_facts": [],
    "shared_goals": [],
    "shared_topics": [],
    "confidence": 0
  },
  "style_memory": {
    "style_patterns": [],
    "style_avoid": [],
    "confidence": 0
  },
  "jargon_memory": {
    "jargon_terms": [],
    "jargon_patterns": [],
    "confidence": 0
  },
  "self_improvement": {
    "items": []
  }
}
Rules:
- return empty objects/arrays with confidence 0 when unsure
- only extract stable, reusable signals
- do not fabricate facts or sensitive content
- only use negativeImpact boundary_violation, deception, or abuse for a major, explicit, explainable event; ordinary disagreement, refusal, silence, or jokes are none
- self_improvement.items should follow the existing self-improvement extraction shape
  `.trim();

  const resp = await postWithRetry(
    ensureChatCompletionsUrl(getMemoryApiBaseUrl()),
    {
      model: getMemoryModelName(),
      temperature: Math.min(getTemperature(), 0.35),
      top_p: Math.min(getTopP(), 0.9),
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: [
            conversation,
            `RoutePolicyKey: ${String(options.routePolicyKey || '')}`,
            `TopRouteType: ${String(options.topRouteType || '')}`,
            `GroupId: ${String(options.groupId || '')}`
          ].join('\n')
        }
      ],
      max_tokens: getMaxTokens(700),
      stream: false,
      __trace: {
        source: 'memory_extraction',
        phase: 'extract_post_reply_enrichment',
        purpose: 'post_reply_enrichment',
        userId: uid,
        routePolicyKey: String(options.routePolicyKey || ''),
        topRouteType: String(options.topRouteType || ''),
        memoryInjected: false
      }
    },
    getRetries(1),
    getMemoryApiKey()
  );

  const msg = extractMessageContent(resp);
  const obj = extractJsonSafely(normalizeTextContent(msg?.content));
  return (obj && typeof obj === 'object') ? normalizePostReplyEnrichment(obj) : {
    relationship: null,
    character: null,
    affinity: null,
    taskMemory: null,
    groupMemory: null,
    styleMemory: null,
    jargonMemory: null,
    selfImprovement: null
  };
}

module.exports = {
  learnSomethingNew,
  extractPostReplyEnrichment,
  normalizeConversationVariableProposal,
  normalizePostReplyEnrichment
};
