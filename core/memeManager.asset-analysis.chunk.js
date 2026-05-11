function shouldSkipFollowup(replyText = '') {
  const text = String(replyText || '').trim();
  if (!text) return 'empty-reply';
  if (/刚才.*(小问题|网络)|请再发一次|重试链路/i.test(text)) return 'failure-reply';
  return '';
}

function getHardSkipReason(replyText = '', replyMeta = null) {
  const baseReason = shouldSkipFollowup(replyText);
  if (baseReason) return baseReason;
  const meta = replyMeta && typeof replyMeta === 'object' ? replyMeta : {};
  if (meta.isFailureReply) return 'failure-reply';
  if (meta.isToolLike && meta.lengthBucket === 'long') return 'tool-like-long-reply';
  if (
    ['summary', 'plan', 'action_guidance'].includes(String(meta.responseIntent || '').trim())
    && String(meta.lengthBucket || '').trim() !== 'short'
  ) {
    return 'intent-long-reply';
  }
  return '';
}

function toBase64ImageFile(absolutePath) {
  const data = fs.readFileSync(absolutePath);
  return `base64://${data.toString('base64')}`;
}

function toInlineImagePart(absolutePath, mime = '') {
  const data = fs.readFileSync(absolutePath);
  return {
    type: 'input_image',
    media_type: String(mime || memeStore.inferMimeFromExt(absolutePath) || 'image/jpeg').trim() || 'image/jpeg',
    data: data.toString('base64')
  };
}

function buildAssetAnalyzerPrompt() {
  return buildRuntimePrompt('meme-asset-analyzer');
}

function getAssetAnalysisResolvedFields(asset = {}) {
  const analysis = asset?.analysis && typeof asset.analysis === 'object' ? asset.analysis : {};
  const auto = analysis.auto && typeof analysis.auto === 'object'
    ? analysis.auto
    : memeStore.defaultResolvedAssetAnalysis();
  const overrides = analysis.overrides && typeof analysis.overrides === 'object' ? analysis.overrides : {};
  const resolved = { ...auto };
  for (const field of ASSET_ANALYSIS_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(overrides, field)) continue;
    const value = overrides[field];
    const hasValue = Array.isArray(value) ? value.length > 0 : String(value || '').trim() !== '' || typeof value === 'number';
    if (hasValue) resolved[field] = value;
  }
  return resolved;
}

function resolveAssetAnalysis(asset = {}) {
  return {
    status: String(asset?.analysis?.status || 'pending').trim() || 'pending',
    version: Math.max(1, Number(asset?.analysis?.version) || 1),
    analyzedAt: Math.max(0, Number(asset?.analysis?.analyzedAt) || 0),
    model: String(asset?.analysis?.model || '').trim(),
    lastError: String(asset?.analysis?.lastError || '').trim(),
    resolved: getAssetAnalysisResolvedFields(asset),
    overrides: asset?.analysis?.overrides && typeof asset.analysis.overrides === 'object' ? asset.analysis.overrides : {},
    auto: asset?.analysis?.auto && typeof asset.analysis.auto === 'object' ? asset.analysis.auto : memeStore.defaultResolvedAssetAnalysis()
  };
}

function buildAssetAnalysisRequestContent(asset = {}, absolutePath = '') {
  return [
    { type: 'text', text: 'Analyze this meme asset for follow-up meme selection.' },
    { type: 'text', text: `assetId=${String(asset?.id || '').trim() || 'unknown'}` },
    toInlineImagePart(absolutePath, asset?.mime || '')
  ];
}

async function analyzeMemeAsset({ categoryName = '', assetId = '' } = {}) {
  if (!config.MEME_MANAGER_ASSET_ANALYSIS_ENABLED) {
    throw new Error('asset-analysis-disabled');
  }
  const category = String(categoryName || '').trim();
  const asset = memeStore.getAsset(category, assetId);
  if (!asset) throw new Error('Asset not found.');

  const absolutePath = memeStore.getAssetAbsolutePath(category, assetId);
  if (!absolutePath || !fs.existsSync(absolutePath)) {
    throw new Error('Asset file not found.');
  }

  const apiBaseUrl = ensureChatCompletionsUrl(getAssetAnalysisBaseUrl());
  const model = getAssetAnalysisModel();
  if (!apiBaseUrl || !model) {
    throw new Error('asset-analysis-model-missing');
  }

  const response = await httpClient.postWithRetry(
    apiBaseUrl,
    {
      model,
      temperature: 0.1,
      max_tokens: 600,
      stream: false,
      messages: [
        { role: 'system', content: buildAssetAnalyzerPrompt() },
        {
          role: 'user',
          content: buildAssetAnalysisRequestContent(asset, absolutePath)
        }
      ],
      __timeoutMs: Math.max(1000, Number(config.MEME_MANAGER_ASSET_ANALYSIS_TIMEOUT_MS || 20000)),
      __trace: {
        source: 'meme_manager',
        phase: 'asset_analysis',
        purpose: 'meme_asset_analysis',
        routePolicyKey: 'meme/asset-analysis',
        topRouteType: 'vision'
      }
    },
    1,
    getAssetAnalysisApiKey()
  );

  const rawText = extractSelectorResponseText(response);
  const parsed = extractJsonSafely(rawText);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('invalid-asset-analysis-json');
  }
  return {
    model,
    parsed: memeStore.normalizeAssetAnalysisPayload(parsed),
    rawText
  };
}

function getReindexTaskKey(categoryName = '', assetId = '') {
  return `${String(categoryName || '').trim()}::${String(assetId || '').trim()}`;
}

function getReindexStatus() {
  return {
    queued: reindexQueue.length,
    running: reindexState.running,
    activeTask: reindexState.activeTask ? { ...reindexState.activeTask } : null,
    processed: reindexState.processed,
    failed: reindexState.failed,
    lastError: reindexState.lastError,
    lastStartedAt: reindexState.lastStartedAt,
    lastFinishedAt: reindexState.lastFinishedAt
  };
}

function enqueueReindexTasks(tasks = []) {
  let enqueued = 0;
  for (const task of Array.isArray(tasks) ? tasks : []) {
    const categoryName = String(task?.categoryName || '').trim();
    const assetId = String(task?.assetId || '').trim();
    if (!categoryName || !assetId) continue;
    const key = getReindexTaskKey(categoryName, assetId);
    if (reindexQueueSet.has(key)) continue;
    reindexQueue.push({ categoryName, assetId });
    reindexQueueSet.add(key);
    enqueued += 1;
  }
  void drainReindexQueue();
  return enqueued;
}

async function processReindexTask(task = {}) {
  const categoryName = String(task.categoryName || '').trim();
  const assetId = String(task.assetId || '').trim();
  const now = Date.now();
  try {
    const analysisResult = await analyzeMemeAsset({ categoryName, assetId });
    memeStore.updateAssetAnalysis(categoryName, assetId, {
      status: 'ready',
      version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
      analyzedAt: now,
      model: analysisResult.model,
      lastError: '',
      auto: analysisResult.parsed
    });
    reindexState.processed += 1;
    return { ok: true };
  } catch (error) {
    memeStore.updateAssetAnalysis(categoryName, assetId, {
      status: 'failed',
      version: Number(config.MEME_MANAGER_ASSET_ANALYSIS_VERSION || 1),
      analyzedAt: now,
      model: getAssetAnalysisModel(),
      lastError: error?.message || String(error)
    });
    reindexState.failed += 1;
    reindexState.lastError = error?.message || String(error);
    return { ok: false, error };
  }
}

async function drainReindexQueue() {
  if (reindexState.running) return;
  reindexState.running = true;
  reindexState.lastStartedAt = Date.now();
  try {
    while (reindexQueue.length > 0) {
      const task = reindexQueue.shift();
      const key = getReindexTaskKey(task?.categoryName, task?.assetId);
      reindexQueueSet.delete(key);
      reindexState.activeTask = task ? { ...task } : null;
      await processReindexTask(task);
    }
  } finally {
    reindexState.activeTask = null;
    reindexState.running = false;
    reindexState.lastFinishedAt = Date.now();
  }
}

