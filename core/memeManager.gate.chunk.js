function buildReplyMeta({ replyText = '', routeMeta = null }) {
  const failure = classifyReplyFailure(replyText);
  const responseIntent = normalizeResponseIntent(routeMeta?.responseIntent, 'answer');
  return {
    responseIntent,
    isFailureReply: failure.type !== 'none',
    failureType: failure.type,
    isToolLike: detectToolLikeReply(replyText),
    lengthBucket: buildLengthBucket(replyText),
    asksQuestion: detectQuestionReply(replyText),
    isQuestionReply: detectQuestionReply(replyText),
    hasPraiseCue: detectCue(replyText, [
      /夸|表扬|认同|厉害|真棒|太强|牛|可爱|喜欢|nice|great|awesome|cute|love/i
    ]),
    hasConfusedCue: detectCue(replyText, [
      /疑惑|装傻|没懂|什么鬼|啊\?|啊？|哈\?|哈？|why|what\??|confused/i
    ]),
    hasComfortCue: detectCue(replyText, [
      /安慰|抱抱|摸摸|别难过|没事|会好的|辛苦|心疼|hug|comfort|sad/i
    ]),
    hasAnnoyedCue: detectCue(replyText, [
      /嫌弃|生气|不爽|无语|烦|annoyed|angry/i
    ]),
    punctuationIntensity: buildPunctuationIntensity(replyText)
  };
}

function buildPassiveContext(surface = '', passiveDecisionMeta = null) {
  if (surface !== 'passive') return {};
  const meta = passiveDecisionMeta && typeof passiveDecisionMeta === 'object' ? passiveDecisionMeta : {};
  return {
    presenceState: String(meta.presenceState || '').trim(),
    presenceAction: String(meta.presenceAction || '').trim(),
    presenceReason: String(meta.presenceReason || '').trim(),
    lastAddressee: String(meta.addressee || meta.lastAddressee || '').trim()
  };
}

function buildContextSourceFlags({ quoteText = '', recentTurns = [], replyMeta = null, passiveContext = {}, surface = '' }) {
  return {
    quoteText: Boolean(String(quoteText || '').trim()),
    recentTurns: Array.isArray(recentTurns) && recentTurns.length > 0,
    replyMeta: Boolean(replyMeta && typeof replyMeta === 'object'),
    passiveContext: surface === 'passive' && Object.values(passiveContext || {}).some(Boolean)
  };
}

function computeKeywordHits(category, haystack = '') {
  const keywords = Array.isArray(category?.keywords) ? category.keywords : [];
  const text = String(haystack || '').trim();
  if (!text || !keywords.length) return [];
  return uniqueStrings(keywords.filter((keyword) => keyword && text.includes(keyword)).slice(0, 3));
}

function clampProbability(value) {
  return Math.max(0.05, Math.min(0.8, Number(value) || 0));
}

function getIntensityDistance(left = '', right = '') {
  const order = ['low', 'medium', 'high'];
  const leftIndex = order.indexOf(String(left || '').trim());
  const rightIndex = order.indexOf(String(right || '').trim());
  if (leftIndex < 0 || rightIndex < 0) return Number.POSITIVE_INFINITY;
  return Math.abs(leftIndex - rightIndex);
}

function trimRecentWindow(list = [], limit = 0) {
  const normalizedLimit = Math.max(0, Number(limit) || 0);
  if (normalizedLimit === 0) return [];
  return list.slice(-normalizedLimit);
}

function getFollowupRuntime(groupId = '') {
  const key = String(groupId || '').trim() || '__default__';
  const runtime = followupRuntime.get(key) || runtimeStoreCache.groups[key];
  if (runtime && typeof runtime === 'object') {
    return {
      lastSentAt: Math.max(0, Number(runtime.lastSentAt) || 0),
      recentAssetIds: Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds.slice() : [],
      recentCategoryNames: Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames.slice() : [],
      lastMood: String(runtime.lastMood || '').trim()
    };
  }
  return {
    lastSentAt: 0,
    recentAssetIds: [],
    recentCategoryNames: [],
    lastMood: ''
  };
}

function setFollowupRuntime(groupId = '', runtime = {}) {
  const key = String(groupId || '').trim() || '__default__';
  const normalized = {
    lastSentAt: Math.max(0, Number(runtime.lastSentAt) || 0),
    recentAssetIds: Array.isArray(runtime.recentAssetIds) ? runtime.recentAssetIds.slice() : [],
    recentCategoryNames: Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames.slice() : [],
    lastMood: String(runtime.lastMood || '').trim()
  };
  followupRuntime.set(key, normalized);
  runtimeStoreCache.groups[key] = {
    ...normalized,
    recentAssetIds: normalized.recentAssetIds.slice(),
    recentCategoryNames: normalized.recentCategoryNames.slice()
  };
  persistRuntimeStore();
}

function buildRuntimeSummary(groupId = '', now = Date.now()) {
  const runtime = getFollowupRuntime(groupId);
  const cooldownMs = Math.max(0, Number(config.MEME_MANAGER_GROUP_COOLDOWN_MS) || 0);
  const cooldownRemainingMs = Math.max(0, cooldownMs - Math.max(0, now - runtime.lastSentAt));
  return {
    ...runtime,
    cooldownRemainingMs
  };
}

function updateFollowupRuntime(groupId = '', selection = {}, asset = {}, now = Date.now()) {
  const previous = getFollowupRuntime(groupId);
  const recentAssetWindow = Math.max(0, Number(config.MEME_MANAGER_RECENT_ASSET_WINDOW) || 0);
  const recentCategoryWindow = Math.max(0, Number(config.MEME_MANAGER_RECENT_CATEGORY_WINDOW) || 0);
  const nextAssetIds = trimRecentWindow(
    [...previous.recentAssetIds, String(asset?.id || '').trim()].filter(Boolean),
    recentAssetWindow
  );
  const nextCategoryNames = trimRecentWindow(
    [...previous.recentCategoryNames, String(selection?.selectedCategory || '').trim()].filter(Boolean),
    recentCategoryWindow
  );
  setFollowupRuntime(groupId, {
    lastSentAt: Math.max(0, Number(now) || Date.now()),
    recentAssetIds: nextAssetIds,
    recentCategoryNames: nextCategoryNames,
    lastMood: String(selection?.mood || '').trim()
  });
  const assetId = String(asset?.id || '').trim();
  if (assetId) {
    const currentAssetRuntime = runtimeStoreCache.assets[assetId] || { sentCount: 0, lastSentAt: 0 };
    runtimeStoreCache.assets[assetId] = {
      sentCount: Math.max(0, Number(currentAssetRuntime.sentCount) || 0) + 1,
      lastSentAt: Math.max(0, Number(now) || Date.now())
    };
    persistRuntimeStore();
  }
}

function evaluateMemeGate({
  surface = '',
  groupId = '',
  selection = {},
  replyMeta = {},
  now = Date.now(),
  randomValue = Math.random()
} = {}) {
  const runtime = getFollowupRuntime(groupId);
  const cooldownMs = Math.max(0, Number(config.MEME_MANAGER_GROUP_COOLDOWN_MS) || 0);
  const elapsedMs = Math.max(0, Number(now) - runtime.lastSentAt);
  const cooldownRemainingMs = Math.max(0, cooldownMs - elapsedMs);
  if (runtime.lastSentAt > 0 && cooldownRemainingMs > 0) {
    return {
      allowed: false,
      reason: 'cooldown-active',
      probability: 0,
      cooldownRemainingMs
    };
  }

  let probability = Number(config.MEME_MANAGER_SEND_BASE_PROBABILITY || 0.3);
  if (replyMeta?.lengthBucket === 'short') probability += 0.2;
  if (replyMeta?.lengthBucket === 'medium') probability -= 0.1;
  if (Number(selection?.confidence || 0) >= 0.8) probability += 0.1;
  if (['praise', 'playful', 'confused'].includes(String(selection?.mood || '').trim())) probability += 0.05;
  if (replyMeta?.isQuestionReply === true) probability -= 0.15;
  if (String(surface || '').trim() === 'passive') probability -= 0.1;
  const recentCategories = Array.isArray(runtime.recentCategoryNames) ? runtime.recentCategoryNames : [];
  if (
    String(selection?.selectedCategory || '').trim()
    && recentCategories[recentCategories.length - 1] === String(selection.selectedCategory).trim()
  ) {
    probability -= 0.15;
  }
  probability = clampProbability(probability);
  const draw = Math.max(0, Math.min(1, Number(randomValue)));
  if (draw > probability) {
    return {
      allowed: false,
      reason: 'probability-rejected',
      probability,
      cooldownRemainingMs: 0
    };
  }

  return {
    allowed: true,
    reason: 'allowed',
    probability,
    cooldownRemainingMs: 0
  };
}

function scoreCategory(category, selectorResult, combinedText = '', recentCategoryNames = []) {
  const keywordHits = computeKeywordHits(category, combinedText);
  const keywordScore = Math.min(keywordHits.length, 3);
  const specificityScore = Array.isArray(category?.moods) && category.moods.length === 1 ? 1 : 0;
  const intensities = Array.isArray(category?.intensities) ? category.intensities : [];
  let intensityScore = 0;
  if (intensities.length === 0) {
    intensityScore = 1;
  } else if (intensities.includes(selectorResult.intensity)) {
    intensityScore = 3;
  } else {
    const nearestDistance = intensities.reduce((best, item) => {
      const distance = getIntensityDistance(item, selectorResult.intensity);
      return distance < best ? distance : best;
    }, Number.POSITIVE_INFINITY);
    intensityScore = nearestDistance === 1 ? 1 : -2;
  }
  const normalizedCategoryName = String(category?.name || '').trim();
  const normalizedRecentCategoryNames = (Array.isArray(recentCategoryNames) ? recentCategoryNames : [])
    .map((item) => String(item || '').trim());
  const recentPenaltyIndex = normalizedRecentCategoryNames.lastIndexOf(normalizedCategoryName);
  let recentPenalty = 0;
  if (recentPenaltyIndex >= 0) {
    recentPenalty = recentPenaltyIndex === normalizedRecentCategoryNames.length - 1 ? -4 : -2;
  }

  return {
    category,
    keywordHits,
    keywordScore,
    specificityScore,
    intensityScore,
    recentPenalty,
    totalScore: keywordScore * 2 + specificityScore + intensityScore + recentPenalty
  };
}

function compareCategoryScores(left, right) {
  if (right.totalScore !== left.totalScore) return right.totalScore - left.totalScore;
  if (right.keywordScore !== left.keywordScore) return right.keywordScore - left.keywordScore;
  const leftMoodCount = Array.isArray(left.category?.moods) ? left.category.moods.length : 0;
  const rightMoodCount = Array.isArray(right.category?.moods) ? right.category.moods.length : 0;
  if (leftMoodCount !== rightMoodCount) return leftMoodCount - rightMoodCount;
  const leftAssets = Number(left.category?.assetCount) || 0;
  const rightAssets = Number(right.category?.assetCount) || 0;
  if (rightAssets !== leftAssets) return rightAssets - leftAssets;
  return String(left.category?.name || '').localeCompare(String(right.category?.name || ''), 'zh-Hans-CN-u-co-pinyin');
}

function chooseCategoryBySelector(categories = [], selectorResult, context = {}) {
  const available = Array.isArray(categories) ? categories : [];
  if (!selectorResult?.send) {
    return { selectedCategory: '', candidateScores: [], keywordHits: [] };
  }

  const combinedText = [
    String(context.userText || '').trim(),
    String(context.replyText || '').trim(),
    String(context.quoteText || '').trim(),
    ...(Array.isArray(context.recentTurns) ? context.recentTurns.map((item) => String(item?.text || '').trim()) : []),
    String(selectorResult.reason || '').trim()
  ].filter(Boolean).join('\n');
  const candidates = available.filter((category) => {
    const moods = Array.isArray(category.moods) ? category.moods : [];
    if (!moods.includes(selectorResult.mood)) return false;
    return true;
  });

  const recentCategoryNames = Array.isArray(context.recentCategoryNames) ? context.recentCategoryNames : [];
  const scored = candidates.map((category) => scoreCategory(category, selectorResult, combinedText, recentCategoryNames));
  scored.sort(compareCategoryScores);
  return {
    selectedCategory: scored[0]?.category?.name || '',
    candidateScores: scored,
    keywordHits: scored[0]?.keywordHits || []
  };
}

function inferCategoryByLocalHeuristics(categories = [], context = {}) {
  const available = Array.isArray(categories) ? categories : [];
  if (!available.length) return null;

  const replyMeta = context.replyMeta && typeof context.replyMeta === 'object' ? context.replyMeta : {};
  if (replyMeta.isFailureReply || replyMeta.isToolLike || replyMeta.lengthBucket === 'long') {
    return null;
  }

  const combined = [
    String(context.userText || '').trim(),
    String(context.replyText || '').trim(),
    String(context.quoteText || '').trim(),
    ...(Array.isArray(context.recentTurns) ? context.recentTurns.map((item) => String(item?.text || '').trim()) : [])
  ].filter(Boolean).join('\n');
  if (!combined.trim()) return null;

  const ruleDefs = [
    {
      match: (text) => /开心|高兴|快乐|夸奖|夸夸|赞|棒|真棒|厉害|优秀|可爱|喜欢|好耶|太好了|不错|得意|轻松|认同|表扬|奖励|状态很好|心情很好|哈哈|playful|praise|cute|great|awesome|nice|love/i.test(text),
      aliases: ['开心', '夸奖', '可爱']
    },
    {
      match: (text) => /看不懂|没看懂|不懂|什么鬼|什么意思|疑惑|困惑|装傻|无语|迷惑|啊这|啊？|哈？|没听懂|不太确定|不明白|why|confused|what\?/i.test(text),
      aliases: ['装傻', '疑惑']
    },
    {
      match: (text) => /伤心|难过|低落|委屈|痛苦|崩溃|想哭|悲伤|心碎|沮丧|失落|可怜|难受|sad|cry|upset|depressed/i.test(text),
      aliases: ['伤心', '难过', '悲伤']
    },
    {
      match: (text) => /嫌弃|生气|不爽|烦|无语|annoyed|angry/i.test(text),
      aliases: ['嫌弃', '生气']
    }
  ];

  for (const rule of ruleDefs) {
    if (!rule.match(combined)) continue;
    const hit = available.find((item) => rule.aliases.includes(String(item.name || '').trim()));
    if (!hit) continue;
    return {
      send: true,
      mood: Array.isArray(hit.moods) && hit.moods[0] ? hit.moods[0] : 'playful',
      intensity: Array.isArray(hit.intensities) && hit.intensities[0] ? hit.intensities[0] : 'low',
      confidence: Math.max(Number(config.MEME_MANAGER_MIN_CONFIDENCE || 0.45), 0.46),
      reason: 'local-heuristic-fallback',
      selectedCategory: hit.name,
      decisionSource: 'local-heuristic-fallback',
      keywordHits: []
    };
  }

  return null;
}

