const path = require('path');
const appConfig = require('../../../config');
const { sendPrivateMessage: defaultSendPrivateMessage } = require('../../../api/qqActionService');
const conversationVariables = require('../../../utils/conversationVariables');
const { parseCompanionRoomMessage } = require('./parser');
const { createCompanionRoomModelClient } = require('./model');
const { createCompanionRoomStateStore } = require('./state');

const PLUGIN_COMMAND_PATTERN = /^\/陪伴插件\s+(开启|关闭|状态|重载)\s*$/u;
const USAGE = '用法：/陪伴 开始 专注|放松 [15|30|45|60|120分钟]，或 /陪伴 开始 共读|共看|共听 <标题> [时长]；可用 /陪伴 进度 <内容> 记录进度。';

function contentLabel(contentType) {
  if (contentType === 'read') return '读';
  if (contentType === 'watch') return '看';
  if (contentType === 'listen') return '听';
  return '';
}

function activityLabel(activityType) {
  return activityType === 'relax' ? '放松' : '专注';
}

function densityLabel(density) {
  if (density === 'quiet') return '安静陪伴';
  if (density === 'chatty') return '多聊几句';
  return '偶尔说话';
}

function selectDensity(snapshot = {}, activityType = 'focus') {
  const character = snapshot.character || {};
  const energy = Number(character.energy ?? 60);
  const stress = Number(character.stress ?? 20);
  const social = Number(character.socialWillingness ?? 60);
  if (energy <= 35 || stress >= 60 || social <= 35) return 'quiet';
  if (activityType === 'relax' && social >= 70) return 'chatty';
  return 'occasional';
}

function formatRoomStatus(room, elapsedMs = 0) {
  if (!room) return '现在没有进行中的共处房间。';
  const elapsedMinutes = Math.max(0, Math.floor(elapsedMs / 60000));
  const status = room.status === 'paused' ? '已暂停' : '进行中';
  const content = room.contentType && room.contentTitle
    ? `，一起${contentLabel(room.contentType)}《${room.contentTitle}》${room.contentProgress ? `，进度：${room.contentProgress}` : ''}`
    : '';
  return `${activityLabel(room.activityType)}房间${status}，已进行约 ${elapsedMinutes}/${room.durationMinutes} 分钟，当前是${densityLabel(room.density)}${content}。`;
}

function formatMemories(memories = []) {
  if (!memories.length) return '还没有共同回忆。';
  return memories.map((memory) => {
    const note = memory.userNote || '这次没有留下成果备注';
    const content = memory.contentType && memory.contentTitle
      ? `｜一起${contentLabel(memory.contentType)}《${memory.contentTitle}》${memory.progress ? `（${memory.progress}）` : ''}`
      : '';
    return `${memory.id}｜${activityLabel(memory.activityType)} ${memory.durationMinutes} 分钟${content}｜你：${note}｜瑞希：${memory.botNote}`;
  }).join('\n');
}

function requireDelivered(result) {
  if (result === false || result?.success === false) throw new Error(result?.reason || 'QQ send failed');
}

function createCompanionRoomRuntime(options = {}) {
  const config = options.config || appConfig;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const stateStore = options.stateStore || createCompanionRoomStateStore(
    config.COMPANION_ROOM_STATE_FILE || path.join(config.DATA_DIR, 'companion-room-state.json'),
    {
      now,
      defaultEnabled: config.COMPANION_ROOM_ENABLED === true
    }
  );
  const getCharacterSnapshot = options.getCharacterSnapshot
    || ((userId) => conversationVariables.getSnapshot({ userId, now: now() }));
  const generateMessage = options.generateMessage || createCompanionRoomModelClient({
    timeoutMs: config.COMPANION_ROOM_MODEL_TIMEOUT_MS,
    requestAssistantMessage: options.requestAssistantMessage
  });
  const sendPrivateMessage = options.sendPrivateMessage || ((userId, text) => defaultSendPrivateMessage(userId, text, {
    actionClient: options.actionClient,
    source: 'companion_room',
    triggerReason: 'companion_room'
  }));
  let running = false;
  let tickPromise = null;

  function elapsedMs(room) {
    if (!room) return 0;
    if (typeof stateStore.elapsedMs === 'function') return stateStore.elapsedMs(room, now());
    if (Number.isFinite(Number(room.elapsedMs))) return Math.max(0, Number(room.elapsedMs));
    return Math.max(0, Number(room.activeElapsedMs || 0) || 0)
      + (room.status === 'active' ? Math.max(0, now() - Number(room.resumedAt || room.startedAt || now())) : 0);
  }

  async function buildCompletion(userId, room) {
    const botNote = await generateMessage({
      phase: 'summary',
      userId,
      room,
      characterState: getCharacterSnapshot(userId)?.character || {}
    });
    return { botNote };
  }

  async function handleStart(userId, parsed) {
    const current = stateStore.getRoom(userId);
    if (current) {
      return {
        handled: true,
        code: 'room_exists',
        replyText: `${formatRoomStatus(current, elapsedMs(current))}先结束当前房间，再开始新的吧。`,
        room: current
      };
    }
    const snapshot = getCharacterSnapshot(userId) || {};
    const density = selectDensity(snapshot, parsed.activityType);
    const room = stateStore.createRoom(userId, {
      activityType: parsed.activityType,
      contentType: parsed.contentType,
      contentTitle: parsed.contentTitle,
      durationMinutes: parsed.durationMinutes || Number(config.COMPANION_ROOM_DEFAULT_DURATION_MINUTES) || 45,
      density
    });
    const content = room.contentType && room.contentTitle
      ? `一起${contentLabel(room.contentType)}《${room.contentTitle}》`
      : `${activityLabel(room.activityType)}房间`;
    return {
      handled: true,
      code: 'started',
      replyText: `好，我们用 ${room.durationMinutes} 分钟${content}。我会${densityLabel(room.density)}，想换节奏随时告诉我。`,
      room
    };
  }

  async function handleParsedAction(userId, parsed) {
    const room = stateStore.getRoom(userId);
    if (parsed.action === 'start') return handleStart(userId, parsed);
    if (parsed.action === 'status') {
      return { handled: true, code: 'status', replyText: formatRoomStatus(room, elapsedMs(room)), room };
    }
    if (parsed.action === 'memory_list') {
      return { handled: true, code: 'memory_list', replyText: formatMemories(stateStore.listMemories(userId)) };
    }
    if (parsed.action === 'memory_delete') {
      const deleted = stateStore.deleteMemory(userId, parsed.memoryId);
      return { handled: true, code: deleted ? 'memory_deleted' : 'memory_not_found', replyText: deleted ? '这条共同回忆已经删除。' : '没有找到这条共同回忆。' };
    }
    if (parsed.action === 'memory_update') {
      const updated = stateStore.updateMemory(userId, parsed.memoryId, parsed.userNote);
      return { handled: true, code: updated ? 'memory_updated' : 'memory_not_found', replyText: updated ? '这条共同回忆已经改好。' : '没有找到这条共同回忆。' };
    }
    if (parsed.action === 'usage') return { handled: true, code: 'usage', replyText: USAGE };
    if (!room) return { handled: true, code: 'room_not_found', replyText: '现在没有进行中的共处房间。' };
    if (parsed.action === 'progress') {
      if (!room.contentType) return { handled: true, code: 'progress_unavailable', replyText: '当前房间没有共读、共看或共听内容。' };
      const updated = stateStore.recordProgress(userId, parsed.progress);
      return { handled: true, code: 'progress_updated', replyText: `记下了：${updated.contentProgress}`, room: updated };
    }
    if (parsed.action === 'pause') {
      if (room.status === 'paused') return { handled: true, code: 'already_paused', replyText: '房间已经暂停着。' };
      const paused = stateStore.pauseRoom(userId, 'user');
      return { handled: true, code: 'paused', replyText: '先暂停在这里，想继续时叫我。', room: paused };
    }
    if (parsed.action === 'resume') {
      if (room.status === 'active') return { handled: true, code: 'already_active', replyText: '房间还在继续，我们慢慢来。' };
      const resumed = stateStore.resumeRoom(userId);
      return { handled: true, code: 'resumed', replyText: '好，我们从刚才停下的地方继续。', room: resumed };
    }
    if (parsed.action === 'density') {
      const updated = stateStore.updateRoom(userId, (current) => { current.density = parsed.density; });
      return { handled: true, code: 'density_updated', replyText: parsed.density === 'quiet' ? '好，我安静一点陪你。' : '好，我会多陪你说几句。', room: updated };
    }
    if (parsed.action === 'switch') {
      const updated = stateStore.updateRoom(userId, (current) => {
        current.activityType = parsed.activityType;
      });
      return {
        handled: true,
        code: 'activity_switched',
        replyText: `好，接下来切换成${activityLabel(parsed.activityType)}。`,
        room: updated
      };
    }
    if (parsed.action === 'end') {
      const result = await buildCompletion(userId, room);
      return {
        handled: true,
        code: 'ended',
        replyText: `这次共处就到这里。${result.botNote}`,
        afterReplySent: () => stateStore.completeRoom(userId, {
          botNote: result.botNote,
          completion: 'ended_early'
        })
      };
    }
    return { handled: false };
  }

  async function handleUserMessage(input = {}) {
    if (String(input.chatType || '').trim().toLowerCase() !== 'private') return { handled: false };
    if (!running || !stateStore.isEnabled()) return { handled: false };
    const userId = String(input.userId || '').trim();
    const parsed = parseCompanionRoomMessage(input.rawText, { chatType: 'private' });
    if (parsed.matched) return handleParsedAction(userId, parsed);
    const room = stateStore.getRoom(userId);
    if (room) {
      if (room.status === 'paused' && room.pauseReason === 'runtime_restart') stateStore.resumeRoom(userId);
      stateStore.recordUserNote(userId, input.rawText);
    }
    return { handled: false };
  }

  async function handleAdminCommand(input = {}) {
    const match = String(input.rawText || '').trim().match(PLUGIN_COMMAND_PATTERN);
    if (!match) return { handled: false };
    if (input.isAdmin !== true) return { handled: true, code: 'admin_required', replyText: '只有管理员可以控制陪伴插件。' };
    const command = match[1];
    if (command === '开启') {
      stateStore.setEnabled(true);
      return { handled: true, code: 'enabled', replyText: '陪伴插件已开启。' };
    }
    if (command === '关闭') {
      for (const room of stateStore.listRooms()) {
        if (room.status === 'active') stateStore.pauseRoom(room.userId, 'plugin_disabled');
      }
      stateStore.setEnabled(false);
      return { handled: true, code: 'disabled', replyText: '陪伴插件已关闭，已有房间状态会保留。' };
    }
    if (command === '重载') {
      stateStore.reload();
      return { handled: true, code: 'reloaded', replyText: '陪伴插件状态已重载。' };
    }
    const status = stateStore.getStatus();
    return {
      handled: true,
      code: 'status',
      replyText: `陪伴插件${status.enabled ? '已开启' : '已关闭'}，进行中 ${status.activeRooms} 个，暂停 ${status.pausedRooms} 个，共同回忆 ${status.memories} 条。`,
      status
    };
  }

  async function runTick() {
    if (!running || !stateStore.isEnabled()) return { scanned: 0, sent: 0, completed: 0 };
    let sent = 0;
    let completed = 0;
    const rooms = stateStore.listRooms();
    for (const room of rooms) {
      if (room.status !== 'active') continue;
      const elapsed = elapsedMs(room);
      if (elapsed >= room.durationMs) {
        const result = await buildCompletion(room.userId, room);
        if (!running) break;
        requireDelivered(await sendPrivateMessage(room.userId, `约好的时间到了。${result.botNote}`));
        stateStore.completeRoom(room.userId, { botNote: result.botNote, completion: 'completed' });
        sent += 1;
        completed += 1;
        continue;
      }
      let phase = '';
      if (elapsed >= room.durationMs * 0.85 && !room.sentNodes.includes('closing')) phase = 'closing';
      else if (elapsed >= room.durationMs * 0.5 && elapsed < room.durationMs * 0.85 && !room.sentNodes.includes('midpoint')) phase = 'midpoint';
      if (room.density === 'quiet' && phase === 'midpoint') continue;
      if (!phase) continue;
      const text = await generateMessage({
        phase,
        userId: room.userId,
        room,
        characterState: getCharacterSnapshot(room.userId)?.character || {}
      });
      if (!running) break;
      requireDelivered(await sendPrivateMessage(room.userId, text));
      stateStore.markNodeSent(room.userId, phase);
      sent += 1;
    }
    return { scanned: rooms.length, sent, completed };
  }

  function tick() {
    if (!tickPromise) {
      tickPromise = runTick().finally(() => { tickPromise = null; });
    }
    return tickPromise;
  }

  function pauseActiveRooms() {
    for (const room of stateStore.listRooms()) {
      if (room.status === 'active') stateStore.pauseRoom(room.userId, 'runtime_restart');
    }
    stateStore.flush();
  }

  return {
    getStatus: () => ({ ...stateStore.getStatus(), running }),
    handleAdminCommand,
    handleUserMessage,
    reload: () => stateStore.reload(),
    start() { running = true; return true; },
    stop() {
      running = false;
      if (!tickPromise) {
        pauseActiveRooms();
        return undefined;
      }
      return tickPromise.catch(() => {}).then(pauseActiveRooms);
    },
    tick
  };
}

module.exports = {
  PLUGIN_COMMAND_PATTERN,
  createCompanionRoomRuntime,
  formatMemories,
  formatRoomStatus,
  selectDensity
};
