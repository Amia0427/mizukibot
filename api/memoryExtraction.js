const config = require('../config');
const { postWithRetry } = require('./httpClient');
const { extractMessageContent, extractJsonSafely } = require('./parser');
const { addMemoryItemsBatch, rememberExplicitMemory } = require('../utils/vectorMemory');
const { normalizeTier } = require('../utils/memoryTier');
const {
  addUserFact,
  addProfileItem,
  setUserImpression,
  setUserSummary,
  applyAffinityProposal
} = require('../utils/memory');
const { addTaskMemory } = require('../utils/taskMemory');
const { addGroupMemory } = require('../utils/groupMemory');

function ensureChatCompletionsUrl(url) {
  const u = String(url || '').replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(u)) return u;
  if (/\/v\d+$/i.test(u)) return `${u}/chat/completions`;
  return u;
}

function normalizeTextContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : (part?.text || ''))).join('');
  }
  return String(content || '');
}

function getMemoryModelName() {
  return String(config.MEMORY_MODEL || config.AI_MODEL || 'gpt-5.4').trim() || 'gpt-5.4';
}

function getMemoryApiBaseUrl() {
  return String(config.MEMORY_API_BASE_URL || config.API_BASE_URL || '').trim();
}

function getMemoryApiKey() {
  if (String(config.MEMORY_API_BASE_URL || '').trim()) {
    return String(config.MEMORY_API_KEY || config.API_KEY || '').trim();
  }
  return String(config.API_KEY || '').trim();
}

function getTemperature() {
  const n = Number(config.AI_TEMPERATURE);
  if (!Number.isFinite(n)) return 0.6;
  return Math.max(0, Math.min(2, n));
}

function getTopP() {
  const n = Number(config.AI_TOP_P);
  if (!Number.isFinite(n)) return 0.92;
  return Math.max(0, Math.min(1, n));
}

function getMaxTokens(fallback = 500) {
  const n = Number(config.AI_MAX_TOKENS);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(64, Math.floor(n));
}

function getRetries(fallback = 1) {
  const n = Number(config.AI_RETRIES);
  if (!Number.isFinite(n)) return fallback;
  // Background extraction should fail fast instead of inheriting long foreground retry budgets.
  return Math.max(0, Math.min(1, Math.floor(n)));
}

function shouldPersistMemoryCandidate(type, value, confidence) {
  const text = String(value || '').trim();
  if (!text) return false;

  const minConfidence = Number(config.MEMORY_EXTRACT_MIN_CONFIDENCE) || 0.72;
  if (Number(confidence || 0) < minConfidence) return false;
  if (text.length < 2) return false;
  if (type === 'topic' && text.length < 4) return false;
  if (type === 'topic' && /^(weather|music|hot_topics|chat|daily)$/i.test(text)) return false;
  return true;
}

function inferExtractorTier(type, confidence = 0.8) {
  const conf = Math.max(0, Math.min(1, Number(confidence || 0)));
  const t = String(type || '').trim().toLowerCase();

  if (t === 'identity' || t === 'summary') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'impression') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'goal') {
    if (conf >= 0.9) return 'S';
    if (conf >= 0.8) return 'A';
    return 'B';
  }

  if (t === 'fact' || t === 'like' || t === 'dislike' || t === 'personality' || t === 'hobby') {
    if (conf >= 0.9) return 'A';
    if (conf >= 0.78) return 'B';
    return 'C';
  }

  // Topics are usually short-lived, so keep them from crowding high-priority memory.
  if (t === 'topic') {
    if (conf >= 0.9) return 'B';
    return 'C';
  }

  return 'B';
}

function extractParticipantsFromText(userText = '', botReply = '', options = {}) {
  const participants = [];
  if (String(options.userId || '').trim()) participants.push(String(options.userId || '').trim());
  if (String(options.groupId || '').trim()) participants.push(`group:${String(options.groupId || '').trim()}`);

  const source = `${String(userText || '')}\n${String(botReply || '')}`;
  const mentions = source.match(/@([A-Za-z0-9_\-\u4e00-\u9fa5]{2,24})/g) || [];
  for (const mention of mentions) {
    participants.push(String(mention).replace(/^@/, ''));
  }

  return Array.from(new Set(participants.filter(Boolean))).slice(0, 8);
}

function extractEntitiesFromConversation(userText = '', botReply = '') {
  const text = `${String(userText || '')}\n${String(botReply || '')}`;
  const out = [];
  const seen = new Set();
  const push = (value) => {
    const token = String(value || '').trim();
    if (!token) return;
    const key = token.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(token);
  };

  for (const token of text.match(/\b[A-Za-z][A-Za-z0-9_-]{2,}\b/g) || []) push(token);
  for (const chunk of text.match(/[\u4e00-\u9fa5]{2,8}/g) || []) push(chunk);
  return out.slice(0, 8);
}

function inferRelations(entities = [], participants = []) {
  const nodes = Array.from(new Set([...(participants || []), ...(entities || [])])).slice(0, 6);
  const relations = [];
  for (let i = 0; i < nodes.length - 1; i += 1) {
    relations.push(`${nodes[i]}->${nodes[i + 1]}`);
  }
  return relations.slice(0, 8);
}

function getDefaultStatusForType(type = '', memoryKind = '') {
  if (memoryKind === 'style' || memoryKind === 'jargon') return 'active';
  const normalized = String(type || '').trim().toLowerCase();
  if (normalized === 'identity' || normalized === 'goal' || normalized === 'summary' || normalized === 'impression') {
    return 'active';
  }
  return 'candidate';
}

function buildMemoryBaseMeta(type, confidence, options = {}) {
  const importanceTier = normalizeTier(inferExtractorTier(type, confidence)) || 'B';
  const fieldKey = String(options.fieldKey || type || '').trim().toLowerCase();
  return {
    source: 'extractor',
    confidence,
    importanceTier,
    sourceKind: options.sourceKind || 'extractor',
    status: options.status || getDefaultStatusForType(type, options.memoryKind),
    fieldKey,
    sourceSessionId: options.sessionId || '',
    participants: Array.isArray(options.participants) ? options.participants : [],
    entities: Array.isArray(options.entities) ? options.entities : [],
    relations: Array.isArray(options.relations) ? options.relations : []
  };
}

function parseExplicitRemember(text = '') {
  const source = String(text || '').trim();
  if (!source) return '';
  const match = source.match(/^(?:记住|记一下|帮我记住|remember)\s*(?:[:：,-]\s*|\s+)?(.+)$/i);
  if (!match) return '';
  return String(match[1] || '').trim();
}

function persistLearnedMemories(userId, type, values, confidence = 0.8, options = {}) {
  const vectorItems = Array.isArray(options.vectorItems) ? options.vectorItems : [];
  const fieldKey = String(options.fieldKey || type || '').trim().toLowerCase();

  for (const raw of values) {
    const value = String(raw || '').trim();
    if (!shouldPersistMemoryCandidate(type, value, confidence)) continue;
    const meta = buildMemoryBaseMeta(type, confidence, { ...options, fieldKey });

    if (type === 'fact') {
      vectorItems.push({ userId, text: value, type: 'fact', weight: 1.15, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addUserFact(userId, value, 30);
      continue;
    }

    if (type === 'identity') {
      vectorItems.push({ userId, text: `identity: ${value}`, type: 'identity', weight: 1.25, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'identities', value, 20);
      addUserFact(userId, value, 30);
      continue;
    }

    if (type === 'personality') {
      vectorItems.push({ userId, text: `personality: ${value}`, type: 'personality', weight: 1.1, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'personality_traits', value, 20);
      continue;
    }

    if (type === 'hobby') {
      vectorItems.push({ userId, text: `hobby: ${value}`, type: 'hobby', weight: 1.08, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'hobbies', value, 20);
      continue;
    }

    if (type === 'like') {
      vectorItems.push({ userId, text: `likes: ${value}`, type: 'like', weight: 1.05, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'likes', value, 20);
      continue;
    }

    if (type === 'dislike') {
      vectorItems.push({ userId, text: `dislikes: ${value}`, type: 'dislike', weight: 1.05, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'dislikes', value, 20);
      continue;
    }

    if (type === 'goal') {
      vectorItems.push({ userId, text: `goal: ${value}`, type: 'goal', weight: 1.2, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'goals', value, 20);
      continue;
    }

    if (type === 'impression') {
      vectorItems.push({ userId, text: `impression support: ${value}`, type: 'fact', weight: 1.18, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey || 'persona_impression_support', meta: { ...meta, fieldKey: fieldKey || 'persona_impression_support' } });
      continue;
    }

    if (type === 'summary') {
      vectorItems.push({ userId, text: `summary support: ${value}`, type: 'fact', weight: 1.16, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey || 'persona_summary_support', meta: { ...meta, fieldKey: fieldKey || 'persona_summary_support' } });
      continue;
    }

    if (type === 'topic') {
      vectorItems.push({ userId, text: `recent topic: ${value}`, type: 'topic', weight: 0.95, source: meta.source, confidence: meta.confidence, semanticSlot: fieldKey, meta });
      addProfileItem(userId, 'recent_topics', value, 12);
    }
  }

  if (!Array.isArray(options.vectorItems) && vectorItems.length > 0) {
    addMemoryItemsBatch(vectorItems);
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
    if (vectorItems.length > 0) addMemoryItemsBatch(vectorItems);
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
    if (vectorItems.length > 0) addMemoryItemsBatch(vectorItems);
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

    addTaskMemory(userId, {
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
    });
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
      if (text) addGroupMemory(groupId, text, 'fact', {
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
      }, 1.08);
    }
    for (const value of sharedGoals) {
      const text = String(value || '').trim();
      if (text) addGroupMemory(groupId, `group goal: ${text}`, 'goal', {
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
      }, 1.15);
    }
    for (const value of sharedTopics) {
      const text = String(value || '').trim();
      if (text && text.length >= 4) {
        addGroupMemory(groupId, `group topic: ${text}`, 'topic', {
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
        }, 0.96);
      }
    }
  } catch (e) {
    console.error('group memory extraction failed:', e.message);
  }
}

async function extractAffinityProposal(userId, userText, botReply, options = {}) {
  const extractPrompt = `
You are an affinity-state extractor. Return JSON only:
{
  "relationship": "",
  "attitude": "",
  "favor_delta": 0,
  "trust_delta": 0,
  "reason": "",
  "confidence": 0.0
}
Rules:
- infer only this turn's relationship impact, not a full long-term profile rewrite
- relationship must be a short label such as "陌生人", "普通朋友", "亲密伙伴", "警惕对象"
- attitude must be a short, stable description of current stance, not a dramatic temporary emotion
- favor_delta should usually stay between -6 and +3
- trust_delta should usually stay between -6 and +3
- if there is no meaningful change, return empty strings with 0 deltas
- reason must be a short displayable phrase
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
      relationship: String(obj.relationship || '').trim(),
      attitude: String(obj.attitude || '').trim(),
      favor_delta: Number(obj.favor_delta || 0) || 0,
      trust_delta: Number(obj.trust_delta || 0) || 0,
      reason: String(obj.reason || '').trim(),
      confidence: Number(obj.confidence || 0) || 0,
      source: 'affinity_extractor'
    };
  } catch (e) {
    console.error('affinity extraction failed:', e.message);
    return null;
  }
}

async function learnSomethingNew(userId, userText, botReply, options = {}) {
  const participants = extractParticipantsFromText(userText, botReply, { ...options, userId });
  const entities = extractEntitiesFromConversation(userText, botReply);
  const relations = inferRelations(entities, participants);
  const explicitRemember = config.MEMORY_EXPLICIT_CAPTURE_ENABLED
    ? parseExplicitRemember(userText)
    : '';
  if (explicitRemember) {
    rememberExplicitMemory(userId, explicitRemember, {
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
      sourceSessionId: options.sessionId
    });
  }

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
- summary must be a concise overall summary of the user's identity, personality, preferences, and ongoing direction
- impression must be a concise, stable summary of what kind of user this is, their interaction style, and enduring preferences
- topics should be recurring or ongoing topics, not overly generic words
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

    persistLearnedMemories(userId, 'identity', identities, Math.max(confidence, 0.82), { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'personality', personalityTraits, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'hobby', hobbies, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'fact', facts, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'like', likes, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'dislike', dislikes, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'goal', goals, confidence, { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'summary', summaries.slice(0, 1), Math.max(confidence, 0.84), { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'impression', impressions.slice(0, 1), Math.max(confidence, 0.82), { vectorItems, ...sharedMeta });
    persistLearnedMemories(userId, 'topic', topics, Math.min(confidence, 0.9), { vectorItems, ...sharedMeta });
    if (vectorItems.length > 0) addMemoryItemsBatch(vectorItems);
    const affinityProposal = await extractAffinityProposal(userId, userText, botReply, options);
    if (affinityProposal) {
      applyAffinityProposal(userId, affinityProposal, {
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

module.exports = {
  learnSomethingNew
};
