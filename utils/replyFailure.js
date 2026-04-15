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
    || /鉴权失败|无效的令牌|配置异常/i.test(compact)
  ) {
    return {
      type: 'provider_auth',
      text: compact
    };
  }

  if (
    /\brequest was blocked\b/i.test(compact)
    || /\bcontent[_\s-]?filter\b/i.test(compact)
    || /上游风控拦截|上游拦截|请求被拦截|请求被拒绝|风控拦截/i.test(compact)
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
    || /\btimeout\b/i.test(compact)
    || /\bstream first token timeout\b/i.test(compact)
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
