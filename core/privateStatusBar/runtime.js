const defaultConfig = require('../../config');
const { sendImageMessageForContext } = require('../../api/qqActionService');
const { renderVisual: defaultRenderVisual } = require('../../api/visualRenderService');
const { reviewVisualRenderContent: defaultReviewContent } = require('../../utils/visualRenderModeration');
const { protectFinalOutput } = require('../../utils/promptSecurity');
const { isUnsafeUserFacingReply } = require('../../utils/userFacingReplyGuards');
const { isReplyFailure } = require('../../utils/replyFailure');
const { createPrivateStatusBarModelClient } = require('./model');
const {
  optimizePortraitImageSource,
  resolvePortraitImageSource,
  selectPortraitImage
} = require('./portrait');
const { buildPrivateStatusBarHtml } = require('./template');

const STATUS_BAR_TEXT_LIMITS = {
  affection_note: 80,
  mood_note: 80,
  inner_thought: 120
};

function protectStatusBarText(result = {}) {
  const protectedText = {};
  for (const [field, limit] of Object.entries(STATUS_BAR_TEXT_LIMITS)) {
    const value = String(result[field] || '').replace(/\s+/g, ' ').trim();
    if (!value || value.length > limit || isUnsafeUserFacingReply(value)) return null;
    const checked = protectFinalOutput(value);
    if (checked.blocked || !checked.text) return null;
    protectedText[field] = checked.text;
  }
  return protectedText;
}

function getPrivateStatusBarIneligibilityReason(input = {}) {
  const options = input.replyOptions && typeof input.replyOptions === 'object' ? input.replyOptions : {};
  const plan = input.routeExecutionPlan && typeof input.routeExecutionPlan === 'object'
    ? input.routeExecutionPlan
    : {};
  const chatType = String(input.chatType || options.routeMeta?.chatType || '').trim().toLowerCase();
  const topRouteType = String(input.topRouteType || plan.topRouteType || options.topRouteType || '').trim().toLowerCase();
  const usedTools = input.usedTools === true || options.statusBarUsedTools === true;
  const replyText = String(input.replyText || '').trim();
  if (input.mainReplySent !== true) return 'main_reply_not_sent';
  if (chatType !== 'private') return 'not_private_chat';
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

function isPrivateStatusBarEligible(input = {}) {
  return getPrivateStatusBarIneligibilityReason(input) === '';
}

function createPrivateStatusBarRuntime(options = {}) {
  const runtimeConfig = options.config || defaultConfig;
  const requestInnerThought = options.requestInnerThought
    || createPrivateStatusBarModelClient(runtimeConfig, options.modelClientOptions);
  const reviewContent = options.reviewContent || defaultReviewContent;
  const renderVisual = options.renderVisual || defaultRenderVisual;
  const sendImage = options.sendImage || ((context, buffer) => sendImageMessageForContext(
    context,
    buffer,
    { actionClient: options.actionClient }
  ));
  const now = options.now || (() => new Date());

  async function requestModel(input = {}) {
    const thoughtResult = await requestInnerThought({
      systemMessages: input.replyOptions.statusBarSystemMessages,
      userText: input.userText,
      mainReply: input.replyText,
      statusSnapshot: input.replyOptions.statusBarVariableSnapshot,
      signal: input.signal
    });
    const text = protectStatusBarText(thoughtResult);
    if (!text) return { ok: false, code: 'unsafe_inner_thought' };
    return {
      ok: true,
      code: 'analyzed',
      analysis: thoughtResult,
      text
    };
  }

  async function sendWithModelResult(input = {}, modelResult = {}) {
    const shouldSend = typeof input.shouldSend === 'function' ? input.shouldSend : () => true;
    const text = modelResult.text || protectStatusBarText(modelResult.analysis || modelResult);
    if (!text) return { ok: false, code: 'unsafe_inner_thought' };
    let stage = 'portrait';
    try {
      if (!shouldSend()) return { ok: false, code: 'stale_before_render' };
      const snapshot = input.replyOptions.statusBarVariableSnapshot;
      const portraitSource = await resolvePortraitImageSource(selectPortraitImage(
        runtimeConfig.PRIVATE_STATUS_BAR_IMAGE_URLS,
        snapshot.relationship?.affection
      ));
      const portraitImage = await optimizePortraitImageSource(portraitSource);
      stage = 'markup';
      const markup = buildPrivateStatusBarHtml({
        snapshot,
        text
      }, {
        now: now(),
        timezone: runtimeConfig.TIMEZONE
      });
      const review = reviewContent({
        prompt: String(input.userText || '').trim() || 'QQ 私聊状态栏',
        renderer: 'html',
        markup
      });
      if (!review?.allowed) return { ok: false, code: 'moderation_blocked' };
      if (!shouldSend()) return { ok: false, code: 'stale_before_send' };
      stage = 'render';
      const rendered = await renderVisual({
        renderer: 'html',
        markup,
        width: 960,
        max_height: 640,
        trusted_images: portraitImage ? { portrait: portraitImage } : {}
      });
      if (!shouldSend()) return { ok: false, code: 'stale_after_render' };
      stage = 'send';
      const sent = await sendImage({
        chatType: 'private',
        groupId: '',
        userId: String(input.userId || '').trim(),
        routeMeta: { routePolicyKey: 'private-status-bar/direct-chat' }
      }, rendered.buffer);
      return { ok: true, code: 'sent', messageId: sent?.messageId ?? null };
    } catch (_) {
      return { ok: false, code: 'failed', stage };
    }
  }

  async function handle(input = {}) {
    const ineligibilityReason = runtimeConfig.PRIVATE_STATUS_BAR_ENABLED === true
      ? getPrivateStatusBarIneligibilityReason(input)
      : 'disabled';
    if (ineligibilityReason) {
      return { ok: false, code: 'ineligible', reason: ineligibilityReason };
    }
    const shouldSend = typeof input.shouldSend === 'function' ? input.shouldSend : () => true;
    if (!shouldSend()) return { ok: false, code: 'stale_before_model' };
    let stage = 'model';
    try {
      const modelResult = await requestModel(input);
      if (!modelResult.ok) return modelResult;
      return await sendWithModelResult(input, modelResult);
    } catch (_) {
      return { ok: false, code: 'failed', stage };
    }
  }

  return { handle, requestModel, sendWithModelResult };
}

module.exports = {
  createPrivateStatusBarRuntime,
  getPrivateStatusBarIneligibilityReason,
  isPrivateStatusBarEligible,
  protectStatusBarText
};
