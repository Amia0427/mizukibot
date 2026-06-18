const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  buildRestartFeedbackMessage,
  maybeSendRestartResultFeedback,
  shouldSendFeedback
} = require('../utils/restartResultFeedback');

module.exports = (async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-restart-feedback-'));
  const resultFile = path.join(tempRoot, 'restart-bot-result.json');

  try {
    const remoteResult = {
      schemaVersion: 'restart_bot_result_v1',
      status: 'success',
      healthy: true,
      recordedAt: new Date().toISOString(),
      source: 'admin_chat_command',
      groupId: '10001',
      requestedBy: '20002',
      mainPid: 1234,
      workerPid: 5678,
      message: 'restart completed'
    };

    assert.strictEqual(shouldSendFeedback(remoteResult), true);
    assert.ok(buildRestartFeedbackMessage(remoteResult).includes('重启完成。'));
    fs.writeFileSync(resultFile, JSON.stringify(remoteResult), 'utf8');

    const sent = [];
    const result = await maybeSendRestartResultFeedback({
      resultFile,
      sendGroupMessage: async (groupId, message) => {
        sent.push({ groupId, message });
      }
    });

    assert.strictEqual(result.sent, true);
    assert.strictEqual(sent.length, 1);
    assert.strictEqual(sent[0].groupId, '10001');
    assert.ok(sent[0].message.includes('main bot PID=1234'));
    assert.ok(JSON.parse(fs.readFileSync(resultFile, 'utf8')).consumedAt);

    const manualResult = {
      ...remoteResult,
      source: 'restart-bot.cmd',
      consumedAt: ''
    };
    assert.strictEqual(shouldSendFeedback(manualResult), false);

    console.log('restartResultFeedback.test.js passed');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
