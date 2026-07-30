const defaultConfig = require('../../config');
const { requestAssistantMessage: defaultRequestAssistantMessage } = require('../../api/graphModelIO');
const { sendImageMessageForContext } = require('../../api/qqActionService');
const { renderVisual: defaultRenderVisual } = require('../../api/visualRenderService');
const { queryMemory: defaultQueryMemory } = require('../../utils/memory-v3/query');
const { reviewVisualRenderContent } = require('../../utils/visualRenderModeration');
const { parseSmallTheaterCommand } = require('./command');
const { recallSmallTheaterMemories } = require('./memory');
const { generateSmallTheaterStory } = require('./story');
const { buildSmallTheaterHtml } = require('./template');

const REPLIES = Object.freeze({
  disabled: '小剧场暂时没有开放。',
  usage: '用法：/小剧场 [--无记忆] <剧情素材>，也可以回复一条文字消息后发送命令。',
  inputTooLong: '这次的剧情素材太长了，请精简后再试。',
  cooldown: '这一幕还在收尾，等几秒再来吧。',
  busy: '舞台现在正忙着，稍后再试。',
  blocked: '图片内容未通过敏感词审查，未发送。',
  failed: '舞台刚刚没搭好，过几秒再试一次吧。'
});

function createDefaultLogger(stage, payload) {
  console.log(`[small-theater] ${stage}`, payload);
}

function moderationLogPayload(review = {}) {
  return {
    allowed: review.allowed === true,
    reason: String(review.reason || '').trim(),
    stage: String(review.stage || '').trim(),
    matchedCount: Number(review.matchedCount || 0) || 0,
    categories: Array.isArray(review.categories) ? review.categories.map(String) : []
  };
}

function nonNegativeNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function createSmallTheaterRuntime(options = {}) {
  const runtimeConfig = options.config || defaultConfig;
  const now = options.now || Date.now;
  const logEvent = options.logEvent || createDefaultLogger;
  const queryMemory = options.queryMemory || defaultQueryMemory;
  const requestAssistantMessage = options.requestAssistantMessage || defaultRequestAssistantMessage;
  const reviewContent = options.reviewContent || reviewVisualRenderContent;
  const renderVisual = options.renderVisual || defaultRenderVisual;
  const sendImage = options.sendImage || ((context, buffer) => sendImageMessageForContext(
    context,
    buffer,
    { actionClient: options.actionClient }
  ));
  const activeUsers = new Set();
  const cooldownUntilByUser = new Map();
  let activeCount = 0;

  async function handle(input = {}) {
    const parsed = parseSmallTheaterCommand(input.rawText, {
      quotedText: input.quotedText,
      maxInputChars: runtimeConfig.SMALL_THEATER_MAX_INPUT_CHARS
    });
    if (!parsed.matched) return { handled: false };
    if (runtimeConfig.SMALL_THEATER_ENABLED !== true) {
      return { handled: true, ok: false, code: 'disabled', replyText: REPLIES.disabled };
    }
    if (!parsed.valid) {
      return {
        handled: true,
        ok: false,
        code: parsed.reason === 'input_too_long' ? 'input_too_long' : 'usage',
        replyText: parsed.reason === 'input_too_long' ? REPLIES.inputTooLong : REPLIES.usage
      };
    }

    const userId = String(input.userId || '').trim();
    const requestId = String(input.requestId || '').trim();
    const chatType = String(input.chatType || '').trim().toLowerCase() === 'private' ? 'private' : 'group';
    const groupId = String(input.groupId || '').trim();
    const eventBase = { requestId, chatType, inputChars: parsed.inputChars };
    const currentTime = now();
    const maxConcurrency = Math.max(1, Number(runtimeConfig.SMALL_THEATER_MAX_CONCURRENCY) || 2);
    if (activeUsers.has(userId) || activeCount >= maxConcurrency) {
      logEvent('rejected_busy', eventBase);
      return { handled: true, ok: false, code: 'busy', replyText: REPLIES.busy };
    }
    const cooldownUntil = Number(cooldownUntilByUser.get(userId) || 0) || 0;
    if (cooldownUntil > currentTime) {
      logEvent('rejected_cooldown', { ...eventBase, retryAfterMs: cooldownUntil - currentTime });
      return { handled: true, ok: false, code: 'cooldown', replyText: REPLIES.cooldown };
    }
    cooldownUntilByUser.delete(userId);
    cooldownUntilByUser.set(
      userId,
      currentTime + nonNegativeNumber(runtimeConfig.SMALL_THEATER_COOLDOWN_MS, 15000)
    );
    activeUsers.add(userId);
    activeCount += 1;

    let failureStage = 'prompt_moderation';
    try {
      const promptReview = reviewContent({
        prompt: parsed.promptText,
        renderer: 'html',
        markup: '<div></div>'
      });
      logEvent('moderation', { ...eventBase, ...moderationLogPayload(promptReview) });
      if (!promptReview.allowed) {
        return {
          handled: true,
          ok: false,
          code: 'content_blocked',
          replyText: String(promptReview.replacementText || REPLIES.blocked).trim()
        };
      }

      let memories = [];
      if (parsed.useMemory) {
        failureStage = 'memory_recall';
        try {
          memories = await recallSmallTheaterMemories({
            userId,
            groupId,
            chatType,
            query: parsed.queryText,
            topK: runtimeConfig.SMALL_THEATER_MEMORY_TOP_K
          }, { queryMemory });
          logEvent('memory_recalled', { ...eventBase, hitCount: memories.length });
        } catch (_) {
          logEvent('memory_degraded', { ...eventBase, hitCount: 0, errorCode: 'memory_unavailable' });
        }
      }

      failureStage = 'story_generation';
      const story = await generateSmallTheaterStory({
        material: parsed.material,
        quotedText: parsed.quotedText,
        memories,
        userId,
        groupId,
        chatType,
        requestId,
        timeoutMs: runtimeConfig.SMALL_THEATER_MODEL_TIMEOUT_MS
      }, { requestAssistantMessage });
      const markup = buildSmallTheaterHtml(story);

      failureStage = 'output_moderation';
      const outputReview = reviewContent({
        prompt: parsed.promptText,
        renderer: 'html',
        markup
      });
      logEvent('moderation', { ...eventBase, ...moderationLogPayload(outputReview) });
      if (!outputReview.allowed) {
        return {
          handled: true,
          ok: false,
          code: 'content_blocked',
          replyText: String(outputReview.replacementText || REPLIES.blocked).trim()
        };
      }

      failureStage = 'render';
      const rendered = await renderVisual({
        renderer: 'html',
        markup,
        width: 900,
        max_height: 2000
      });
      failureStage = 'send';
      const sent = await sendImage({
        chatType,
        groupId,
        userId,
        routeMeta: {
          routePolicyKey: 'small-theater/command',
          requestId
        }
      }, rendered.buffer);
      logEvent('completed', {
        ...eventBase,
        memoryHitCount: memories.length,
        imageBytes: rendered.buffer.length,
        messageId: sent.messageId ?? null
      });
      return {
        handled: true,
        ok: true,
        code: 'sent',
        messageId: sent.messageId ?? null,
        memoryHitCount: memories.length,
        usedMemory: parsed.useMemory
      };
    } catch (error) {
      cooldownUntilByUser.set(
        userId,
        now() + nonNegativeNumber(runtimeConfig.SMALL_THEATER_FAILURE_RETRY_COOLDOWN_MS, 5000)
      );
      logEvent('failed', {
        ...eventBase,
        stage: failureStage,
        errorCode: String(error?.code || error?.name || 'unexpected_error').trim()
      });
      return { handled: true, ok: false, code: 'generation_failed', replyText: REPLIES.failed };
    } finally {
      activeUsers.delete(userId);
      activeCount -= 1;
    }
  }

  return { handle };
}

module.exports = {
  REPLIES,
  createSmallTheaterRuntime
};
