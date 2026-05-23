function normalizeErrorText(jobOrError = {}) {
  if (typeof jobOrError === 'string') return jobOrError;
  if (jobOrError instanceof Error) return jobOrError.message || String(jobOrError);
  return String(jobOrError?.lastError || jobOrError?.error || jobOrError?.message || '');
}

function classifyPostReplyJobError(jobOrError = {}) {
  const error = normalizeErrorText(jobOrError).toLowerCase();
  if (!error) return 'no_error';
  if (/(canceled|cancelled|cancel requested|skipped:circuit_open)/.test(error)) return 'canceled';
  if (/(schema|invalid job|parse job|job shape|schema_version)/.test(error)) return 'schema';
  if (/(quality_gate|quality gate|low confidence|drop reason)/.test(error)) return 'quality_gate';
  if (/(401|403|404|forbidden|unauthorized|not found|model not supported|unsupported model)/.test(error)) {
    return 'terminal';
  }
  if (/(429|rate limit|too many requests|408|425|500|502|503|504|timeout|timed out|temporarily unavailable|econnreset|etimedout|network)/.test(error)) {
    return 'transient';
  }
  return 'unknown_error';
}

function isPostReplyErrorClass(errorClass = '', expected = '') {
  return String(errorClass || '').trim() === String(expected || '').trim();
}

function isTransientPostReplyError(jobOrError = {}) {
  return isPostReplyErrorClass(classifyPostReplyJobError(jobOrError), 'transient');
}

function isTerminalPostReplyError(jobOrError = {}) {
  return isPostReplyErrorClass(classifyPostReplyJobError(jobOrError), 'terminal');
}

function isRequeueSafePostReplyError(jobOrError = {}) {
  return isTransientPostReplyError(jobOrError);
}

module.exports = {
  classifyPostReplyJobError,
  isPostReplyErrorClass,
  isRequeueSafePostReplyError,
  isTerminalPostReplyError,
  isTransientPostReplyError,
  normalizeErrorText
};
