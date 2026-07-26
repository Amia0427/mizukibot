class SharedLinkError extends Error {
  constructor(code, message, options = {}) {
    super(message);
    this.name = 'SharedLinkError';
    this.code = String(code || 'UNKNOWN_ERROR').trim() || 'UNKNOWN_ERROR';
    this.status = Number(options.status || 0) || 0;
  }
}

function classifySharedLinkError(error) {
  if (error instanceof SharedLinkError) return error;
  const message = String(error?.message || error || '').trim();
  const lower = message.toLowerCase();
  if (error?.name === 'ZodError') {
    return new SharedLinkError('INVALID_RESPONSE', '平台返回的数据结构不符合预期');
  }
  if (error?.name === 'AbortError' || lower.includes('aborted') || lower.includes('timeout')) {
    return new SharedLinkError('TIMEOUT', '共享链接读取超时');
  }
  if (/disallowed|not allowed|private address|unsupported protocol|http or https/i.test(message)) {
    return new SharedLinkError('NETWORK_BLOCKED', '共享链接访问被安全策略阻止');
  }
  if (/maxcontentlength|maxbodylength|too large|size limit|exceeds/i.test(lower)) {
    return new SharedLinkError('RESPONSE_TOO_LARGE', '共享链接响应超过大小限制');
  }
  const status = Number(error?.response?.status || error?.status || 0);
  if (status === 404 || status === 410) return new SharedLinkError('NOT_FOUND', '内容不存在或已删除', { status });
  if (status === 401 || status === 403) return new SharedLinkError('PRIVATE_CONTENT', '内容不可公开访问', { status });
  if (status === 429) return new SharedLinkError('RATE_LIMITED', '平台请求过于频繁', { status });
  return new SharedLinkError('NETWORK_ERROR', '共享链接暂时无法读取', { status });
}

module.exports = {
  SharedLinkError,
  classifySharedLinkError
};
