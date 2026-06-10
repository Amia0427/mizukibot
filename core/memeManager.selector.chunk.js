function buildSelectorPrompt() {
  return buildRuntimePrompt('meme-emotion-selector');
}

function tokenizeOverlapTerms(value = '') {
  const normalized = String(value || '').toLowerCase();
  const matches = normalized.match(/[a-z0-9_]{2,}|[\u4e00-\u9fff]{1,}/g) || [];
  return uniqueStrings(matches);
}

function getReplyContextTags({ surface = '', replyMeta = {}, routePolicyKey = '', topRouteType = '' } = {}) {
  const tags = new Set();
  if (replyMeta?.responseIntent === 'summary') tags.add('formal_status');
  if (replyMeta?.responseIntent === 'plan' || replyMeta?.responseIntent === 'action_guidance') tags.add('technical_help');
  if (replyMeta?.isFailureReply) tags.add('failure_recovery');
  if (replyMeta?.isToolLike) tags.add('technical_help');
  if (replyMeta?.hasPraiseCue) tags.add('praise');
  if (replyMeta?.hasConfusedCue) tags.add('confusion_reaction');
  if (replyMeta?.hasComfortCue) tags.add('comfort');
  if (replyMeta?.hasAnnoyedCue) tags.add('annoyance');
  if (replyMeta?.isQuestionReply) tags.add('technical_help');
  if (replyMeta?.lengthBucket === 'short' && ['praise', 'playful', 'confused'].includes(String(routePolicyKey || '').trim())) {
    tags.add('playful_banter');
  }
  if (String(surface || '').trim() === 'direct') tags.add('greeting');
  if (String(topRouteType || '').trim() === 'chat') tags.add('playful_banter');
  return [...tags];
}

function getAssetGlobalUsage(assetId = '') {
  const key = String(assetId || '').trim();
  const state = runtimeStoreCache.assets[key];
  return {
    sentCount: Math.max(0, Number(state?.sentCount) || 0),
    lastSentAt: Math.max(0, Number(state?.lastSentAt) || 0)
  };
}

function scoreAssetKeywordOverlap(resolved = {}, combinedText = '') {
  const terms = new Set(tokenizeOverlapTerms(combinedText));
  if (!terms.size) return { score: 0, hits: [] };
  const candidates = [
    resolved.summary,
    resolved.textContent,
    ...(Array.isArray(resolved.expressionTags) ? resolved.expressionTags : []),
    ...(Array.isArray(resolved.sceneTags) ? resolved.sceneTags : []),
    ...(Array.isArray(resolved.styleTags) ? resolved.styleTags : []),
    ...(Array.isArray(resolved.subjectTags) ? resolved.subjectTags : []),
    ...(Array.isArray(resolved.textTags) ? resolved.textTags : [])
  ];
  const hits = [];
  for (const candidate of candidates) {
    const words = tokenizeOverlapTerms(candidate);
    for (const word of words) {
      if (!terms.has(word) || hits.includes(word)) continue;
      hits.push(word);
      if (hits.length >= 5) break;
    }
    if (hits.length >= 5) break;
  }
  return { score: hits.length, hits };
}

function compareAssetScores(left, right) {
  if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
  if (left.globalSentCount !== right.globalSentCount) return left.globalSentCount - right.globalSentCount;
  if (right.analysisReadyScore !== left.analysisReadyScore) return right.analysisReadyScore - left.analysisReadyScore;
  return String(left.asset?.id || '').localeCompare(String(right.asset?.id || ''));
}

function pickBestAssetForSelection({
  groupId = '',
  selection = {},
  replyText = '',
  userText = '',
  quoteText = '',
  recentTurns = [],
  selectorReason = '',
  replyMeta = {},
  surface = '',
  routePolicyKey = '',
  topRouteType = ''
} = {}) {
  const category = memeStore.getCategory(selection?.selectedCategory || '');
  if (!category || !Array.isArray(category.assets) || category.assets.length === 0) return null;

  const runtime = getFollowupRuntime(groupId);
  const recentAssetIds = Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds : [];
  const recentLatestId = recentAssetIds[recentAssetIds.length - 1] || '';
  const contextTags = getReplyContextTags({ surface, replyMeta, routePolicyKey, topRouteType });
  const combinedText = [
    String(replyText || '').trim(),
    String(userText || '').trim(),
    String(quoteText || '').trim(),
    ...(Array.isArray(recentTurns) ? recentTurns.map((item) => String(item?.text || '').trim()) : []),
    String(selectorReason || '').trim()
  ].filter(Boolean).join('\n');

  const scored = category.assets
    .filter((asset) => asset?.feedback?.blocked !== true)
    .map((asset) => {
      const analysis = resolveAssetAnalysis(asset);
      const resolved = analysis.resolved;
      const globalUsage = getAssetGlobalUsage(asset.id);
      let totalScore = 0;
      let analysisReadyScore = 0;

      if (analysis.status === 'ready') {
        analysisReadyScore = 2;
        totalScore += 2;
      }
      if (resolved.primaryMood === selection.mood) totalScore += 4;
      if (Array.isArray(resolved.secondaryMoods) && resolved.secondaryMoods.includes(selection.mood)) totalScore += 2;

      const intensityDistance = getIntensityDistance(resolved.intensity, selection.intensity);
      if (intensityDistance === 0) totalScore += 2;
      else if (intensityDistance === 1) totalScore += 1;
      else if (Number.isFinite(intensityDistance)) totalScore -= 2;

      const preferredMatches = (Array.isArray(resolved.preferredContexts) ? resolved.preferredContexts : [])
        .filter((item) => contextTags.includes(item))
        .slice(0, 2);
      const avoidMatches = (Array.isArray(resolved.avoidContexts) ? resolved.avoidContexts : [])
        .filter((item) => contextTags.includes(item))
        .slice(0, 2);
      totalScore += preferredMatches.length * 3;
      totalScore -= avoidMatches.length * 4;

      const overlap = scoreAssetKeywordOverlap(resolved, combinedText);
      totalScore += overlap.score;

      const feedback = asset.feedback || {};
      totalScore += Math.max(0, Number(feedback.likes) || 0);
      totalScore -= Math.max(0, Number(feedback.dislikes) || 0) * 2;
      totalScore -= Math.max(0, Number(feedback.skips) || 0);

      const assetId = String(asset.id || '').trim();
      if (assetId && recentLatestId === assetId) totalScore -= 5;
      else if (assetId && recentAssetIds.includes(assetId)) totalScore -= 3;

      return {
        asset: {
          ...asset,
          category: category.name,
          absolutePath: memeStore.getAssetAbsolutePath(category.name, asset.id)
        },
        totalScore,
        analysisReadyScore,
        overlapHits: overlap.hits,
        preferredMatches,
        avoidMatches,
        globalSentCount: globalUsage.sentCount
      };
    });

  scored.sort(compareAssetScores);
  return scored[0] || null;
}

function buildSelectorPayload({
  surface,
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  quoteText,
  recentTurns,
  replyMeta,
  passiveContext,
  categories
}) {
  return JSON.stringify({
    surface,
    routePolicyKey: String(routePolicyKey || '').trim() || 'chat/default',
    topRouteType: String(topRouteType || '').trim() || 'chat',
    userText: String(userText || '').trim(),
    replyText: String(replyText || '').trim(),
    quoteText: String(quoteText || '').trim(),
    recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
    replyMeta: replyMeta && typeof replyMeta === 'object' ? replyMeta : {},
    passiveContext: passiveContext && typeof passiveContext === 'object' ? passiveContext : {},
    categories: categories.map((item) => ({
      name: item.name,
      description: item.description,
      moods: Array.isArray(item.moods) ? item.moods : [],
      intensities: Array.isArray(item.intensities) ? item.intensities : [],
      keywords: Array.isArray(item.keywords) ? item.keywords : [],
      assetCount: item.assetCount
    }))
  });
}

async function runSelector({
  surface,
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  quoteText,
  recentTurns,
  replyMeta,
  passiveContext,
  categories
}) {
  const prompt = buildSelectorPrompt();
  const apiBaseUrl = ensureChatCompletionsUrl(getSelectorBaseUrl());
  const model = getSelectorModel();
  const provider = getApiProvider(apiBaseUrl, model);

  const response = await httpClient.postWithRetry(
    apiBaseUrl,
    {
      model,
      temperature: Number(config.MEME_MANAGER_TEMPERATURE || 0.2),
      max_tokens: Math.max(64, Number(config.MEME_MANAGER_MAX_TOKENS || 200)),
      stream: false,
      messages: [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: buildSelectorPayload({
            surface,
            routePolicyKey,
            topRouteType,
            userText,
            replyText,
            quoteText,
            recentTurns,
            replyMeta,
            passiveContext,
            categories
          })
        }
      ],
      __timeoutMs: Math.max(1000, Number(config.MEME_MANAGER_TIMEOUT_MS || 8000)),
      __trace: {
        source: 'meme_manager',
        phase: 'selector',
        purpose: 'meme_emotion_selection',
        routePolicyKey: String(routePolicyKey || '').trim(),
        topRouteType: String(topRouteType || '').trim(),
        userId: ''
      }
    },
    1,
    getSelectorApiKey()
  );

  const rawText = extractSelectorResponseText(response);
  const parsed = normalizeSelectorResult(extractJsonSafely(rawText) || parseLooseSelectorOutput(rawText));
  return { parsed, rawText, provider };
}

async function selectCategory({
  surface,
  groupId = '',
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  quoteText = '',
  recentTurns = [],
  replyMeta = {},
  passiveContext = {}
}) {
  const categories = memeStore.getSelectorCategories();
  const available = categories.filter((item) => item.assetCount > 0 && item.enabled !== false);
  const availableCategoryNames = available.map((item) => item.name);
  if (!available.length) {
    return { skipped: true, reason: 'no-assets', selection: null, availableCategoryNames };
  }
  if (!getSelectorBaseUrl() || !getSelectorModel()) {
    return { skipped: true, reason: 'router-missing', selection: null, availableCategoryNames };
  }

  const { parsed, rawText, provider } = await runSelector({
    surface,
    routePolicyKey,
    topRouteType,
    userText,
    replyText,
    quoteText,
    recentTurns,
    replyMeta,
    passiveContext,
    categories: available
  });

  if (!parsed) {
    console.log('[meme-manager] selector raw response', {
      surface,
      provider,
      rawTextPreview: previewSelectorText(rawText)
    });
    return { skipped: true, reason: 'invalid-json', selection: null, provider, availableCategoryNames };
  }

  const minConfidence = Number(config.MEME_MANAGER_MIN_CONFIDENCE || 0.45);
  if (!parsed.send) {
    return {
      skipped: true,
      reason: parsed.reason || 'none-selected',
      provider,
      availableCategoryNames,
      selection: {
        send: false,
        mood: 'none',
        intensity: parsed.intensity,
        confidence: parsed.confidence,
        reason: parsed.reason,
        selectedCategory: '',
        decisionSource: 'llm-structured',
        keywordHits: []
      }
    };
  }

  if (!Number.isFinite(parsed.confidence) || parsed.confidence < minConfidence) {
    return {
      skipped: true,
      reason: 'below-threshold',
      provider,
      availableCategoryNames,
      selection: {
        send: true,
        mood: parsed.mood,
        intensity: parsed.intensity,
        confidence: Number.isFinite(parsed.confidence) ? parsed.confidence : 0,
        reason: parsed.reason,
        selectedCategory: '',
        decisionSource: 'llm-structured',
        keywordHits: []
      }
    };
  }

  const selectorContext = {
    userText,
    replyText,
    quoteText,
    recentTurns,
    replyMeta,
    passiveContext,
    recentCategoryNames: buildRuntimeSummary(groupId).recentCategoryNames
  };
  const ranked = chooseCategoryBySelector(available, parsed, selectorContext);
  if (ranked.selectedCategory) {
    return {
      skipped: false,
      reason: parsed.reason,
      provider,
      availableCategoryNames,
      selection: {
        send: true,
        mood: parsed.mood,
        intensity: parsed.intensity,
        confidence: parsed.confidence,
        reason: parsed.reason,
        selectedCategory: ranked.selectedCategory,
        decisionSource: 'llm-structured',
        keywordHits: ranked.keywordHits
      }
    };
  }

  const localFallback = inferCategoryByLocalHeuristics(available, selectorContext);
  if (localFallback) {
    return {
      skipped: false,
      reason: localFallback.reason,
      provider,
      availableCategoryNames,
      selection: localFallback
    };
  }

  return {
    skipped: true,
    reason: 'no-category-match',
    provider,
    availableCategoryNames,
    selection: {
      send: true,
      mood: parsed.mood,
      intensity: parsed.intensity,
      confidence: parsed.confidence,
      reason: parsed.reason,
      selectedCategory: '',
      decisionSource: 'llm-structured',
      keywordHits: []
    }
  };
}

