async function sendNapCatActionWithRetry(options = {}) {
  const actionClient = options.actionClient;
  const payload = options.payload || {};
  const logger = options.logger || console;
  const maxRetry = Math.max(0, Number(options.retries) || 0);
  const waitMs = Math.max(0, Number(options.waitMs) || 0);

  for (let attempt = 0; attempt <= maxRetry; attempt += 1) {
    try {
      await actionClient.callAction(payload.action, payload.params);
      return true;
    } catch (error) {
      logger.error(
        `[HTTP action] ${payload.action} failed (attempt ${attempt + 1}/${maxRetry + 1}):`,
        error?.message || error
      );
      if (attempt >= maxRetry || error?.retryable !== true) return false;
      if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }

  return false;
}

module.exports = { sendNapCatActionWithRetry };
