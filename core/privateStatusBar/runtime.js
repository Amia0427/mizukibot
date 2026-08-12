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

function isPrivateStatusBarEligible(input = {}) {
  const options = input.replyOptions && typeof input.replyOptions === 'object' ? input.replyOptions : {};
  const plan = input.routeExecutionPlan && typeof input.routeExecutionPlan === 'object'
    ? input.routeExecutionPlan
    : {};
  const chatType = String(input.chatType || options.routeMeta?.chatType || '').trim().toLowerCase();
  const topRouteType = String(input.topRouteType || plan.topRouteType || options.topRouteType || '').trim().toLowerCase();
  const usedTools = input.usedTools === true || options.statusBarUsedTools === true;
  const replyText = String(input.replyText || '').trim();
  return Boolean(
    input.mainReplySent === true
    && chatType === 'private'
    && topRouteType === 'direct_chat'
    && !usedTools
    && input.replyEnvelope?.sendStrategy !== 'rate_limit_poke'
    && !String(input.replyEnvelope?.finalErrorCode || '').trim()
    && input.replyEnvelope?.hasSafetyRestriction !== true
    && options.__dispatchFailed !== true
    && replyText
    && !isReplyFailure(replyText, { emptyIsFailure: true })
    && Array.isArray(options.statusBarSystemMessages)
    && options.statusBarSystemMessages.length > 0
    && options.statusBarVariableSnapshot
    && typeof options.statusBarVariableSnapshot === 'object'
  );
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

  async function handle(input = {}) {
    if (runtimeConfig.PRIVATE_STATUS_BAR_ENABLED !== true || !isPrivateStatusBarEligible(input)) {
      return { ok: false, code: 'ineligible' };
    }
    const shouldSend = typeof input.shouldSend === 'function' ? input.shouldSend : () => true;
    if (!shouldSend()) return { ok: false, code: 'stale_before_model' };
    let stage = 'model';
    try {
      const thoughtResult = await requestInnerThought({
        systemMessages: input.replyOptions.statusBarSystemMessages,
        userText: input.userText,
        mainReply: input.replyText,
        statusSnapshot: input.replyOptions.statusBarVariableSnapshot,
        signal: input.signal
      });
      const text = protectStatusBarText(thoughtResult);
      if (!text) {
        return { ok: false, code: 'unsafe_inner_thought' };
      }
      if (!shouldSend()) return { ok: false, code: 'stale_before_render' };
      stage = 'portrait';
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

  return { handle };
}

module.exports = {
  createPrivateStatusBarRuntime,
  isPrivateStatusBarEligible,
  protectStatusBarText
};
