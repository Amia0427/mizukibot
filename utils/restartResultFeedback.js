const fs = require('fs');
const path = require('path');

const RESULT_FILE = path.join(__dirname, '..', 'data', 'restart-bot-result.json');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function readJsonFile(filePath = RESULT_FILE) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw.trim()) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function writeJsonFile(filePath = RESULT_FILE, value = {}) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
    return true;
  } catch (_) {
    return false;
  }
}

function isFreshRestartResult(result = {}, now = Date.now(), maxAgeMs = 10 * 60 * 1000) {
  if (!result || typeof result !== 'object') return false;
  if (normalizeText(result.consumedAt)) return false;
  const recordedAtMs = Date.parse(normalizeText(result.recordedAt));
  if (!Number.isFinite(recordedAtMs)) return false;
  return Math.abs(now - recordedAtMs) <= maxAgeMs;
}

function shouldSendFeedback(result = {}) {
  if (!isFreshRestartResult(result)) return false;
  if (normalizeText(result.source) !== 'admin_chat_command') return false;
  return Boolean(normalizeText(result.groupId) || normalizeText(result.requestedBy));
}

function buildRestartFeedbackMessage(result = {}) {
  const ok = result.healthy === true && normalizeText(result.status) === 'success';
  const mainPid = normalizeText(result.mainPid);
  const workerPid = normalizeText(result.workerPid);
  const head = ok ? '重启完成。' : '重启执行了，但最终健康检查没过。';
  const lines = [head];
  if (mainPid) lines.push(`main bot PID=${mainPid}`);
  if (workerPid) lines.push(`post-reply worker PID=${workerPid}`);
  const message = normalizeText(result.message);
  if (!ok && message) lines.push(message);
  return lines.join('\n');
}

async function maybeSendRestartResultFeedback(options = {}) {
  const resultFile = options.resultFile || RESULT_FILE;
  const result = readJsonFile(resultFile);
  if (!shouldSendFeedback(result)) {
    return { sent: false, reason: 'not_applicable' };
  }

  const sendGroupMessage = options.sendGroupMessage;
  const sendPrivateMessage = options.sendPrivateMessage;
  const message = buildRestartFeedbackMessage(result);
  try {
    if (normalizeText(result.groupId) && typeof sendGroupMessage === 'function') {
      await sendGroupMessage(result.groupId, message, options);
    } else if (normalizeText(result.requestedBy) && typeof sendPrivateMessage === 'function') {
      await sendPrivateMessage(result.requestedBy, message, options);
    } else {
      return { sent: false, reason: 'sender_unavailable' };
    }

    writeJsonFile(resultFile, {
      ...result,
      consumedAt: new Date().toISOString(),
      feedbackSent: true
    });
    return { sent: true, reason: 'sent' };
  } catch (error) {
    writeJsonFile(resultFile, {
      ...result,
      feedbackErrorAt: new Date().toISOString(),
      feedbackError: error?.message || String(error || '')
    });
    return { sent: false, reason: 'send_failed' };
  }
}

module.exports = {
  buildRestartFeedbackMessage,
  isFreshRestartResult,
  maybeSendRestartResultFeedback,
  shouldSendFeedback
};
