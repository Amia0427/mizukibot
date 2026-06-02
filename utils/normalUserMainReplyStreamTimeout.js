const NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE = 'NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT';
const NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON = 'normal_user_main_reply_stream_first_token_timeout';
const NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY = '流式输出75秒超时，已自动断开';

function createNormalUserMainReplyStreamFirstTokenTimeoutError(timeoutMs = 0) {
  const normalizedTimeoutMs = Math.max(0, Math.floor(Number(timeoutMs) || 0));
  const error = new Error(`Normal user main reply stream first token timeout after ${normalizedTimeoutMs}ms`);
  error.code = NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE;
  error.reason = NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON;
  error.normalUserStreamFirstTokenTimeout = true;
  error.bypassMainModelFallback = true;
  error.userFacingReply = NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY;
  error.streamHadOutput = false;
  error.timeoutMs = normalizedTimeoutMs;
  return error;
}

function isNormalUserMainReplyStreamFirstTokenTimeout(error) {
  return Boolean(
    error?.normalUserStreamFirstTokenTimeout === true
    || String(error?.code || '').trim() === NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE
    || String(error?.reason || '').trim() === NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON
  );
}

function getNormalUserMainReplyStreamTimeoutReply(error = null) {
  return String(error?.userFacingReply || '').trim() || NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY;
}

module.exports = {
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_CODE,
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REASON,
  NORMAL_USER_MAIN_REPLY_STREAM_FIRST_TOKEN_TIMEOUT_REPLY,
  createNormalUserMainReplyStreamFirstTokenTimeoutError,
  getNormalUserMainReplyStreamTimeoutReply,
  isNormalUserMainReplyStreamFirstTokenTimeout
};
