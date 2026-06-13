const { buildRouteMetaEnvelope } = require('./executablePlan');
const {
  applyGroupDirectStyleGuard
} = require('../api/runtimeV2/guards/groupDirectReplyStyleGuard');
const {
  shouldForceDisableGroupMainModelStream
} = require('../utils/groupMainModelStreamPolicy');
const {
  shouldDowngradeUnavailableRouteToDirectReply
} = require('./messageRouteFlow/helpers');

function createMessageDispatchCoordinator(deps = {}) {
  const {
    config,
    buildRoutePromptBundle,
    getStreamMaxSegments,
    buildToolGuidancePrompt,
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
    publishQzoneForContext,
    markThinkingEmojiBeforeLlm,
    askToolTaskLocally,
    createStreamingDispatcher,
    composeDirectRoutePrompt,
    askAIDispatch,
    actionClient = null
  } = deps;

  function resolveVisionFallbackModelConfig(route = {}, imageUrl = null, userId = '') {
    const chatMode = String(route?.meta?.chatMode || '').trim().toLowerCase();
    const hasVisionInput = Boolean(String(imageUrl || '').trim())
      || chatMode === 'image_qa'
      || chatMode === 'image_summary';
    if (!hasVisionInput) return null;
    const { buildImageModelConfig } = require('../utils/imageModelConfigResolver');
    return buildImageModelConfig(null, userId, { routeMeta: route?.meta || {} });
  }

  function applyGroupDirectGuardToReply(reply = '', route = {}, routeExecutionPlan = {}, groupId = '') {
    const routeMeta = buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
      groupId,
      chatType: route?.meta?.chatType || 'group'
    });
    const guard = applyGroupDirectStyleGuard(reply, {
      topRouteType: routeExecutionPlan?.topRouteType || routeMeta.topRouteType,
      routeMeta
    });
    return guard.applied ? guard.text : String(reply || '').trim();
  }

  async function dispatchByRoutePlan({
    route,
    routeExecutionPlan,
    cleanText,
    imageUrl,
    imageUrls = [],
    userInfo,
    senderId,
    groupId,
    sourceMessageId = '',
    inboundContext = null,
    freshness = null
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
      buildStreamingSegmentationPrompt,
      shouldPreferQqRichReply,
      buildQqRichReplyPrompt
    });
    const {
      toolGuidancePrompt,
      streamingSegmentationPrompt,
      qqRichReplyPrompt,
      disableStreamForReply
    } = promptBundle;
    const safetyBoundaryRoutePrompt = buildSafetyBoundaryRoutePrompt(route);
    const perceptionResult = buildLlmPerception(inboundContext || {}, {
      passive: false
    });
    const perceptionPrompt = String(perceptionResult?.text || '').trim() || null;
    const downgradeUnavailableToDirectReply = shouldDowngradeUnavailableRouteToDirectReply(route, routeExecutionPlan);
    const effectiveToolGuidancePrompt = downgradeUnavailableToDirectReply ? null : toolGuidancePrompt;
    console.log('[dispatch] route plan resolved', buildRoutePlanLogPayload(routeExecutionPlan, {
      groupId,
      senderId,
      routeReason: String(route?.meta?.reason || '').trim()
    }, route));

    try {
      if (routeExecutionPlan.unavailableReason && !downgradeUnavailableToDirectReply) {
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
          routePrompt: [toolGuidancePrompt, perceptionPrompt].filter(Boolean).join('\n\n') || null,
          sessionChannel: 'qq-group',
          sessionChatId: `group_${groupId}_user_${senderId}`,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: routeExecutionPlan.routeDebugKey,
          topRouteType: routeExecutionPlan.topRouteType,
          dispatchBranch: routeExecutionPlan.executor === 'background_direct' ? 'background_direct' : 'tool_plan',
          triggerBranch: routeExecutionPlan.executor === 'background_direct' ? 'background_direct.final_send' : 'tool_plan.final_send',
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          imageUrls,
          deferPersist: false,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            groupId,
            messageId: String(sourceMessageId || '').trim(),
            threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim()
          }),
          threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim()
        };
        const fallbackModelConfig = resolveVisionFallbackModelConfig(route, imageUrl, senderId);
        if (fallbackModelConfig) {
          toolTaskOptions.modelConfig = fallbackModelConfig;
        }

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
            imageUrls,
            userInfo,
            senderId,
            groupId,
            toolTaskOptions
          });
        }

        const qzoneDraftMode = detectQzonePostDraftMode(route, cleanText);
        if (qzoneDraftMode === 'bot_diary') {
          const draftResult = await publishQzoneForContext({
            mode: 'bot_diary',
            hint: cleanText
          }, {
            userId: String(senderId || ''),
            routeMeta: {
              ...(route.meta || {}),
              userId: String(senderId || ''),
              groupId: String(groupId || '')
            }
          });
          reply = draftResult?.ok
            ? `已生成 QQ 空间 bot 日记草稿，未发布。\n\n内容：\n${draftResult.content}`
            : `生成 bot 日记草稿失败。\n\n原因：${draftResult?.reason || draftResult?.text || '未知错误'}`;
        } else if (qzoneDraftMode === 'generic_autodraft') {
          const draftResult = await publishQzoneForContext({
            mode: 'agent',
            hint: cleanText
          }, {
            userId: String(senderId || ''),
            routeMeta: {
              ...(route.meta || {}),
              userId: String(senderId || ''),
              groupId: String(groupId || '')
            }
          }, {
            qzoneSource: 'generic_autodraft',
            qzoneType: 'generic_autodraft'
          });
          reply = draftResult?.ok
            ? `已生成 QQ 空间草稿，未发布。\n\n内容：\n${draftResult.content}`
            : `这次没能生成可发布的 QQ 空间草稿。\n\n原因：${draftResult?.reason || draftResult?.text || '未知错误'}`;
        } else {
          await markThinkingEmojiBeforeLlm({
            messageId: sourceMessageId,
            routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
            routeMeta: route.meta || {},
            actionClient
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
          senderId,
          shouldSend: freshness && typeof freshness.shouldSend === 'function'
            ? freshness.shouldSend
            : null
        });
        const streamOptions = {
          onDelta: streamingDispatcher.onDelta,
          streamHadOutput: false,
          streamCompleted: false,
          streamFallbackToNonStream: false,
          routePrompt: composeDirectRoutePrompt({
            toolGuidancePrompt: effectiveToolGuidancePrompt,
            perceptionPrompt,
            safetyBoundaryRoutePrompt,
            streamingSegmentationPrompt,
            qqRichReplyPrompt
          }),
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeDebugKey: routeExecutionPlan.routeDebugKey,
          topRouteType: routeExecutionPlan.topRouteType,
          dispatchBranch: 'direct_reply',
          triggerBranch: 'direct_reply.final_send',
          disableTools: !routeExecutionPlan.allowTools,
          allowTools: routeExecutionPlan.allowTools,
          allowedTools: routeExecutionPlan.allowedTools,
          imageUrls,
          routeMeta: buildRouteMetaEnvelope(route, routeExecutionPlan, route?.meta?.toolPlanner || route?.meta?.directChatPlanner || null, {
            groupId,
            messageId: String(sourceMessageId || '').trim(),
            threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim()
          }),
          disableStream: disableStreamForReply || routeExecutionPlan.allowStream !== true,
          deferPersist: String(routeExecutionPlan?.topRouteType || '').trim().toLowerCase() === 'direct_chat',
          threadId: String(inboundContext?.threadId || inboundContext?.messageMeta?.threadId || '').trim()
        };
        const fallbackModelConfig = resolveVisionFallbackModelConfig(route, imageUrl, senderId);
        if (fallbackModelConfig) {
          streamOptions.modelConfig = fallbackModelConfig;
        }
        const replyOptions = streamOptions;
        if (shouldForceDisableGroupMainModelStream({
          groupId,
          routeMeta: replyOptions.routeMeta,
          isQqGroup: String(route?.meta?.chatType || 'group').trim().toLowerCase() === 'group',
          isDirectMainModelReply: true
        })) {
          replyOptions.disableStream = true;
        }
        finalReplyOptions = replyOptions;

        await markThinkingEmojiBeforeLlm({
          messageId: sourceMessageId,
          routePolicyKey: getEffectivePolicyKey(routeExecutionPlan),
          routeMeta: route.meta || {},
          actionClient
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
      reply: applyGroupDirectGuardToReply(reply, route, routeExecutionPlan, groupId),
      usedStreamingSend,
      replyOptions: finalReplyOptions,
      freshness
    };
  }

  return {
    dispatchByRoutePlan
  };
}

module.exports = {
  createMessageDispatchCoordinator
};
