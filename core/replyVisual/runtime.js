const defaultConfig = require('../../config');
const { sendImageMessageForContext } = require('../../api/qqActionService');
const {
  createPrivateStatusBarRuntime,
  getPrivateStatusBarIneligibilityReason,
  isPrivateStatusBarEligible
} = require('../privateStatusBar');
const { isReplyFailure } = require('../../utils/replyFailure');
const {
  createEmotionGate,
  resolveEmotionCooldownKey
} = require('./emotionGate');
const { createLive2dCatalog } = require('./catalog');
const { createLive2dRenderer } = require('../live2d/renderer');

function getReplyVisualIneligibilityReason(input = {}) {
  const options = input.replyOptions && typeof input.replyOptions === 'object' ? input.replyOptions : {};
  const plan = input.routeExecutionPlan && typeof input.routeExecutionPlan === 'object'
    ? input.routeExecutionPlan
    : {};
  const platform = String(input.platform || options.routeMeta?.platform || 'qq').trim().toLowerCase();
  const chatType = String(input.chatType || options.routeMeta?.chatType || '').trim().toLowerCase();
  const topRouteType = String(input.topRouteType || plan.topRouteType || options.topRouteType || '').trim().toLowerCase();
  const usedTools = input.usedTools === true || options.statusBarUsedTools === true;
  const replyText = String(input.replyText || '').trim();
  if (input.mainReplySent !== true) return 'main_reply_not_sent';
  if (platform !== 'qq') return 'not_qq';
  if (!['private', 'group'].includes(chatType)) return 'unsupported_chat';
  if (topRouteType !== 'direct_chat') return 'not_direct_chat';
  if (usedTools) return 'tools_used';
  if (input.replyEnvelope?.sendStrategy === 'rate_limit_poke') return 'rate_limited';
  if (String(input.replyEnvelope?.finalErrorCode || '').trim()) return 'reply_error';
  if (input.replyEnvelope?.hasSafetyRestriction === true) return 'safety_restriction';
  if (options.__dispatchFailed === true) return 'dispatch_failed';
  if (!replyText || isReplyFailure(replyText, { emptyIsFailure: true })) return 'reply_failure';
  if (!Array.isArray(options.statusBarSystemMessages) || options.statusBarSystemMessages.length === 0) {
    return 'missing_system_messages';
  }
  if (!options.statusBarVariableSnapshot || typeof options.statusBarVariableSnapshot !== 'object') {
    return 'missing_variable_snapshot';
  }
  return '';
}

function isReplyVisualEligible(input = {}) {
  return getReplyVisualIneligibilityReason(input) === '';
}

function createReplyVisualRuntime(options = {}) {
  const runtimeConfig = options.config || defaultConfig;
  const privateStatusBarRuntime = options.privateStatusBarRuntime || createPrivateStatusBarRuntime({
    config: runtimeConfig,
    actionClient: options.actionClient
  });
  const emotionGate = options.emotionGate || createEmotionGate({
    minConfidence: runtimeConfig.LIVE2D_EMOTION_MIN_CONFIDENCE,
    cooldownMs: runtimeConfig.LIVE2D_EMOTION_COOLDOWN_MS
  });
  const catalog = options.catalog || createLive2dCatalog({
    config: runtimeConfig,
    projectRoot: options.projectRoot
  });
  const renderer = options.renderer || createLive2dRenderer({ config: runtimeConfig });
  const sendImage = options.sendImage || ((context, imageInput) => sendImageMessageForContext(
    context,
    imageInput,
    { actionClient: options.actionClient }
  ));
  const now = options.now || (() => Date.now());

  async function handle(input = {}) {
    const statusBarEligible = runtimeConfig.PRIVATE_STATUS_BAR_ENABLED === true
      && isPrivateStatusBarEligible(input);
    const live2dEligible = runtimeConfig.LIVE2D_EMOTION_ENABLED === true
      && isReplyVisualEligible(input);
    if (!statusBarEligible && !live2dEligible) {
      return { ok: false, code: 'ineligible', reason: getReplyVisualIneligibilityReason(input) || 'disabled' };
    }
    const shouldSend = typeof input.shouldSend === 'function' ? input.shouldSend : () => true;
    if (!shouldSend()) return { ok: false, code: 'stale_before_model' };

    let modelResult;
    try {
      modelResult = await privateStatusBarRuntime.requestModel(input);
    } catch (_) {
      return { ok: false, code: 'model_failed' };
    }
    if (!modelResult?.ok) return modelResult || { ok: false, code: 'model_failed' };

    let statusBarResult = null;
    if (statusBarEligible) {
      statusBarResult = await privateStatusBarRuntime.sendWithModelResult(input, modelResult);
    }
    if (!live2dEligible) {
      return { ok: statusBarResult?.ok === true, code: statusBarResult?.code || 'status_bar_skipped' };
    }
    if (!shouldSend()) return { ok: false, code: 'stale_before_live2d', statusBarResult };

    const analysis = modelResult.analysis || {};
    const targetKey = resolveEmotionCooldownKey(input);
    const gate = emotionGate.check(targetKey, analysis, now());
    if (!gate.allowed) {
      return {
        ok: statusBarResult?.ok === true,
        code: 'emotion_skipped',
        reason: gate.reason,
        emotion: gate.emotion || '',
        intensity: gate.intensity || '',
        cooldownHit: gate.reason === 'cooldown',
        statusBarResult
      };
    }
    const resource = catalog.get(gate.emotion);
    if (!resource.ok) {
      return {
        ok: statusBarResult?.ok === true,
        code: 'resource_skipped',
        reason: resource.reason,
        emotion: gate.emotion,
        intensity: gate.intensity,
        cooldownHit: false,
        statusBarResult
      };
    }

    let rendered = { ok: false, code: 'renderer_unavailable' };
    try {
      rendered = await renderer.render({
        emotion: gate.emotion,
        intensity: gate.intensity,
        animation: resource.animation,
        modelDir: resource.modelDir
      });
    } catch (_) {}
    if (!shouldSend()) return { ok: false, code: 'stale_after_render', statusBarResult };
    const imageInput = rendered?.ok === true && Buffer.isBuffer(rendered.buffer)
      ? rendered.buffer
      : resource.fallbackPath
        ? { file: resource.fallbackPath }
        : null;
    if (!imageInput) {
      return {
        ok: statusBarResult?.ok === true,
        code: 'animation_skipped',
        reason: rendered?.code || 'no_fallback',
        emotion: gate.emotion,
        intensity: gate.intensity,
        cooldownHit: false,
        statusBarResult
      };
    }

    try {
      const sent = await sendImage({
        chatType: input.chatType,
        groupId: String(input.groupId || '').trim(),
        userId: String(input.userId || '').trim(),
        routeMeta: { routePolicyKey: 'reply-visual/live2d-emotion' }
      }, imageInput);
      emotionGate.markSent(targetKey, now());
      return {
        ok: true,
        code: rendered?.ok === true ? 'live2d_sent' : 'fallback_sent',
        messageId: sent?.messageId ?? null,
        emotion: gate.emotion,
        intensity: gate.intensity,
        cooldownHit: false,
        statusBarResult
      };
    } catch (_) {
      return { ok: statusBarResult?.ok === true, code: 'animation_send_failed', statusBarResult };
    }
  }

  return { handle };
}

module.exports = {
  createReplyVisualRuntime,
  getReplyVisualIneligibilityReason,
  isReplyVisualEligible
};
