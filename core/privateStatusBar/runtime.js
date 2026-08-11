const defaultConfig = require('../../config');
const { sendImageMessageForContext } = require('../../api/qqActionService');
const { renderVisual: defaultRenderVisual } = require('../../api/visualRenderService');
const { reviewVisualRenderContent: defaultReviewContent } = require('../../utils/visualRenderModeration');
const { protectFinalOutput } = require('../../utils/promptSecurity');
const { isUnsafeUserFacingReply } = require('../../utils/userFacingReplyGuards');
const { isReplyFailure } = require('../../utils/replyFailure');
const { createPrivateStatusBarModelClient } = require('./model');
const { buildPrivateStatusBarHtml } = require('./template');

function isPrivateStatusBarEligible(input = {}) {
  const options = input.replyOptions && typeof input.replyOptions === 'object' ? input.replyOptions : {};
  const plan = input.routeExecutionPlan && typeof input.routeExecutionPlan === 'object'
    ? input.routeExecutionPlan
    : {};
  const chatType = String(input.chatType || options.routeMeta?.chatType || '').trim().toLowerCase();
  const topRouteType = String(input.topRouteType || plan.topRouteType || options.topRouteType || '').trim().toLowerCase();
  const allowedTools = Array.isArray(input.allowedTools)
    ? input.allowedTools
    : (Array.isArray(plan.allowedTools) ? plan.allowedTools : options.allowedTools);
  const hasTools = input.allowTools === true
    || plan.allowTools === true
    || options.allowTools === true
    || (Array.isArray(allowedTools) && allowedTools.length > 0);
  const replyText = String(input.replyText || '').trim();
  return Boolean(
    input.mainReplySent === true
    && chatType === 'private'
    && topRouteType === 'direct_chat'
    && !hasTools
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
    try {
      const thoughtResult = await requestInnerThought({
        systemMessages: input.replyOptions.statusBarSystemMessages,
        userText: input.userText,
        mainReply: input.replyText,
        statusSnapshot: input.replyOptions.statusBarVariableSnapshot,
        signal: input.signal
      });
      const thought = String(thoughtResult?.inner_thought || '').replace(/\s+/g, ' ').trim();
      if (!thought || thought.length > 40 || isUnsafeUserFacingReply(thought)) {
        return { ok: false, code: 'unsafe_inner_thought' };
      }
      const protectedThought = protectFinalOutput(thought);
      if (protectedThought.blocked || !protectedThought.text) {
        return { ok: false, code: 'sensitive_inner_thought' };
      }
      if (!shouldSend()) return { ok: false, code: 'stale_before_render' };
      const markup = buildPrivateStatusBarHtml({
        snapshot: input.replyOptions.statusBarVariableSnapshot,
        innerThought: protectedThought.text
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
      const rendered = await renderVisual({
        renderer: 'html',
        markup,
        width: 800,
        max_height: 320
      });
      if (!shouldSend()) return { ok: false, code: 'stale_after_render' };
      const sent = await sendImage({
        chatType: 'private',
        groupId: '',
        userId: String(input.userId || '').trim(),
        routeMeta: { routePolicyKey: 'private-status-bar/direct-chat' }
      }, rendered.buffer);
      return { ok: true, code: 'sent', messageId: sent?.messageId ?? null };
    } catch (_) {
      return { ok: false, code: 'failed' };
    }
  }

  return { handle };
}

module.exports = {
  createPrivateStatusBarRuntime,
  isPrivateStatusBarEligible
};
