const config = require('../../config');
const { renderVisual } = require('../visualRenderService');
const { sendImageMessageForContext } = require('../qqActionService');
const { reviewVisualRenderContent } = require('../../utils/visualRenderModeration');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function resolveOriginalPrompt(context = {}) {
  const routeMeta = context.routeMeta && typeof context.routeMeta === 'object' ? context.routeMeta : {};
  return normalizeText(
    context.rawText
    || context.question
    || context.cleanText
    || routeMeta.rawText
    || routeMeta.cleanText
    || routeMeta.effectiveIntentText
  );
}

async function renderQqVisual(args = {}, deps = {}) {
  const runtimeConfig = deps.config || config;
  const context = args.__context && typeof args.__context === 'object' ? args.__context : {};
  const review = (deps.reviewContent || reviewVisualRenderContent)({
    prompt: resolveOriginalPrompt(context),
    renderer: args.renderer,
    markup: args.markup
  }, deps.moderationOptions || {});

  if (!review.allowed) {
    console.warn('[visual-render] request blocked', {
      reason: review.reason,
      stage: review.stage,
      matchedCount: review.matchedCount,
      categories: Array.isArray(review.categories) ? review.categories : []
    });
    return review.replacementText || '图片内容未通过敏感词审查，未发送。';
  }

  let rendered;
  try {
    rendered = await (deps.renderVisual || renderVisual)({
      renderer: args.renderer,
      markup: args.markup,
      width: args.width,
      max_height: args.max_height
    }, { config: runtimeConfig, ...(deps.renderDeps || {}) });
  } catch (error) {
    console.warn('[visual-render] render failed', {
      renderer: normalizeText(args.renderer),
      code: normalizeText(error?.code || 'render_failed')
    });
    return error?.code === 'disabled'
      ? 'QQ 图片渲染能力尚未启用。'
      : '图片渲染失败，未发送。';
  }

  let sent;
  try {
    sent = await (deps.sendImageMessageForContext || sendImageMessageForContext)(context, rendered.buffer, deps.sendOptions || {});
  } catch (error) {
    console.warn('[visual-render] send failed', {
      renderer: rendered.renderer,
      error: normalizeText(error?.message || 'send_failed')
    });
    return '图片已渲染，但发送失败。';
  }

  return JSON.stringify({
    status: 'sent',
    renderer: rendered.renderer,
    width: rendered.width,
    height: rendered.height,
    message_id: sent.messageId ?? null
  });
}

module.exports = {
  renderQqVisual,
  resolveOriginalPrompt
};
