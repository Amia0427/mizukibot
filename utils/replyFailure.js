function normalizeReplyText(text = '') {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function classifyReplyFailure(text = '') {
  const compact = normalizeReplyText(text);
  if (!compact) {
    return {
      type: 'none',
      text: compact
    };
  }

  const lower = compact.toLowerCase();

  if (
    /insufficient[_\s-]?user[_\s-]?quota/i.test(compact)
    || /insufficient[_\s-]?quota/i.test(compact)
    || /insufficient\s+balance/i.test(compact)
    || /exhausted\s+your\s+capacity/i.test(compact)
    || /all\s+available\s+accounts\s+exhausted/i.test(compact)
    || /quota[_\s-]?(?:exceeded|failed|error)/i.test(compact)
    || /预扣费额度失败|用户剩余额度|余额不足|额度不足|额度失败|额度好像见底/i.test(compact)
  ) {
    return {
      type: 'provider_quota',
      text: compact
    };
  }

  if (/^model invocation failed:\s*tool loop limit reached\b/i.test(compact)) {
    return {
      type: 'tool_loop_limit',
      text: compact
    };
  }

  if (
    /^tool error:/i.test(compact)
    || /^unknown tool:/i.test(compact)
    || /^tool not allowed:/i.test(compact)
    || /^tool call markup was returned without executing any tool/i.test(compact)
  ) {
    return {
      type: 'tool_error',
      text: compact
    };
  }

  if (
    /\binvalid api key\b/i.test(compact)
    || /\bunauthorized\b/i.test(compact)
    || /\bauthentication failed\b/i.test(compact)
    || /\bforbidden\b/i.test(compact)
    || /鉴权失败|无效的令牌|配置异常|模型钥匙|配置像是没扣好/i.test(compact)
  ) {
    return {
      type: 'provider_auth',
      text: compact
    };
  }

  if (
    /\brequest was blocked\b/i.test(compact)
    || /\bcontent[_\s-]?filter\b/i.test(compact)
    || /上游风控拦截|上游拦截|请求被拦截|请求被拒绝|风控拦截|刚刚那句被卡掉了/i.test(compact)
  ) {
    return {
      type: 'provider_blocked',
      text: compact
    };
  }

  if (
    /^model invocation failed:/i.test(compact)
    || /^status_code=\d+/i.test(compact)
    || /^\{[\s\S]*"type"\s*:\s*"error"/i.test(compact)
    || /^\[[^\]]*error[^\]]*\]/i.test(compact)
    || /^the model response format was malformed/i.test(compact)
    || /^i received tool data, but failed/i.test(compact)
    || /^i drifted for a second\./i.test(compact)
    || /^我刚才在整理最终回答时没有拿到稳定正文/i.test(compact)
    || /^the network or upstream model did not respond correctly/i.test(compact)
    || /模型返回格式不稳定|没拿到可用正文/i.test(compact)
    || /刚刚那句没组织稳|刚刚空了一拍|这句格式歪掉了|刚刚处理到一半卡住了|这边刚刚没接稳/i.test(compact)
    || /记忆那边刚刚绕住了|刚刚翻记忆没翻稳|翻完以后那句空掉了|上下文塞得太满啦|模型调用刚刚卡住了/i.test(compact)
    || /\btimeout\b/i.test(compact)
    || /\bstream first token timeout\b/i.test(compact)
    || /卡了\s*75\s*秒/i.test(compact)
    || /\btroubleshooting url:\b/i.test(compact)
  ) {
    return {
      type: 'generic_model_failure',
      text: compact
    };
  }

  return {
    type: 'none',
    text: compact
  };
}

function isReplyFailure(text = '', options = {}) {
  const compact = normalizeReplyText(text);
  if (!compact) return Boolean(options.emptyIsFailure);
  return classifyReplyFailure(compact).type !== 'none';
}

module.exports = {
  classifyReplyFailure,
  isReplyFailure,
  normalizeReplyText
};
