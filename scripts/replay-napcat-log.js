const fs = require('fs');
const path = require('path');
const config = require('../config');
const { createMessageHandler } = require('../core/messageHandler');
const { createNapcatLogFollower, parsePacketFromLine } = require('../core/napcatLogFollower');
const { appendPerfEvent, appendResourceSnapshot, flushPerfLogsSync, getResourcePressureState } = require('../utils/perfRuntime');

async function main() {
  const inputPath = String(process.argv[2] || config.FOLLOWER_NAPCAT_LOG_PATH || '').trim();
  if (!inputPath) {
    throw new Error('usage: node scripts/replay-napcat-log.js <path-to-jsonl>');
  }
  if (!fs.existsSync(inputPath)) {
    throw new Error(`input file not found: ${inputPath}`);
  }

  const sentPayloads = [];
  const sendWithRetry = async (payload) => {
    sentPayloads.push(payload);
    return true;
  };

  const { handleIncomingMessage } = createMessageHandler({
    config,
    sendWithRetry
  });
  const follower = createNapcatLogFollower({
    sendWithRetry,
    sendGroupReply: async (payload) => {
      sentPayloads.push({
        action: 'follower_reply',
        payload
      });
      return true;
    }
  });

  const startedAt = Date.now();
  const lines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/).filter(Boolean);
  let replayed = 0;
  const latencyStats = [];
  let deferredBackgroundCount = 0;
  for (const line of lines) {
    const packet = parsePacketFromLine(line);
    if (!packet) continue;
    replayed += 1;
    const itemStartedAt = Date.now();
    appendPerfEvent({
      category: 'replay',
      type: 'replay_message_start',
      messageId: String(packet.message_id || '').trim()
    });
    await follower.handleLivePacket(packet);
    await handleIncomingMessage(packet);
    if (getResourcePressureState().level !== 'normal') deferredBackgroundCount += 1;
    latencyStats.push(Math.max(0, Date.now() - itemStartedAt));
  }

  const sortedLatency = latencyStats.slice().sort((a, b) => a - b);
  const p50 = sortedLatency.length ? sortedLatency[Math.floor(sortedLatency.length * 0.5)] : 0;
  const p95 = sortedLatency.length ? sortedLatency[Math.floor(sortedLatency.length * 0.95)] : 0;

  appendResourceSnapshot({
    component: 'replay_script',
    replayed,
    sentPayloads: sentPayloads.length,
    inputPath: path.resolve(inputPath)
  });
  flushPerfLogsSync();

  console.log(JSON.stringify({
    ok: true,
    inputPath: path.resolve(inputPath),
    replayed,
    sentPayloads: sentPayloads.length,
    durationMs: Math.max(0, Date.now() - startedAt),
    latencyP50Ms: p50,
    latencyP95Ms: p95,
    deferredBackgroundCount,
    bufferedWriterFlushCount: 0,
    pressureLevel: getResourcePressureState().level,
    pressureReasons: getResourcePressureState().reasons
  }, null, 2));
}

main().catch((error) => {
  console.error(error?.stack || error?.message || String(error));
  process.exit(1);
});
