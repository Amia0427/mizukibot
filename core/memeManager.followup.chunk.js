async function maybeSendMemeFollowup({
  surface,
  groupId,
  senderId,
  sendWithRetry,
  routePolicyKey,
  topRouteType,
  userText,
  replyText,
  rawMessage = '',
  routeMeta = null,
  replyToMessageId = '',
  recentMessagesOverride = null,
  passiveDecisionMeta = null
}) {
  try {
    if (!config.MEME_MANAGER_FOLLOWUP_ENABLED) {
      console.log('[meme-manager] selector skipped', { surface, reason: 'followup-disabled' });
      return { sent: false, reason: 'followup-disabled' };
    }

    if (!isSurfaceEnabled(surface)) {
      console.log('[meme-manager] selector skipped', { surface, reason: 'surface-disabled' });
      return { sent: false, reason: 'surface-disabled' };
    }

    const replyMeta = buildReplyMeta({ replyText, routeMeta });
    const skipReason = getHardSkipReason(replyText, replyMeta);
    if (skipReason) {
      console.log('[meme-manager] selector skipped', { surface, reason: skipReason });
      return { sent: false, reason: skipReason };
    }

    const recentTurns = surface === 'scheduled'
      ? []
      : buildRecentTurns({ groupId, recentMessagesOverride, userText });
    const recentMessages = Array.isArray(recentMessagesOverride)
      ? recentMessagesOverride
      : (groupId ? getRecentMessages(groupId) : []);
    const quoteText = buildQuoteText({
      rawMessage,
      replyToMessageId,
      recentMessages
    });
    const passiveContext = buildPassiveContext(surface, passiveDecisionMeta);
    const contextSourceFlags = buildContextSourceFlags({
      quoteText,
      recentTurns,
      replyMeta,
      passiveContext,
      surface
    });

    const selectionResult = await selectCategory({
      surface,
      groupId,
      routePolicyKey,
      topRouteType,
      userText,
      replyText,
      quoteText,
      recentTurns,
      replyMeta,
      passiveContext
    });

    const selection = selectionResult.selection || null;
    if (selectionResult.skipped || !selection || !selection.selectedCategory) {
      console.log('[meme-manager] selector skipped', {
        surface,
        reason: selectionResult.reason,
        availableCategoryNames: selectionResult.availableCategoryNames || [],
        mood: selection?.mood || 'none',
        intensity: selection?.intensity || 'low',
        confidence: Number(selection?.confidence || 0),
        selectedCategory: selection?.selectedCategory || '',
        decisionSource: selection?.decisionSource || 'llm-structured',
        keywordHits: Array.isArray(selection?.keywordHits) ? selection.keywordHits : [],
        quoteTextPreview: previewSelectorText(quoteText),
        recentTurnCount: recentTurns.length,
        replyMeta,
        passiveContext,
        contextSourceFlags
      });
      return { sent: false, reason: selectionResult.reason || 'selector-skipped' };
    }

    const gate = evaluateMemeGate({
      surface,
      groupId,
      selection,
      replyMeta,
      now: Date.now()
    });
    if (!gate.allowed) {
      console.log('[meme-manager] selector skipped', {
        surface,
        reason: gate.reason,
        availableCategoryNames: selectionResult.availableCategoryNames || [],
        mood: selection.mood,
        intensity: selection.intensity,
        confidence: selection.confidence,
        selectedCategory: selection.selectedCategory,
        decisionSource: selection.decisionSource,
        keywordHits: selection.keywordHits,
        probability: gate.probability,
        cooldownRemainingMs: gate.cooldownRemainingMs,
        quoteTextPreview: previewSelectorText(quoteText),
        recentTurnCount: recentTurns.length,
        replyMeta,
        passiveContext,
        contextSourceFlags
      });
      return { sent: false, reason: gate.reason };
    }

    const assetDecision = pickBestAssetForSelection({
      groupId,
      selection,
      replyText,
      userText,
      quoteText,
      recentTurns,
      selectorReason: selection.reason,
      replyMeta,
      surface,
      routePolicyKey,
      topRouteType
    });
    const asset = assetDecision?.asset || null;
    if (!asset || !asset.absolutePath) {
      console.log('[meme-manager] selector skipped', {
        surface,
        reason: 'no-asset-for-category',
        availableCategoryNames: selectionResult.availableCategoryNames || [],
        mood: selection.mood,
        intensity: selection.intensity,
        confidence: selection.confidence,
        selectedCategory: selection.selectedCategory,
        decisionSource: selection.decisionSource,
        keywordHits: selection.keywordHits,
        assetScore: assetDecision?.totalScore || 0,
        quoteTextPreview: previewSelectorText(quoteText),
        recentTurnCount: recentTurns.length,
        replyMeta,
        passiveContext,
        contextSourceFlags
      });
      return { sent: false, reason: 'no-asset-for-category' };
    }

    console.log('[meme-manager] selector selected', {
      surface,
      availableCategoryNames: selectionResult.availableCategoryNames || [],
      mood: selection.mood,
      intensity: selection.intensity,
      confidence: selection.confidence,
      selectedCategory: selection.selectedCategory,
      decisionSource: selection.decisionSource,
      keywordHits: selection.keywordHits,
      assetId: asset.id,
      assetScore: assetDecision?.totalScore || 0,
      probability: gate.probability,
      quoteTextPreview: previewSelectorText(quoteText),
      recentTurnCount: recentTurns.length,
      replyMeta,
      passiveContext,
      contextSourceFlags
    });

    const ok = await sendWithRetry({
      action: 'send_group_msg',
      params: {
        group_id: groupId,
        message: [{ type: 'image', data: { file: toBase64ImageFile(asset.absolutePath) } }]
      }
    }, 1, 300);

    console.log(`[meme-manager] followup send ${ok ? 'ok' : 'failed'}`, {
      surface,
      groupId,
      senderId,
      availableCategoryNames: selectionResult.availableCategoryNames || [],
      mood: selection.mood,
      intensity: selection.intensity,
      confidence: selection.confidence,
      selectedCategory: selection.selectedCategory,
      decisionSource: selection.decisionSource,
      keywordHits: selection.keywordHits,
      assetScore: assetDecision?.totalScore || 0,
      probability: gate.probability,
      quoteTextPreview: previewSelectorText(quoteText),
      recentTurnCount: recentTurns.length,
      replyMeta,
      passiveContext,
      contextSourceFlags,
      assetId: asset.id
    });
    if (ok) {
      updateFollowupRuntime(groupId, selection, asset, Date.now());
    }
    return { sent: ok, reason: ok ? 'ok' : 'send-failed' };
  } catch (error) {
    console.log('[meme-manager] selector skipped', {
      surface,
      reason: error?.message || String(error)
    });
    return { sent: false, reason: error?.message || String(error) };
  }
}

