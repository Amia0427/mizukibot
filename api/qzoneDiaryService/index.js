const config = require('../../config');
const { getGroupPresence, getRecentMessages } = require('../../utils/groupAwarenessState');
const {
  MAX_RETRIES,
  buildVariationConstraintPrompt,
  buildVariationProfilePrompt,
  describeGenericAutodraftRandomness,
  getModelConfigForQzoneAttempt,
  recordQzoneGenerationHistory,
  normalizeDailyShareFingerprint,
  sampleVariationProfile
} = require('../../core/qzoneGenerationState');
const {
  CANDIDATE_COUNT,
  CANDIDATE_VARIANT_TYPES,
  PLAN_RETRY_LIMIT,
  appendQzoneGenerationLog,
  buildCandidatePrompt,
  buildPlanPrompt,
  buildTropeFingerprint,
  buildQzonePlan,
  buildVisualPromptHints,
  evaluateImageConsistency,
  finalizeSuccessfulQzoneRecord,
  getRecentFailureLikeEntries,
  normalizeTelemetryPayload,
  pickBestCandidate,
  summarizeQzoneDebug,
  summarizeQzoneWindowStats
} = require('../../core/qzoneGenerationPhase2');
const {
  INTERNAL_LEAK_TERMS,
  normalizeText,
  uniqueBy,
  safeJsonParse,
  stripCodeFences,
  normalizeGeneratedQzoneContent,
  detectQzonePostDraftMode,
  extractDiarySignals: extractDiarySignalsBase,
  sanitizeMemoryQuery,
  buildFallbackBotDiaryMemoryQuery,
  parsePlannerQueryFromResponse,
  redactMemoryEvidenceText,
  isExpectedMemorySearchPayload,
  isExpectedMemoryOpenPayload,
  buildSearchDigestLines,
  pickBotDiaryOpenCandidate,
  summarizeOpenedMemory,
  buildMemoryEvidenceLines,
  buildQzoneVariantNote,
  findDiarySafetyIssues
} = require('./diarySignals');

function composePersonaMemoryState(...args) {
  return require('../../utils/personaMemoryState').composePersonaMemoryState(...args);
}

function renderPersonaMemoryPrompt(...args) {
  return require('../../utils/personaMemoryState').renderPersonaMemoryPrompt(...args);
}

function recordPersonaMemoryOutcome(...args) {
  return require('../../utils/personaMemoryState').recordPersonaMemoryOutcome(...args);
}

function buildCompactPersonaPrompt(maxChars = 1200) {
  const source = normalizeText(config.SYSTEM_PROMPT);
  if (!source) return '';
  const lines = source
    .split(/\r?\n/)
    .map((line) => normalizeText(line))
    .filter(Boolean);
  if (!lines.length) return '';
  const picked = [];
  const limit = Math.max(200, Number(maxChars) || 1200);
  let total = 0;
  for (const line of lines) {
    if (total >= limit) break;
    const nextLength = total + line.length + 1;
    if (nextLength > limit) break;
    picked.push(line);
    total = nextLength;
  }
  return picked.join('\n');
}

function extractDiarySignals(groupId = '', options = {}) {
  return extractDiarySignalsBase(groupId, {
    ...options,
    getRecentMessages,
    getGroupPresence
  });
}

async function planBotDiaryMemoryQuery(input = {}, options = {}) {
  const requester = typeof options.requestAssistantMessage === 'function'
    ? options.requestAssistantMessage
    : require('../graphModelIO').requestAssistantMessage;

  const hint = normalizeText(input.hint);
  const signals = input.signals && typeof input.signals === 'object' ? input.signals : {};
  const fallbackQuery = buildFallbackBotDiaryMemoryQuery(hint, signals);
  const prompt = [
    '你现在只负责为 bot_diary 规划一条 memory_cli 搜索 query。',
    '输出必须是严格 JSON。',
    'JSON 对象只允许一个字段: {"query":"..."}',
    '不要输出 markdown，不要输出解释，不要输出命令，不要输出多余字段。',
    'query 应该短、泛化、像检索词，不要写完整叙事。',
    '宁可抽象，也不要带昵称、精确时间、可识别细节。',
    '',
    '[hint]',
    hint || '无',
    '',
    '[当前时间段]',
    `${normalizeText(signals.weekday)}${normalizeText(signals.timeBucket)}` || '未知',
    '',
    '[bot 最近状态]',
    Array.isArray(signals.botStyleTags) && signals.botStyleTags.length ? signals.botStyleTags.join('，') : '最近状态不明显',
    '',
    '[群氛围摘要]',
    Array.isArray(signals.groupMoodTags) && signals.groupMoodTags.length ? signals.groupMoodTags.join('，') : '群氛围普通',
    '',
    '[补充信号]',
    ...(Array.isArray(signals.summaryLines) ? signals.summaryLines.slice(0, 4) : [])
  ].join('\n');

  try {
    const response = await requester([
      { role: 'system', content: prompt },
      { role: 'user', content: '只输出严格 JSON。' }
    ], {
      disableTools: true,
      modelConfig: options.modelConfig || null
    });
    const plannedQuery = parsePlannerQueryFromResponse(response);
    if (plannedQuery) {
      return {
        query: plannedQuery,
        usedFallback: false
      };
    }
  } catch (_) {}

  return {
    query: fallbackQuery,
    usedFallback: true
  };
}

function buildBotDiaryMemoryContext(memoryUserId = '', groupId = '') {
  const safeUserId = normalizeText(memoryUserId);
  const safeGroupId = normalizeText(groupId);
  const sessionId = `${safeUserId}${safeGroupId}`;
  return {
    userId: safeUserId,
    groupId: safeGroupId,
    channelId: safeGroupId,
    sessionId,
    sessionKey: sessionId,
    routePolicyKey: 'qq_publish_qzone.bot_diary',
    topRouteType: 'qq_publish_qzone'
  };
}

async function runBotDiaryMemoryPrefetch(input = {}, options = {}) {
  const runMemoryCli = typeof options.runMemoryCli === 'function'
    ? options.runMemoryCli
    : require('../../utils/memoryCli').runMemoryCli;
  const recordMemoryScope = typeof options.recordMemoryScope === 'function'
    ? options.recordMemoryScope
    : require('../../utils/memoryScopeIndex').recordMemoryScope;

  const memoryUserId = normalizeText(input.memoryUserId || config.BOT_QQ);
  const groupId = normalizeText(input.groupId);
  const query = sanitizeMemoryQuery(input.query);
  const memoryContext = buildBotDiaryMemoryContext(memoryUserId, groupId);

  if (typeof recordMemoryScope !== 'function') {
    return {
      ok: false,
      failureStage: 'record_scope',
      reason: 'recordMemoryScope unavailable',
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['记忆作用域初始化失败。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  if (typeof runMemoryCli !== 'function') {
    return {
      ok: false,
      failureStage: 'search',
      reason: 'runMemoryCli unavailable',
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['memory_cli 不可用。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  try {
    recordMemoryScope(memoryUserId, { groupId });
  } catch (error) {
    return {
      ok: false,
      failureStage: 'record_scope',
      reason: String(error?.message || error || 'record scope failed'),
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['记忆作用域初始化失败。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  const searchCommand = `mem search --query ${JSON.stringify(query)} --source all --limit 6`;
  let searchPayload = null;
  try {
    searchPayload = await runMemoryCli(searchCommand, memoryContext);
  } catch (error) {
    return {
      ok: false,
      failureStage: 'search',
      reason: String(error?.message || error || 'memory search failed'),
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['memory search 执行失败。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: ''
    };
  }

  if (!isExpectedMemorySearchPayload(searchPayload)) {
    return {
      ok: false,
      failureStage: 'search',
      reason: 'unexpected memory search payload',
      memoryOwner: memoryUserId,
      query,
      searchCount: 0,
      searchDigestLines: ['memory search 返回结构异常。'],
      openUsed: false,
      openedRef: '',
      openedMemorySummary: '',
      rawSearchPayload: searchPayload
    };
  }

  const searchCount = Number(searchPayload.count || 0) || 0;
  const searchDigestLines = buildSearchDigestLines(searchPayload);
  const openCandidate = searchCount > 0 ? pickBotDiaryOpenCandidate(searchPayload.results) : null;
  let openUsed = false;
  let openedRef = '';
  let openedMemorySummary = '';
  let memoryFailureStage = '';

  if (openCandidate && normalizeText(openCandidate.ref)) {
    const openCommand = `mem open --ref ${JSON.stringify(normalizeText(openCandidate.ref))}`;
    try {
      const openPayload = await runMemoryCli(openCommand, memoryContext);
      if (isExpectedMemoryOpenPayload(openPayload)) {
        openUsed = true;
        openedRef = normalizeText(openCandidate.ref);
        openedMemorySummary = summarizeOpenedMemory(openPayload, openCandidate.source);
      } else {
        memoryFailureStage = 'open';
      }
    } catch (_) {
      memoryFailureStage = 'open';
    }
  }

  return {
    ok: true,
    query,
    memoryOwner: memoryUserId,
    searchCount,
    searchDigestLines,
    searchPayload,
    openUsed,
    openedRef,
    openedMemorySummary,
    memoryFailureStage
  };
}

async function buildBotDiaryPrompt({ hint = '', signals = {}, strict = false, memoryEvidence = {}, variationProfile = {}, recentHistory = [] } = {}) {
  const personaState = await composePersonaMemoryState({
    userId: String(config.BOT_QQ || 'mizuki').trim(),
    question: String(hint || '').trim(),
    topRouteType: 'qq_publish_qzone',
    routePolicyKey: 'qq_publish_qzone.bot_diary'
  }, {
    surface: 'bot_diary'
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'bot_diary');
  const weakHint = normalizeText(hint);
  const promptLines = [
    '你现在只负责写一条可以直接发布到 QQ 空间的中文日记正文。',
    '这不是代写用户日记，而是 bot 自己的日记。',
    '必须使用第一人称“我”。',
    '长度固定在 80 到 180 字之间，2 到 5 句自然短句。',
    '整体要像 QQ 空间/朋友圈里临时发出的生活碎片：可以有停顿、吐槽、动作和没说满的情绪，不要写成小作文、公告或精修文案。',
    '内容重心必须放在我自己的感受、观察、别扭、轻微阴阳怪气和嘴硬式关怀。',
    '允许轻轻提到群里的人或群聊氛围，但只能泛化提及，不得出现可识别的个人信息。',
    '对他人的提及最多 1 到 2 个短分句，总占比不要超过约 30%。',
    '不要写标题、标签、项目符号、引号、括号说明，也不要解释规则。',
    '绝对禁止出现昵称、@、QQ号、手机号、链接、精确时间点、可回溯事件细节、用户原话或近似转述。',
    '绝对禁止出现 AI、模型、系统提示、记忆、日志、planner、agent、tool、NapCat、cookie、权限、边界 这类元信息。'
  ];
  if (strict) {
    promptLines.push('这次必须更保守：宁可更抽象、更像自言自语，也不要出现任何可识别对象或具体事件。');
    promptLines.push('如果想提别人，只能写成“群里有人”“某个夜猫子”“那个让我想翻白眼的人”这种泛化表达。');
  }
  promptLines.push('');
  promptLines.push(...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean));
  promptLines.push('');
  promptLines.push(buildVariationProfilePrompt(variationProfile || {}));
  promptLines.push('');
  promptLines.push(buildVariationConstraintPrompt({ recentHistory }));
  promptLines.push('');
  promptLines.push('[当前群抽象信号]');
  promptLines.push(...(Array.isArray(signals.summaryLines) ? signals.summaryLines : ['当前群信号不足，改写成偏自言自语的状态。']));
  promptLines.push('');
  promptLines.push('[管理员弱提示]');
  promptLines.push(weakHint ? `${weakHint}（只可作为很弱的方向提示，不能把管理员写成叙事主角）` : '无。素材不足时改写成时间段驱动的自述。');
  promptLines.push('');
  promptLines.push(...buildMemoryEvidenceLines(memoryEvidence));
  promptLines.push('');
  promptLines.push('只输出最终正文。');
  return {
    prompt: promptLines.join('\n'),
    personaMemoryState: personaState
  };
}

async function buildBotDiaryPromptFromPlan({ hint = '', signals = {}, strict = false, memoryEvidence = {}, plan = {}, recentHistory = [] } = {}) {
  const personaState = await composePersonaMemoryState({
    userId: String(config.BOT_QQ || 'mizuki').trim(),
    question: String(hint || '').trim(),
    topRouteType: 'qq_publish_qzone',
    routePolicyKey: 'qq_publish_qzone.bot_diary'
  }, {
    surface: 'bot_diary'
  });
  const personaPrompt = renderPersonaMemoryPrompt(personaState, 'bot_diary');
  const weakHint = normalizeText(hint);
  const promptLines = [
    '你现在只负责写一条可以直接发布到 QQ 空间的中文日记正文。',
    '这不是代写用户日记，而是 bot 自己的日记。',
    '必须使用第一人称“我”。',
    '长度固定在 80 到 180 字之间，2 到 5 句自然短句。',
    '整体要像 QQ 空间/朋友圈里临时发出的生活碎片：可以有停顿、吐槽、动作和没说满的情绪，不要写成小作文、公告或精修文案。',
    '内容重心必须放在我自己的感受、观察、别扭、轻微阴阳怪气和嘴硬式关怀。',
    '允许轻轻提到群里的人或群聊氛围，但只能泛化提及，不得出现可识别的个人信息。',
    '对他人的提及最多 1 到 2 个短分句，总占比不要超过约 30%。',
    '不要写标题、标签、项目符号、引号、括号说明，也不要解释规则。',
    '绝对禁止出现昵称、@、QQ号、手机号、链接、精确时间点、可回溯事件细节、用户原话或近似转述。'
  ];
  if (strict) {
    promptLines.push('这次必须更保守：宁可更抽象、更像自言自语，也不要出现任何可识别对象或具体事件。');
  }
  promptLines.push('');
  promptLines.push(...personaPrompt.systemMessages.map((message) => String(message?.content || '').trim()).filter(Boolean));
  promptLines.push('');
  promptLines.push(buildPlanPrompt(plan, { type: 'bot_diary' }));
  promptLines.push('');
  promptLines.push('[当前群抽象信号]');
  promptLines.push(...(Array.isArray(signals.summaryLines) ? signals.summaryLines : ['当前群信号不足，改写成偏自言自语的状态。']));
  promptLines.push('');
  promptLines.push('[管理员弱提示]');
  promptLines.push(weakHint ? `${weakHint}（只可作为很弱的方向提示，不能把管理员写成叙事主角）` : '无。素材不足时改写成时间段驱动的自述。');
  promptLines.push('');
  promptLines.push(...buildMemoryEvidenceLines(memoryEvidence));
  promptLines.push('');
  promptLines.push(`最近失败原因: ${(Array.isArray(recentHistory) ? recentHistory : []).map((item) => item.reason).filter(Boolean).slice(-3).join(' / ') || '无'}`);
  promptLines.push('');
  promptLines.push('只输出最终正文。');
  return {
    prompt: promptLines.join('\n'),
    personaMemoryState: personaState
  };
}

async function runDiaryDraftGeneration(prompt = '', options = {}) {
  const requester = typeof options.requestAssistantMessage === 'function'
    ? options.requestAssistantMessage
    : require('../graphModelIO').requestAssistantMessage;
  const response = await requester([
    { role: 'system', content: prompt },
    { role: 'user', content: '写成 bot 自己的空间日记正文。' }
  ], {
    disableTools: true,
    modelConfig: options.modelConfig || null
  });
  if (typeof response === 'string') return normalizeGeneratedQzoneContent(response);
  return normalizeGeneratedQzoneContent(response?.content || '');
}

function buildBotDiaryMeta(signals = {}, overrides = {}) {
  return {
    mode: 'bot_diary',
    sourceType: signals.sourceType || 'unknown',
    hour: Number(signals?.parts?.hour || 0),
    weekday: normalizeText(signals.weekday),
    timeBucket: normalizeText(signals.timeBucket),
    groupMoodTags: Array.isArray(signals.groupMoodTags) ? signals.groupMoodTags.slice(0, 3) : [],
    botStyleTags: Array.isArray(signals.botStyleTags) ? signals.botStyleTags.slice(0, 4) : [],
    charCount: 0,
    filterResult: 'blocked',
    memoryOwner: normalizeText(overrides.memoryOwner),
    memoryQuery: normalizeText(overrides.memoryQuery),
    memorySearchCount: Math.max(0, Number(overrides.memorySearchCount || 0) || 0),
    memoryOpenUsed: Boolean(overrides.memoryOpenUsed),
    memoryOpenedRef: normalizeText(overrides.memoryOpenedRef),
    memoryFailureStage: normalizeText(overrides.memoryFailureStage),
    topicGroup: normalizeText(overrides.topicGroup),
    topicKey: normalizeText(overrides.topicKey),
    lens: normalizeText(overrides.lens),
    emotion: normalizeText(overrides.emotion),
    anchor: normalizeText(overrides.anchor),
    structure: normalizeText(overrides.structure),
    ending: normalizeText(overrides.ending)
  };
}

async function generateBotDiaryDraft(input = {}, options = {}) {
  const groupId = normalizeText(input.groupId);
  if (!groupId) {
    return {
      ok: false,
      reason: 'groupId missing',
      meta: buildBotDiaryMeta({ sourceType: 'invalid' }, {
        memoryOwner: normalizeText(options.memoryUserId || config.BOT_QQ)
      })
    };
  }

  const hint = normalizeText(input.hint);
  const memoryUserId = normalizeText(options.memoryUserId || config.BOT_QQ);
  const recentSuccessHistory = require('../../core/qzoneGenerationState').getRecentQzoneHistory();
  const recentFailureHistory = getRecentFailureLikeEntries();
  const signals = extractDiarySignals(groupId, {
    recentMessages: options.recentMessages,
    presence: options.presence,
    hint,
    botUserId: options.botUserId || memoryUserId,
    now: options.now
  });

  const plannedQuery = await planBotDiaryMemoryQuery({
    hint,
    signals
  }, options);

  const memoryPrefetch = await (
    typeof options.runBotDiaryMemoryPrefetch === 'function'
      ? options.runBotDiaryMemoryPrefetch({
        groupId,
        query: plannedQuery.query,
        memoryUserId
      }, options)
      : runBotDiaryMemoryPrefetch({
        groupId,
        query: plannedQuery.query,
        memoryUserId
      }, options)
  );

  const baseMeta = buildBotDiaryMeta(signals, {
    memoryOwner: memoryPrefetch.memoryOwner || memoryUserId,
    memoryQuery: memoryPrefetch.query || plannedQuery.query,
    memorySearchCount: memoryPrefetch.searchCount,
    memoryOpenUsed: memoryPrefetch.openUsed,
    memoryOpenedRef: memoryPrefetch.openedRef,
    memoryFailureStage: memoryPrefetch.memoryFailureStage
  });

  if (!memoryPrefetch.ok) {
    return {
      ok: false,
      reason: 'bot diary memory search failed',
      meta: {
        ...baseMeta,
        filterResult: 'blocked',
        memoryFailureStage: normalizeText(memoryPrefetch.failureStage || baseMeta.memoryFailureStage || 'search')
      }
    };
  }

  let finalFailure = '日记草稿未通过安全过滤';
  for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
    const plan = buildQzonePlan({
      source: 'bot_diary',
      type: 'bot_diary',
      windowKey: signals.timeBucket || '',
      groupId,
      today: `${signals.weekday || ''}:${signals.timeBucket || ''}`,
      planAttempt,
      now: Date.now(),
      recentHistory: recentSuccessHistory,
      recentFailures: recentFailureHistory,
      allowImage: true,
      targetLength: '80-180'
    });
    const candidates = [];
    for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
      const strict = candidateIndex > 0;
      const variantType = CANDIDATE_VARIANT_TYPES[candidateIndex] || CANDIDATE_VARIANT_TYPES[0];
      const prompt = buildCandidatePrompt(
        await buildBotDiaryPromptFromPlan({
          hint,
          signals,
          strict,
          memoryEvidence: memoryPrefetch,
          plan,
          recentHistory: recentFailureHistory
        }),
        plan,
        [
          buildQzoneVariantNote(variantType),
          candidateIndex > 0 ? `这是第 ${candidateIndex + 1} 个候选，请显著拉开与前一个版本的开头、节奏和落点。` : ''
        ].filter(Boolean).join('\n')
      );
      const modelConfig = getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : '');
      const content = await runDiaryDraftGeneration(prompt, {
        ...options,
        modelConfig
      });
      const issues = findDiarySafetyIssues(content, signals);
      candidates.push({
        plan,
        variantType,
        text: content,
        rejected: issues.length > 0,
        rejectionReason: issues.join(','),
        meta: {
          lens: plan.variationProfile?.lens || '',
          emotion: plan.variationProfile?.emotion || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          ending: plan.variationProfile?.ending || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || '',
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : ''
        }
      });
    }

    const picked = pickBestCandidate(candidates, {
      source: 'bot_diary',
      recentHistory: recentSuccessHistory,
      plan
    });
    const selected = picked.selected;
    if (selected) {
      const imageConsistency = evaluateImageConsistency({
        text: selected.text,
        plan
      });
      const meta = {
        ...baseMeta,
        charCount: Array.from(selected.text).length,
        filterResult: 'pass',
        topicKey: plan.theme?.key || '',
        topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
        lens: plan.variationProfile?.lens || '',
        emotion: plan.variationProfile?.emotion || '',
        anchor: plan.variationProfile?.anchor || '',
        structure: plan.variationProfile?.structure || '',
        ending: plan.variationProfile?.ending || '',
        arc: plan.variationProfile?.arc || '',
        tempo: plan.variationProfile?.tempo || '',
        distance: plan.variationProfile?.distance || '',
        imageIntent: plan.imageIntent || null,
        imagePromptHints: buildVisualPromptHints(plan),
        imageConsistencyScore: imageConsistency.score,
        imageShouldDegrade: !imageConsistency.consistent,
        imageDuplicateRisk: imageConsistency.duplicate,
        planFingerprint: plan.fingerprint,
        tropeFingerprint: plan.tropeFingerprint || '',
        selectedScore: selected.score,
        similarity: selected.similarity,
        noveltyScore: selected.noveltyScore,
        tropeCollisionScore: selected.tropeCollisionScore,
        circleNaturalnessScore: selected.circleNaturalnessScore,
        edgeTensionScore: selected.edgeTensionScore,
        variantType: selected.variantType,
        plan
      };
      appendQzoneGenerationLog(normalizeTelemetryPayload({
        source: 'bot_diary',
        type: 'bot_diary',
        groupId,
        status: 'sent',
        selectedFingerprint: selected.fingerprint,
        selectedScore: selected.score,
        similarity: selected.similarity,
        noveltyScore: selected.noveltyScore,
        tropeCollisionScore: selected.tropeCollisionScore,
        circleNaturalnessScore: selected.circleNaturalnessScore,
        edgeTensionScore: selected.edgeTensionScore,
        imageConsistencyScore: imageConsistency.score,
        failureReasons: [],
        planSummary: {
          fingerprint: plan.fingerprint,
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
          lens: plan.variationProfile?.lens || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || '',
          spark: plan.variationProfile?.spark || '',
          socialMask: plan.variationProfile?.socialMask || '',
          freshnessMode: plan.variationProfile?.freshnessMode || '',
          voiceEdge: plan.variationProfile?.voiceEdge || '',
          tropeFingerprint: plan.tropeFingerprint || ''
        },
        candidates: picked.ranked.map((item) => ({
          fingerprint: item.fingerprint,
          score: item.score,
          similarity: item.similarity,
          noveltyScore: item.noveltyScore,
          tropeCollisionScore: item.tropeCollisionScore,
          circleNaturalnessScore: item.circleNaturalnessScore,
          edgeTensionScore: item.edgeTensionScore,
          variantType: item.variantType,
          tropeFingerprint: item.tropeFingerprint,
          rejected: item.rejected,
          rejectionReason: item.rejectionReason
        }))
      }));
      console.log('[qzone-diary] generated', JSON.stringify(meta));
      await recordPersonaMemoryOutcome('bot_diary', {
        state: await composePersonaMemoryState({
          userId: String(config.BOT_QQ || 'mizuki').trim(),
          question: String(hint || '').trim(),
          routePolicyKey: 'qq_publish_qzone.bot_diary',
          topRouteType: 'qq_publish_qzone'
        }, {
          surface: 'bot_diary'
        }),
        userId: String(config.BOT_QQ || 'mizuki').trim(),
        request: {
          userId: String(config.BOT_QQ || 'mizuki').trim(),
          question: hint || '',
          routePolicyKey: 'qq_publish_qzone.bot_diary',
          topRouteType: 'qq_publish_qzone',
          routeMeta: {}
        },
        activeTopic: meta.topicKey || signals.timeBucket || 'bot_diary',
        recentReplyFrame: selected.text,
        summary: selected.text,
        recentMessages: [{ role: 'assistant', content: selected.text }]
      }).catch(() => {});
      return {
        ok: true,
        content: selected.text,
        meta
      };
    }

    finalFailure = picked.ranked[0]?.rejectionReason || 'plan-candidate-rejected';
    appendQzoneGenerationLog(normalizeTelemetryPayload({
      source: 'bot_diary',
      type: 'bot_diary',
      groupId,
      status: 'failed',
      selectedFingerprint: '',
      selectedScore: 0,
      similarity: 0,
      failureReasons: uniqueBy(
        picked.ranked.map((item) => item.rejectionReason).filter(Boolean),
        (item) => item
      ),
      planSummary: {
        fingerprint: plan.fingerprint,
        topicKey: plan.theme?.key || '',
        topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
        lens: plan.variationProfile?.lens || '',
        anchor: plan.variationProfile?.anchor || '',
        structure: plan.variationProfile?.structure || '',
        arc: plan.variationProfile?.arc || '',
        tempo: plan.variationProfile?.tempo || '',
        distance: plan.variationProfile?.distance || '',
        spark: plan.variationProfile?.spark || '',
        socialMask: plan.variationProfile?.socialMask || '',
        freshnessMode: plan.variationProfile?.freshnessMode || '',
        voiceEdge: plan.variationProfile?.voiceEdge || '',
        tropeFingerprint: plan.tropeFingerprint || ''
      },
      candidates: picked.ranked.map((item) => ({
        fingerprint: item.fingerprint,
        score: item.score,
        similarity: item.similarity,
        noveltyScore: item.noveltyScore,
        tropeCollisionScore: item.tropeCollisionScore,
        circleNaturalnessScore: item.circleNaturalnessScore,
        edgeTensionScore: item.edgeTensionScore,
        variantType: item.variantType,
        tropeFingerprint: item.tropeFingerprint,
        rejected: item.rejected,
        rejectionReason: item.rejectionReason
      }))
    }));
  }

  return {
    ok: false,
    reason: finalFailure || '日记草稿未通过安全过滤',
    meta: {
      ...baseMeta,
      filterResult: 'blocked'
    }
  };
}

function buildGenericAutodraftPrompt(requestText = '', options = {}) {
  const profile = options.variationProfile || {};
  const recentHistory = Array.isArray(options.recentHistory) ? options.recentHistory : [];
  const plan = options.plan || {
    type: 'generic_autodraft',
    variationProfile: profile,
    fingerprint: '',
    sceneAnchors: [],
    emotionalArc: '',
    targetLength: '24-120',
    theme: null,
    microTheme: null,
    bannedRepeats: { openings: [], planFingerprints: [] }
  };
  const randomness = describeGenericAutodraftRandomness(requestText);
  return [
    '你现在只负责代写一条可以直接发布到 QQ 空间的中文动态正文。',
    '必须使用第一人称，语气自然，像今天临时发的一条朋友圈/说说。',
    '优先根据用户原话推断主题、心情、长度和风格。',
    '默认写成 24 到 120 字；除非用户明确要求长文，否则宁可短一点。',
    '写法要像生活碎片：短句、吐槽、随手记录、临时情绪都可以；不要写成公告、小作文、鸡汤总结或营销文案。',
    '优先放一个具体小动作或小物件，比如消息框、杯子、灯、窗帘、耳机、屏幕、出门前的小停顿。',
    '不要解释，不要提问，不要使用标题、项目符号、引号、标签或前缀。',
    '不要提到自己是 AI。',
    randomness.useFullVariation
      ? '用户没有明确锁死主题/长度/口吻时，你要主动换写法，不要套固定句式。'
      : '如果用户已经明确指定主题、长度或口吻，只在未指定维度上保留变化。',
    buildPlanPrompt(plan, { type: 'generic_autodraft' }),
    `最近失败原因: ${recentHistory.map((item) => item.reason).filter(Boolean).slice(-3).join(' / ') || '无'}`,
    '只输出最终可发布正文。',
    `用户请求: ${String(requestText || '').trim()}`
  ].filter(Boolean).join('\n');
}

async function generateGenericQzoneDraft(input = {}, options = {}) {
  const requestText = normalizeText(input.requestText || input.hint || '');
  const recentHistory = require('../../core/qzoneGenerationState').getRecentQzoneHistory();
  const recentFailures = getRecentFailureLikeEntries();
  let finalFailure = '';
  for (let planAttempt = 0; planAttempt < PLAN_RETRY_LIMIT; planAttempt += 1) {
    const plan = buildQzonePlan({
      source: 'generic_autodraft',
      type: 'generic_autodraft',
      windowKey: '',
      groupId: normalizeText(input.groupId),
      today: '',
      planAttempt,
      now: Date.now(),
      recentHistory,
      recentFailures,
      allowImage: false,
      targetLength: '24-120'
    });
    const candidates = [];
    for (let candidateIndex = 0; candidateIndex < Math.max(1, CANDIDATE_COUNT); candidateIndex += 1) {
      const variantType = CANDIDATE_VARIANT_TYPES[candidateIndex] || CANDIDATE_VARIANT_TYPES[0];
      const prompt = buildCandidatePrompt(
        buildGenericAutodraftPrompt(requestText, {
          variationProfile: plan.variationProfile || {},
          recentHistory: recentFailures,
          plan
        }),
        plan,
        [
          buildQzoneVariantNote(variantType),
          candidateIndex > 0 ? `这是第 ${candidateIndex + 1} 个候选，请更换叙事节奏和切入角度。` : ''
        ].filter(Boolean).join('\n')
      );
      const response = await runDiaryDraftGeneration(prompt, {
        ...options,
        modelConfig: getModelConfigForQzoneAttempt(candidateIndex > 0 ? 'similarity' : '')
      });
      const normalized = normalizeGeneratedQzoneContent(response);
      const firstPerson = /我/.test(normalized);
      candidates.push({
        plan,
        variantType,
        text: normalized,
        rejected: !normalized || !firstPerson,
        rejectionReason: !normalized ? 'empty-output' : (!firstPerson ? 'not_first_person' : ''),
        meta: {
          mode: 'generic_autodraft',
          lens: plan.variationProfile?.lens || '',
          emotion: plan.variationProfile?.emotion || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          ending: plan.variationProfile?.ending || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || ''
        }
      });
    }
    const picked = pickBestCandidate(candidates, {
      source: 'generic_autodraft',
      recentHistory,
      plan
    });
    const selected = picked.selected;
    if (selected) {
      appendQzoneGenerationLog(normalizeTelemetryPayload({
        source: 'generic_autodraft',
        type: 'generic_autodraft',
        groupId: normalizeText(input.groupId),
        status: 'sent',
        selectedFingerprint: selected.fingerprint,
        selectedScore: selected.score,
        similarity: selected.similarity,
        noveltyScore: selected.noveltyScore,
        tropeCollisionScore: selected.tropeCollisionScore,
        circleNaturalnessScore: selected.circleNaturalnessScore,
        edgeTensionScore: selected.edgeTensionScore,
        failureReasons: [],
        planSummary: {
          fingerprint: plan.fingerprint,
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
          lens: plan.variationProfile?.lens || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || '',
          spark: plan.variationProfile?.spark || '',
          socialMask: plan.variationProfile?.socialMask || '',
          freshnessMode: plan.variationProfile?.freshnessMode || '',
          voiceEdge: plan.variationProfile?.voiceEdge || '',
          tropeFingerprint: plan.tropeFingerprint || ''
        },
        candidates: picked.ranked.map((item) => ({
          fingerprint: item.fingerprint,
          score: item.score,
          similarity: item.similarity,
          noveltyScore: item.noveltyScore,
          tropeCollisionScore: item.tropeCollisionScore,
          circleNaturalnessScore: item.circleNaturalnessScore,
          edgeTensionScore: item.edgeTensionScore,
          variantType: item.variantType,
          tropeFingerprint: item.tropeFingerprint,
          rejected: item.rejected,
          rejectionReason: item.rejectionReason
        }))
      }));
      return {
        ok: true,
        content: selected.text,
        meta: {
          mode: 'generic_autodraft',
          lens: plan.variationProfile?.lens || '',
          emotion: plan.variationProfile?.emotion || '',
          anchor: plan.variationProfile?.anchor || '',
          structure: plan.variationProfile?.structure || '',
          ending: plan.variationProfile?.ending || '',
          arc: plan.variationProfile?.arc || '',
          tempo: plan.variationProfile?.tempo || '',
          distance: plan.variationProfile?.distance || '',
          similarity: selected.similarity,
          selectedScore: selected.score,
          noveltyScore: selected.noveltyScore,
          tropeCollisionScore: selected.tropeCollisionScore,
          circleNaturalnessScore: selected.circleNaturalnessScore,
          edgeTensionScore: selected.edgeTensionScore,
          variantType: selected.variantType,
          topicKey: plan.theme?.key || '',
          topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
          planFingerprint: plan.fingerprint,
          tropeFingerprint: plan.tropeFingerprint || '',
          plan
        }
      };
    }
    finalFailure = picked.ranked[0]?.rejectionReason || 'generic_autodraft_rejected';
    appendQzoneGenerationLog(normalizeTelemetryPayload({
      source: 'generic_autodraft',
      type: 'generic_autodraft',
      groupId: normalizeText(input.groupId),
      status: 'failed',
      selectedFingerprint: '',
      selectedScore: 0,
      similarity: 0,
      failureReasons: uniqueBy(picked.ranked.map((item) => item.rejectionReason).filter(Boolean), (item) => item),
      planSummary: {
        fingerprint: plan.fingerprint,
        topicKey: plan.theme?.key || '',
        topicGroup: plan.theme?.key ? String(plan.theme.key).split('.')[0] : '',
        lens: plan.variationProfile?.lens || '',
        anchor: plan.variationProfile?.anchor || '',
        structure: plan.variationProfile?.structure || '',
        arc: plan.variationProfile?.arc || '',
        tempo: plan.variationProfile?.tempo || '',
        distance: plan.variationProfile?.distance || '',
        spark: plan.variationProfile?.spark || '',
        socialMask: plan.variationProfile?.socialMask || '',
        freshnessMode: plan.variationProfile?.freshnessMode || '',
        voiceEdge: plan.variationProfile?.voiceEdge || '',
        tropeFingerprint: plan.tropeFingerprint || ''
      },
      candidates: picked.ranked.map((item) => ({
        fingerprint: item.fingerprint,
        score: item.score,
        similarity: item.similarity,
        noveltyScore: item.noveltyScore,
        tropeCollisionScore: item.tropeCollisionScore,
        circleNaturalnessScore: item.circleNaturalnessScore,
        edgeTensionScore: item.edgeTensionScore,
        variantType: item.variantType,
        tropeFingerprint: item.tropeFingerprint,
        rejected: item.rejected,
        rejectionReason: item.rejectionReason
      }))
    }));
  }
  return {
    ok: false,
    reason: finalFailure || 'generic qzone draft generation failed',
    meta: {
      mode: 'generic_autodraft'
    }
  };
}

module.exports = {
  INTERNAL_LEAK_TERMS,
  buildBotDiaryPrompt,
  buildGenericAutodraftPrompt,
  buildFallbackBotDiaryMemoryQuery,
  detectQzonePostDraftMode,
  extractDiarySignals,
  findDiarySafetyIssues,
  generateBotDiaryDraft,
  generateGenericQzoneDraft,
  normalizeGeneratedQzoneContent,
  planBotDiaryMemoryQuery,
  recordQzoneGenerationHistory,
  runBotDiaryMemoryPrefetch
};
