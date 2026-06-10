function createModelCallLogWriter(deps = {}) {
  const {
    appendFileWithRotationBatched,
    flushBatchedLogWritesSync,
    modelCallLogFile
  } = deps;

  function appendModelCallLog(record = {}) {
    try {
      appendFileWithRotationBatched(modelCallLogFile, `${JSON.stringify(record)}\n`, {
        encoding: 'utf8'
      });
    } catch (_) {}
  }

  function flushModelCallLogsSync() {
    try {
      return flushBatchedLogWritesSync(modelCallLogFile);
    } catch (_) {
      return false;
    }
  }

  return {
    appendModelCallLog,
    flushModelCallLogsSync
  };
}

module.exports = {
  createModelCallLogWriter
};
