const fs = require('fs');
const path = require('path');
const config = require('../config');
const { isAtBot } = require('./router');
const { buildInboundMessageContext } = require('./messageIngress');
const { forcePassiveGroupInterjection } = require('./passiveGroupAwareness');

function normalizeText(value = '') {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function safeJsonParse(text = '') {
  try {
    return JSON.parse(String(text || ''));
  } catch (_) {
    return null;
  }
}

function normalizeNameSet(values = []) {
  return new Set(
    (Array.isArray(values) ? values : [])
      .map((item) => normalizeText(item).toLowerCase())
      .filter(Boolean)
  );
}

function parseList(raw = '') {
  return String(raw || '')
    .split(',')
    .map((item) => normalizeText(item))
    .filter(Boolean);
}

function buildAdminSets() {
  return {
    adminUserIds: new Set((config.ADMIN_USER_IDS || []).map((item) => String(item || '').trim()).filter(Boolean)),
    adminNames: normalizeNameSet(config.FOLLOWER_ADMIN_NAMES || [])
  };
}

function resolveMessageText(packet = {}) {
  return String(
    packet.raw_message
      || packet.rawMessage
      || packet.message
      || packet.text
      || ''
  );
}

function resolveSenderName(packet = {}) {
  return normalizeText(
    packet.sender?.card
      || packet.sender?.nickname
      || packet.sender?.nick
      || packet.sender_name
      || packet.nickname
      || ''
  );
}

function normalizeIncomingPacket(packet = {}) {
  const raw = packet && typeof packet === 'object' ? packet : {};
  const messageType = normalizeText(raw.message_type || raw.messageType).toLowerCase();
  const postType = normalizeText(raw.post_type || raw.postType).toLowerCase();
  const groupId = String(raw.group_id || raw.groupId || '').trim();
  const userId = String(raw.user_id || raw.userId || '').trim();
  const senderName = resolveSenderName(raw);
  const rawText = resolveMessageText(raw);

  return {
    ...raw,
    post_type: postType || 'message',
    message_type: messageType || (groupId ? 'group' : ''),
    group_id: groupId,
    user_id: userId,
    raw_message: rawText,
    sender: raw.sender && typeof raw.sender === 'object'
      ? raw.sender
      : {
        card: senderName,
        nickname: senderName,
        nick: senderName
      }
  };
}

function parsePacketFromLine(line = '') {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;

  const direct = safeJsonParse(trimmed);
  if (direct && typeof direct === 'object') return normalizeIncomingPacket(direct);

  const braceIndex = trimmed.indexOf('{');
  if (braceIndex >= 0) {
    const maybeJson = safeJsonParse(trimmed.slice(braceIndex));
    if (maybeJson && typeof maybeJson === 'object') {
      return normalizeIncomingPacket(maybeJson);
    }
  }

  return null;
}

function createLineReader(onLine) {
  let buffer = '';
  return {
    push(chunk) {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
      const parts = buffer.split(/\r?\n/);
      buffer = parts.pop() || '';
      for (const line of parts) {
        onLine(line);
      }
    },
    flush() {
      const tail = buffer.trim();
      buffer = '';
      if (tail) onLine(tail);
    }
  };
}

function appendNapcatPacketToLog(packet = {}, options = {}) {
  const targetPath = String(options.logPath || config.FOLLOWER_NAPCAT_LOG_PATH || '').trim();
  if (!targetPath) return;

  const normalized = normalizeIncomingPacket(packet);
  if (String(normalized.post_type || '').trim().toLowerCase() !== 'message') return;

  try {
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(targetPath, `${JSON.stringify(normalized)}\n`, 'utf8');
  } catch (_) {}
}

function createNapcatLogFollower({
  sendWithRetry,
  sendGroupReply
} = {}) {
  const state = {
    started: false,
    watcher: null,
    pollTimer: null,
    readStream: null,
    filePosition: 0,
    lineReader: null,
    recentMessageIds: new Map()
  };

  function log(...args) {
    console.log('[napcat-follower]', ...args);
  }

  function clearRecentMessageIds() {
    const now = Date.now();
    for (const [messageId, timestamp] of state.recentMessageIds.entries()) {
      if ((now - timestamp) > 10 * 60 * 1000) {
        state.recentMessageIds.delete(messageId);
      }
    }
  }

  function shouldHandlePacket(packet = {}) {
    const { adminUserIds, adminNames } = buildAdminSets();
    const groupId = String(packet.group_id || '').trim();
    const userId = String(packet.user_id || '').trim();
    const senderName = resolveSenderName(packet);
    const rawText = String(packet.raw_message || '').trim();
    const messageId = String(packet.message_id || '').trim();
    const effectiveBotQQ = String(packet.self_id || config.BOT_QQ || '').trim();

    if (!config.FOLLOWER_RULE_ENABLED) return false;
    if (!config.FOLLOWER_LOG_MONITOR_ENABLED) return false;
    if (String(packet.post_type || '').trim().toLowerCase() !== 'message') return false;
    if (String(packet.message_type || '').trim().toLowerCase() !== 'group') return false;
    if (!groupId || !userId || !rawText) return false;
    if (effectiveBotQQ && String(packet.user_id || '').trim() === effectiveBotQQ) return false;
    if (isAtBot(rawText, effectiveBotQQ)) return false;

    if (messageId) {
      clearRecentMessageIds();
      if (state.recentMessageIds.has(messageId)) return false;
    }

    const byUserId = adminUserIds.has(userId);
    const byName = senderName && adminNames.has(senderName.toLowerCase());
    return byUserId || byName;
  }

  async function handlePacket(packet = {}) {
    if (!shouldHandlePacket(packet)) return;

    const messageId = String(packet.message_id || '').trim();
    if (messageId) {
      state.recentMessageIds.set(messageId, Date.now());
    }

    const effectiveBotQQ = String(packet.self_id || config.BOT_QQ || '').trim();
    const rawText = String(packet.raw_message || '');
    const cleanText = rawText
      .replace(/\[CQ:reply,[^\]]*\]\s*/ig, '')
      .replace(new RegExp(`\\[CQ:at,qq=${String(effectiveBotQQ || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]`, 'ig'), '')
      .trim();
    const inboundContext = buildInboundMessageContext({
      msg: packet,
      effectiveMsg: packet,
      rawText,
      cleanText,
      imageUrl: null,
      isAtBot: false,
      botQQ: effectiveBotQQ
    });
    const result = await forcePassiveGroupInterjection({
      msg: packet,
      inboundContext,
      sendGroupReply,
      reason: 'napcat-log-follower',
      forceAtSender: Boolean(config.FOLLOWER_AT_SENDER)
    });

    if (result?.handled) {
      log('forced passive interjection sent', {
        groupId: packet.group_id,
        userId: packet.user_id,
        messageId,
        replyText: String(result.replyText || '').slice(0, 80)
      });
      return;
    }

    log('forced passive interjection skipped', {
      groupId: packet.group_id,
      userId: packet.user_id,
      messageId,
      reason: result?.reason || 'unknown'
    });
  }

  function handleLine(line = '') {
    const packet = parsePacketFromLine(line);
    if (!packet) return;
    void handlePacket(packet).catch((error) => {
      log('handle line failed', error?.message || error);
    });
  }

  function closeReader() {
    if (state.readStream) {
      try {
        state.readStream.close();
      } catch (_) {}
      state.readStream = null;
    }
  }

  function startReadingFrom(position) {
    const targetPath = String(config.FOLLOWER_NAPCAT_LOG_PATH || '').trim();
    if (!targetPath || !fs.existsSync(targetPath)) return;

    closeReader();
    state.lineReader = createLineReader(handleLine);
    state.readStream = fs.createReadStream(targetPath, {
      encoding: 'utf8',
      start: Math.max(0, Number(position) || 0)
    });
    state.readStream.on('data', (chunk) => {
      state.lineReader.push(chunk);
    });
    state.readStream.on('end', () => {
      if (state.lineReader) state.lineReader.flush();
      state.readStream = null;
    });
    state.readStream.on('error', (error) => {
      log('read stream failed', error?.message || error);
      state.readStream = null;
    });
  }

  function syncFileTail() {
    const targetPath = String(config.FOLLOWER_NAPCAT_LOG_PATH || '').trim();
    if (!targetPath || !fs.existsSync(targetPath)) return;

    let stats = null;
    try {
      stats = fs.statSync(targetPath);
    } catch (error) {
      log('stat failed', error?.message || error);
      return;
    }

    const size = Number(stats?.size || 0) || 0;
    if (size < state.filePosition) {
      state.filePosition = 0;
    }
    if (size === state.filePosition) return;

    const nextPosition = state.filePosition;
    state.filePosition = size;
    startReadingFrom(nextPosition);
  }

  function ensureWatcher() {
    const targetPath = String(config.FOLLOWER_NAPCAT_LOG_PATH || '').trim();
    if (!targetPath) return;
    const dir = path.dirname(targetPath);
    if (!fs.existsSync(dir)) {
      log('log directory missing', { dir });
      return;
    }

    if (!state.watcher) {
      try {
        state.watcher = fs.watch(dir, () => {
          syncFileTail();
        });
      } catch (error) {
        log('watch failed, fallback to poll only', error?.message || error);
      }
    }

    if (!state.pollTimer) {
      state.pollTimer = setInterval(syncFileTail, Math.max(500, Number(config.FOLLOWER_LOG_POLL_MS || 1000) || 1000));
      if (typeof state.pollTimer.unref === 'function') state.pollTimer.unref();
    }
  }

  function start() {
    if (state.started) return;
    state.started = true;

    if (!config.FOLLOWER_RULE_ENABLED || !config.FOLLOWER_LOG_MONITOR_ENABLED) {
      log('disabled');
      return;
    }

    const targetPath = String(config.FOLLOWER_NAPCAT_LOG_PATH || '').trim();
    if (!targetPath) {
      log('missing log path');
      return;
    }

    try {
      if (fs.existsSync(targetPath)) {
        const stats = fs.statSync(targetPath);
        state.filePosition = Math.max(0, Number(stats?.size || 0) || 0);
      }
    } catch (error) {
      log('initial stat failed', error?.message || error);
    }

    ensureWatcher();
    log('started', {
      logPath: targetPath
    });
  }

  function stop() {
    if (state.watcher) {
      try {
        state.watcher.close();
      } catch (_) {}
      state.watcher = null;
    }
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    closeReader();
    state.started = false;
  }

  return {
    start,
    stop,
    handlePacketFromLog: handlePacket
  };
}

module.exports = {
  appendNapcatPacketToLog,
  createNapcatLogFollower,
  parsePacketFromLine
};
