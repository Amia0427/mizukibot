const ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE = 'ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT';
const ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON = 'admin_private_main_reply_stream_first_token_timeout';
const ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY = '管理员主回复上游一直没出首字，我先断开这次慢请求。你再发一次我重新接。';

function formatTimeoutSeconds(timeoutMs = 0) {
  const normalizedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  if (!normalizedTimeoutMs) return '';
  const seconds = Math.max(1, Math.round(normalizedTimeoutMs / 1000));
  return `${seconds} 秒`;
}

function buildAdminPrivateMainReplyStreamTimeoutReply(timeoutMs = 0) {
  const secondsText = formatTimeoutSeconds(timeoutMs);
  if (!secondsText) return ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY;
  return `管理员主回复上游 ${secondsText} 还没出首字，我先断开这次慢请求。你再发一次我重新接。`;
}

function createAdminPrivateMainReplyStreamFirstTokenTimeoutError(timeoutMs = 0) {
  const normalizedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  const error = new Error(`Admin private main reply stream first token timeout after ${normalizedTimeoutMs}ms`);
  error.code = ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE;
  error.reason = ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON;
  error.adminPrivateStreamFirstTokenTimeout = true;
  error.bypassMainModelFallback = true;
  error.userFacingReply = buildAdminPrivateMainReplyStreamTimeoutReply(normalizedTimeoutMs);
  error.streamHadOutput = false;
  error.timeoutMs = normalizedTimeoutMs;
  return error;
}

function isAdminPrivateMainReplyStreamFirstTokenTimeout(error) {
  return Boolean(
    error?.adminPrivateStreamFirstTokenTimeout === true
    || String(error?.code || '').trim() === ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE
    || String(error?.reason || '').trim() === ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON
  );
}

function getAdminPrivateMainReplyStreamTimeoutReply(error = null) {
  return String(error?.userFacingReply || '').trim() || ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY;
}

module.exports = {
  ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE,
  ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON,
  ADMIN_PRIVATE_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY,
  buildAdminPrivateMainReplyStreamTimeoutReply,
  createAdminPrivateMainReplyStreamFirstTokenTimeoutError,
  getAdminPrivateMainReplyStreamTimeoutReply,
  isAdminPrivateMainReplyStreamFirstTokenTimeout
};
