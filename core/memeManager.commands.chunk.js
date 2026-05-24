async function runMemeTest({
  surface = 'direct',
  groupId = '',
  routePolicyKey = 'chat/default',
  topRouteType = 'chat',
  userText = '',
  replyText = '',
  quoteText = '',
  recentTurns = [],
  replyMeta = null,
  passiveContext = {}
}) {
  if (!config.MEME_MANAGER_FOLLOWUP_ENABLED) {
    return {
      send: false,
      mood: 'none',
      intensity: 'low',
      confidence: 0,
      selectedCategory: '',
      decisionSource: 'disabled',
      reason: 'followup-disabled',
      availableCategoryNames: [],
      keywordHits: [],
      selectedAssetId: '',
      assetScore: 0,
      contextUsed: {},
      gatePreview: {
        allowed: false,
        reason: 'followup-disabled',
        probability: 0,
        cooldownRemainingMs: 0
      }
    };
  }

  const normalizedReplyMeta = replyMeta && typeof replyMeta === 'object'
    ? { ...buildReplyMeta({ replyText, routeMeta: { responseIntent: replyMeta.responseIntent } }), ...replyMeta }
    : buildReplyMeta({ replyText, routeMeta: {} });
  const selectionResult = await selectCategory({
    surface,
    groupId,
    routePolicyKey,
    topRouteType,
    userText,
    replyText,
    quoteText,
    recentTurns: Array.isArray(recentTurns) ? recentTurns : [],
    replyMeta: normalizedReplyMeta,
    passiveContext: passiveContext && typeof passiveContext === 'object' ? passiveContext : {}
  });

  const selection = selectionResult.selection || {};
  const gatePreview = selectionResult.skipped || !selection.selectedCategory
    ? {
        allowed: false,
        reason: selectionResult.reason || 'selector-skipped',
        probability: 0,
        cooldownRemainingMs: 0
      }
    : evaluateMemeGate({
        surface,
        groupId,
        selection,
        replyMeta: normalizedReplyMeta,
        now: Date.now(),
        randomValue: 0
      });
  const assetPreview = selectionResult.skipped || !selection.selectedCategory
    ? null
    : pickBestAssetForSelection({
        groupId,
        selection,
        replyText,
        userText,
        quoteText,
        recentTurns,
        selectorReason: selection.reason,
        replyMeta: normalizedReplyMeta,
        surface,
        routePolicyKey,
        topRouteType
      });
  return {
    send: !selectionResult.skipped && selection.send === true && Boolean(selection.selectedCategory),
    mood: String(selection.mood || 'none'),
    intensity: String(selection.intensity || 'low'),
    confidence: Number(selection.confidence || 0),
    selectedCategory: String(selection.selectedCategory || ''),
    decisionSource: String(selection.decisionSource || 'llm-structured'),
    reason: String(selection.reason || selectionResult.reason || ''),
    availableCategoryNames: Array.isArray(selectionResult.availableCategoryNames) ? selectionResult.availableCategoryNames : [],
    keywordHits: Array.isArray(selection.keywordHits) ? selection.keywordHits : [],
    selectedAssetId: assetPreview?.asset?.id || '',
    assetScore: Number(assetPreview?.totalScore || 0),
    contextUsed: buildContextSourceFlags({
      quoteText,
      recentTurns,
      replyMeta: normalizedReplyMeta,
      passiveContext,
      surface
    }),
    gatePreview
  };
}

async function handleAdminCommand({ rawText, groupId, userId }) {
  const command = parseMemeCommand(rawText);
  if (!command) return null;

  if (!isAdmin(userId)) {
    return { handled: true, replyText: '仅管理员可用。' };
  }

  try {
    if (command.action === 'help') return { handled: true, replyText: buildHelpText() };
    if (command.action === 'status') {
      const store = memeStore.getStore();
      const session = getUploadSession(groupId, userId);
      const categories = memeStore.listCategories();
      const runtime = buildRuntimeSummary(groupId);
      const reindexStatus = getReindexStatus();
      const surfaceFlags = [
        `direct=${store.surfaces.direct !== false}`,
        `passive=${store.surfaces.passive !== false}`,
        `scheduled=${store.surfaces.scheduled !== false}`
      ].join(', ');
      return {
        handled: true,
        replyText: [
          `meme manager: ${store.enabled && config.MEME_MANAGER_ENABLED ? 'on' : 'off'}`,
          `followup sender: ${config.MEME_MANAGER_FOLLOWUP_ENABLED ? 'on' : 'off'}`,
          `surfaces: ${surfaceFlags}`,
          `categories: ${categories.length}`,
          session ? `uploading: ${session.categoryName} (${Math.max(0, session.expiresAt - Date.now())}ms left)` : 'uploading: none',
          `cooldownRemainingMs: ${runtime.cooldownRemainingMs}`,
          `recentAssetIds: ${runtime.recentAssetIds.join(', ') || '(empty)'}`,
          `recentCategoryNames: ${runtime.recentCategoryNames.join(', ') || '(empty)'}`,
          `lastMood: ${runtime.lastMood || '(empty)'}`,
          `reindex: running=${reindexStatus.running}, queued=${reindexStatus.queued}, processed=${reindexStatus.processed}, failed=${reindexStatus.failed}`
        ].join('\n')
      };
    }
    if (command.action === 'on') {
      memeStore.setEnabled(true);
      return { handled: true, replyText: 'meme manager 已开启。' };
    }
    if (command.action === 'off') {
      memeStore.setEnabled(false);
      return { handled: true, replyText: 'meme manager 已关闭。' };
    }
    if (command.action === 'categories') return { handled: true, replyText: listCategorySummaryLines().join('\n') };
    if (command.action === 'category-add') {
      memeStore.addCategory(command.categoryName, command.description);
      return { handled: true, replyText: `已创建分类：${command.categoryName}` };
    }
    if (command.action === 'category-desc') {
      memeStore.updateCategoryDescription(command.categoryName, command.description);
      return { handled: true, replyText: `已更新分类描述：${command.categoryName}` };
    }
    if (command.action === 'category-show') return { handled: true, replyText: formatCategoryDetails(command.categoryName) };
    if (command.action === 'category-moods') {
      const moods = parseCsvAliases(command.csv, (item) => normalizeMoodAlias(item));
      memeStore.updateCategoryMoods(command.categoryName, moods);
      return { handled: true, replyText: `已更新 moods：${command.categoryName} -> ${moods.join(', ')}` };
    }
    if (command.action === 'category-intensity') {
      const intensities = parseCsvAliases(command.csv, normalizeIntensityAlias);
      memeStore.updateCategoryIntensities(command.categoryName, intensities);
      return { handled: true, replyText: `已更新 intensities：${command.categoryName} -> ${intensities.join(', ') || '(all)'}` };
    }
    if (command.action === 'category-keywords') {
      const keywords = uniqueStrings(
        String(command.csv || '')
          .split(',')
          .flatMap((item) => String(item || '').split('，'))
          .map((item) => item.trim())
          .filter(Boolean)
      );
      memeStore.updateCategoryKeywords(command.categoryName, keywords);
      return { handled: true, replyText: `已更新 keywords：${command.categoryName} -> ${keywords.join(', ') || '(empty)'}` };
    }
    if (command.action === 'category-remove') {
      memeStore.removeCategory(command.categoryName);
      return { handled: true, replyText: `已删除空分类：${command.categoryName}` };
    }
    if (command.action === 'test') {
      const result = command.payload && typeof command.payload === 'object'
        ? await runMemeTest({
            surface: command.payload.surface || 'direct',
            routePolicyKey: command.payload.routePolicyKey || 'chat/default',
            topRouteType: command.payload.topRouteType || 'chat',
            userText: String(command.payload.userText || '').trim(),
            replyText: String(command.payload.replyText || '').trim(),
            quoteText: String(command.payload.quoteText || '').trim(),
            recentTurns: Array.isArray(command.payload.recentTurns) ? command.payload.recentTurns : [],
            replyMeta: command.payload.replyMeta && typeof command.payload.replyMeta === 'object' ? command.payload.replyMeta : null,
            passiveContext: command.payload.passiveContext && typeof command.payload.passiveContext === 'object' ? command.payload.passiveContext : {}
          })
        : await runMemeTest({ replyText: command.replyText });
      return {
        handled: true,
        replyText: [
          `send: ${result.send}`,
          `mood: ${result.mood}`,
          `intensity: ${result.intensity}`,
          `confidence: ${result.confidence}`,
          `selectedCategory: ${result.selectedCategory || '(none)'}`,
          `selectedAssetId: ${result.selectedAssetId || '(none)'}`,
          `decisionSource: ${result.decisionSource}`,
          `reason: ${result.reason || '(empty)'}`,
          `contextUsed: ${JSON.stringify(result.contextUsed || {})}`,
          `gatePreview: ${JSON.stringify(result.gatePreview || {})}`
        ].join('\n')
      };
    }
    if (command.action === 'add-session') {
      if (!command.categoryName) return { handled: true, replyText: '请提供分类名。' };
      const category = memeStore.getCategory(command.categoryName);
      if (!category) return { handled: true, replyText: '分类不存在。' };
      const session = startUploadSession({ groupId, userId, categoryName: command.categoryName });
      return {
        handled: true,
        replyText: `已开启上传窗口：${session.categoryName}\n60 秒内直接发送图片即可导入，完成后发 /meme done。`
      };
    }
    if (command.action === 'done') {
      const session = getUploadSession(groupId, userId);
      if (!session) return { handled: true, replyText: '当前没有进行中的上传窗口。' };
      endUploadSession(groupId, userId);
      return { handled: true, replyText: `已结束上传窗口：${session.categoryName}` };
    }
    if (command.action === 'cancel') {
      const session = getUploadSession(groupId, userId);
      if (!session) return { handled: true, replyText: '当前没有进行中的上传窗口。' };
      endUploadSession(groupId, userId);
      return { handled: true, replyText: `已取消上传窗口：${session.categoryName}` };
    }
    if (command.action === 'files') {
      if (!command.categoryName) return { handled: true, replyText: '请提供分类名。' };
      return { handled: true, replyText: formatFilesList(command.categoryName) };
    }
    if (command.action === 'delete-file') {
      if (!command.categoryName || !command.assetId) {
        return { handled: true, replyText: '请提供分类名和 assetId。' };
      }
      memeStore.deleteAsset(command.categoryName, command.assetId);
      return { handled: true, replyText: `已删除：${command.assetId}` };
    }
    if (command.action === 'asset-show') {
      return { handled: true, replyText: formatAssetDetails(command.categoryName, command.assetId) };
    }
    if (command.action === 'asset-patch') {
      const payload = JSON.parse(String(command.payloadText || '').trim() || '{}');
      memeStore.patchAssetOverrides(command.categoryName, command.assetId, payload);
      return { handled: true, replyText: formatAssetDetails(command.categoryName, command.assetId) };
    }
    if (command.action === 'asset-relabel') {
      enqueueReindexTasks([{ categoryName: command.categoryName, assetId: command.assetId }]);
      return { handled: true, replyText: `queued relabel: ${command.categoryName}/${command.assetId}` };
    }
    if (command.action === 'asset-feedback') {
      memeStore.applyAssetFeedback(command.categoryName, command.assetId, command.feedbackAction);
      return { handled: true, replyText: formatAssetDetails(command.categoryName, command.assetId) };
    }
    if (command.action === 'reindex-pending') {
      const tasks = memeStore.listAssetsNeedingAnalysis().map((item) => ({
        categoryName: item.categoryName,
        assetId: item.asset.id
      }));
      return { handled: true, replyText: `queued pending assets: ${enqueueReindexTasks(tasks)}` };
    }
    if (command.action === 'reindex-category') {
      const tasks = memeStore.listAssetsNeedingAnalysis({ categoryName: command.categoryName }).map((item) => ({
        categoryName: item.categoryName,
        assetId: item.asset.id
      }));
      return { handled: true, replyText: `queued category assets: ${enqueueReindexTasks(tasks)}` };
    }
    if (command.action === 'reindex-all') {
      const tasks = memeStore.listAllAssets().map((item) => ({
        categoryName: item.categoryName,
        assetId: item.asset.id
      }));
      return { handled: true, replyText: `queued all assets: ${enqueueReindexTasks(tasks)}` };
    }
    if (command.action === 'reindex-status') {
      return { handled: true, replyText: JSON.stringify(getReindexStatus()) };
    }
    return { handled: true, replyText: '未知 meme 管理命令，输入 /meme help 查看。' };
  } catch (error) {
    return { handled: true, replyText: `操作失败: ${error?.message || String(error)}` };
  }
}

