function createMessageDispatchCoordinator(deps = {}) {
  const {
    config,
    buildRoutePromptBundle,
    getStreamMaxSegments,
    buildToolGuidancePrompt,
    buildBridgeGuidancePrompt,
    buildStreamingSegmentationPrompt,
    shouldPreferQqRichReply,
    buildQqRichReplyPrompt,
    buildSafetyBoundaryRoutePrompt,
    buildLlmPerception,
    buildRoutePlanLogPayload,
    maybeCaptureUnavailableFeatureRequest,
    buildUnavailableRouteReply,
    getEffectivePolicyKey,
    runBackgroundToolTask,
    detectQzonePostDraftMode,
    generateBotDiaryDraft,
    generateGenericQzoneDraft,
    normalizeGeneratedQzoneContent,
    publishQzoneForContext,
    markThinkingEmojiBeforeLlm,
    askToolTaskLocally,
    createStreamingDispatcher,
    composeDirectRoutePrompt,
    askAIDispatch
  } = deps;

  async function dispatchByRoutePlan({
    route,
    routeExecutionPlan,
    cleanText,
    imageUrl,
    userInfo,
    senderId,
    groupId,
    sourceMessageId = '',
    inboundContext = null
  }) {
    let reply = '';
    let usedStreamingSend = false;
    let finalReplyOptions = null;
    const promptBundle = buildRoutePromptBundle({
      route,
      routeExecutionPlan,
      cleanText,
      maxStreamSegments: getStreamMaxSegments(config),
      buildToolGuidancePrompt,
      buildBridgeGuidancePrompt: routeExecutionPlan?.executor === 'full_subagent'
        ? (currentRoute) => buildBridgeGuidancePrompt(currentRoute, config.SUBAGENT_BACKEND || 'command', routeExecutionPlan)
        : null,
      buildStreamingSegmentationPrompt,
      shouldPreferQqRichReply,
      buildQqRichReplyPrompt
    });
    const {
      toolGuidancePrompt,
      bridgeGuidancePrompt,
      streamingSegmentationPrompt,
      qqRichReplyPrompt,
      disableStreamForReply
    } = promptBundle;
    const safetyBoundaryRoutePrompt = buildSafetyBoundaryRoutePrompt(route);
    const perceptionResult = buildLlmPerception(inboundContext || {}, {
      passive: false
    });
    const perceptionPrompt = String(perceptionResult?.text || '').trim() || null;
    console.log('[dispatch] route plan resolved', buildRoutePlanLogPayload(routeExecutionPlan, {
      groupId,
      senderId,
      routeReason: String(route?.meta?.reason || '').trim()
    }, route));

    try {
      if (routeExecutionPlan.unavailableReason) {
        maybeCaptureUnavailableFeatureRequest({
          routeExecutionPlan,
          cleanText,
          senderId,
          groupId,
          route
        });
        reply = buildUnavailableRouteReply(route, routeExecutionPlan);
      } else if (routeExecutionPlan.allowTools || routeExecutionPlan.executor === 'background_direct') {
        const toolTaskOptions = {
          routePrompt: [toolGuidancePrompt, bridgeGuidancePrompt, perceptionPrompt].filter(Boolean).join('\n\n') || null,
          sessionChannel: 'qq-group',
          sessionChatId: `group_${groupId}_user_${senderId}`,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          routeMeta: {
            ...(route.meta || {}),
            groupId,
            topRouteType: routeExecutionPlan.topRouteType,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            allowedTools: routeExecutionPlan.allowedTools
          }
        };

        console.log('[dispatch] tool route resolved', buildRoutePlanLogPayload(routeExecutionPlan, {
          groupId,
          senderId
        }, route));

        if (config.BACKGROUND_TOOL_TASKS_ENABLED && routeExecutionPlan.executor === 'background_direct') {
          return runBackgroundToolTask({
            route,
            routeExecutionPlan,
            cleanText,
            imageUrl,
            userInfo,
            senderId,
            groupId,
            toolTaskOptions
          });
        }

        const qzoneDraftMode = detectQzonePostDraftMode(route, cleanText);
        if (qzoneDraftMode === 'bot_diary') {
          const diaryDraft = await generateBotDiaryDraft({
            groupId: String(groupId || ''),
            hint: cleanText
          });
          if (!diaryDraft.ok) {
            reply = `?????????? bot ???\n\n?????${diaryDraft.reason || '????'}`;
          } else {
            const publishResult = await publishQzoneForContext({
              mode: 'manual',
              content: diaryDraft.content
            }, {
              userId: String(senderId || ''),
              routeMeta: {
                ...(route.meta || {}),
                userId: String(senderId || ''),
                groupId: String(groupId || '')
              }
            });
            reply = publishResult?.ok
              ? `??? bot ??? QQ ?????\n\n???\n${diaryDraft.content}`
              : `?? bot ????????? QQ ??????\n\n?????${publishResult?.text || '????'}`;
          }
        } else if (qzoneDraftMode === 'generic_autodraft') {
          const drafted = await generateGenericQzoneDraft({
            requestText: cleanText,
            groupId: String(groupId || '')
          });
          const draftedContent = drafted.ok ? normalizeGeneratedQzoneContent(drafted.content) : '';

          if (!draftedContent) {
            reply = '????????????????????????????????????';
          } else {
            const publishResult = await publishQzoneForContext(draftedContent, {
              userId: String(senderId || ''),
              qzoneSource: 'generic_autodraft',
              qzoneType: 'generic_autodraft',
              lens: drafted?.meta?.lens,
              emotion: drafted?.meta?.emotion,
              anchor: drafted?.meta?.anchor,
              structure: drafted?.meta?.structure,
              ending: drafted?.meta?.ending,
              routeMeta: {
                ...(route.meta || {}),
                userId: String(senderId || ''),
                groupId: String(groupId || '')
              }
            });
            reply = publishResult?.ok
              ? `???????? QQ ???\n\n???\n${draftedContent}`
              : `????????????? QQ ??????\n\n?????${publishResult?.text || '????'}\n\n???\n${draftedContent}`;
          }
        } else {
          await markThinkingEmojiBeforeLlm({
            messageId: sourceMessageId,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            routeMeta: route.meta || {}
          });
          reply = await askToolTaskLocally(cleanText, userInfo, senderId, null, imageUrl, toolTaskOptions);
        }
        console.log('[dispatch] tool route completed', buildRoutePlanLogPayload(routeExecutionPlan, {
          groupId,
          senderId,
          replyLength: String(reply || '').trim().length
        }, route));
      } else {
        const streamingDispatcher = createStreamingDispatcher({
          config,
          sendWithRetry: deps.sendWithRetry,
          chatType: String(route?.meta?.chatType || 'group'),
          groupId,
          userId: senderId,
          senderId
        });
        const streamOptions = {
          onDelta: streamingDispatcher.onDelta,
          streamHadOutput: false,
          streamCompleted: false,
          streamFallbackToNonStream: false,
          routePrompt: composeDirectRoutePrompt({
            toolGuidancePrompt,
            bridgeGuidancePrompt,
            perceptionPrompt,
            safetyBoundaryRoutePrompt,
            streamingSegmentationPrompt,
            qqRichReplyPrompt
          }),
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: getEffectivePolicyKey(routeExecutionPlan),
          topRouteType: routeExecutionPlan.topRouteType,
          disableTools: !routeExecutionPlan.allowTools,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          routeMeta: {
            ...(route.meta || {}),
            groupId,
            topRouteType: routeExecutionPlan.topRouteType,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan)
          },
          disableStream: disableStreamForReply
        };
        const replyOptions = streamOptions;
        finalReplyOptions = replyOptions;

        await markThinkingEmojiBeforeLlm({
          messageId: sourceMessageId,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeMeta: route.meta || {}
        });
        reply = await askAIDispatch(cleanText, userInfo, senderId, null, imageUrl, replyOptions);
        console.log('[dispatch] chat route completed', buildRoutePlanLogPayload(routeExecutionPlan, {
          groupId,
          senderId,
          streamCompleted: Boolean(replyOptions.streamCompleted),
          streamHadOutput: Boolean(replyOptions.streamHadOutput),
          disableStream: Boolean(replyOptions.disableStream),
          replyLength: String(reply || '').trim().length
        }, route));

        if (replyOptions.streamCompleted && replyOptions.streamHadOutput) {
          usedStreamingSend = true;
          await streamingDispatcher.finish(reply);
        }
      }
    } catch (dispatchErr) {
      console.error('[dispatch] failed:', buildRoutePlanLogPayload(routeExecutionPlan, {
        groupId,
        senderId,
        error: dispatchErr?.message || String(dispatchErr || '')
      }, route));
      if (!String(reply || '').trim()) {
        reply = '???????????????????????????????????????';
      }
    }

    return {
      reply,
      usedStreamingSend,
      replyOptions: finalReplyOptions
    };
  }

  return {
    dispatchByRoutePlan
  };
}

module.exports = {
  createMessageDispatchCoordinator
};
