const assert = require('assert');

const { createCompanionRoomRuntime } = require('../src/features/companion-room/runtime');

function createMemoryStore() {
  let enabled = false;
  const rooms = new Map();
  const memories = new Map();
  let sequence = 0;
  return {
    isEnabled: () => enabled,
    setEnabled(value) { enabled = value; return enabled; },
    reload() {},
    flush() {},
    getStatus: () => ({ enabled, activeRooms: [...rooms.values()].filter((room) => room.status === 'active').length, pausedRooms: [...rooms.values()].filter((room) => room.status === 'paused').length, memories: [...memories.values()].reduce((sum, list) => sum + list.length, 0), loadError: '' }),
    getRoom: (userId) => rooms.get(userId) ? { ...rooms.get(userId) } : null,
    listRooms: () => [...rooms.entries()].map(([userId, room]) => ({ userId, ...room })),
    createRoom(userId, input) {
      if (rooms.has(userId)) return { code: 'room_exists', ...rooms.get(userId) };
      const room = { id: `room-${++sequence}`, status: 'active', startedAt: 0, resumedAt: 0, activeElapsedMs: 0, totalPausedMs: 0, pausedAt: 0, pauseReason: '', activityType: input.activityType, durationMinutes: input.durationMinutes, durationMs: input.durationMinutes * 60000, density: input.density, sentNodes: [], lastUserNote: '' };
      rooms.set(userId, room);
      return { ...room };
    },
    updateRoom(userId, mutate) { const room = rooms.get(userId); if (!room) return null; mutate(room); return { ...room }; },
    pauseRoom(userId) { return this.updateRoom(userId, (room) => { room.status = 'paused'; room.activeElapsedMs = room.elapsedMs || room.activeElapsedMs; room.pausedAt = 1; }); },
    resumeRoom(userId) { return this.updateRoom(userId, (room) => { room.status = 'active'; room.pausedAt = 0; }); },
    recordUserNote(userId, note) { return this.updateRoom(userId, (room) => { room.lastUserNote = note; }); },
    markNodeSent(userId, node) { return this.updateRoom(userId, (room) => { room.sentNodes.push(node); }); },
    completeRoom(userId, input) { const room = rooms.get(userId); rooms.delete(userId); const memory = { id: room.id, activityType: room.activityType, durationMinutes: room.durationMinutes, userNote: input.userNote || room.lastUserNote, botNote: input.botNote, completion: input.completion }; memories.set(userId, [memory, ...(memories.get(userId) || [])]); return memory; },
    listMemories: (userId) => memories.get(userId) || [],
    deleteMemory(userId, id) { const list = memories.get(userId) || []; memories.set(userId, list.filter((item) => item.id !== id)); return list.length !== memories.get(userId).length; },
    updateMemory(userId, id, note) { const memory = (memories.get(userId) || []).find((item) => item.id === id); if (!memory) return null; memory.userNote = note; return memory; }
  };
}

module.exports = (async () => {
  const store = createMemoryStore();
  const sent = [];
  const phases = [];
  const runtime = createCompanionRoomRuntime({
    config: { COMPANION_ROOM_ENABLED: false, COMPANION_ROOM_DEFAULT_DURATION_MINUTES: 60 },
    stateStore: store,
    getCharacterSnapshot: () => ({ character: { energy: 25, stress: 70, socialWillingness: 20 } }),
    generateMessage: async ({ phase }) => { phases.push(phase); return phase === 'summary' ? '今天这段时间，我也安静地陪完啦。' : `节点：${phase}`; },
    sendPrivateMessage: async (userId, text) => { sent.push({ userId, text }); }
  });

  runtime.start();
  assert.strictEqual((await runtime.handleUserMessage({ chatType: 'private', userId: 'user-1', rawText: '陪我学习半小时' })).handled, false);
  assert.strictEqual((await runtime.handleAdminCommand({ chatType: 'private', userId: 'admin', rawText: '/陪伴插件 开启', isAdmin: false })).code, 'admin_required');
  assert.strictEqual((await runtime.handleAdminCommand({ chatType: 'private', userId: 'admin', rawText: '/陪伴插件 开启', isAdmin: true })).code, 'enabled');

  const started = await runtime.handleUserMessage({ chatType: 'private', userId: 'user-1', rawText: '陪我学习半小时' });
  assert.strictEqual(started.handled, true);
  assert.strictEqual(started.room.density, 'quiet');
  assert.match(started.replyText, /30 分钟/);

  const defaultDuration = await runtime.handleUserMessage({ chatType: 'private', userId: 'default-duration', rawText: '陪我放松一下' });
  assert.strictEqual(defaultDuration.room.durationMinutes, 60);

  const densityChanged = await runtime.handleUserMessage({ chatType: 'private', userId: 'user-1', rawText: '多陪我聊聊' });
  assert.strictEqual(densityChanged.code, 'density_updated');

  const switched = await runtime.handleUserMessage({ chatType: 'private', userId: 'user-1', rawText: '切换到放松' });
  assert.strictEqual(switched.code, 'activity_switched');
  assert.strictEqual(store.getRoom('user-1').activityType, 'relax');

  const storeRoom = store.getRoom('user-1');
  store.updateRoom('user-1', (room) => { room.elapsedMs = room.durationMs * 0.5; });
  await runtime.tick();
  assert.deepStrictEqual(phases, ['midpoint']);
  assert.strictEqual(sent.length, 1);
  await runtime.tick();
  assert.strictEqual(sent.length, 1, 'same node must not be sent twice');

  store.updateRoom('user-1', (room) => { room.elapsedMs = room.durationMs * 0.86; });
  await runtime.tick();
  assert.strictEqual(sent.length, 2);
  store.updateRoom('user-1', (room) => { room.elapsedMs = room.durationMs; });
  await runtime.tick();
  assert.strictEqual(sent.length, 3);
  assert.strictEqual(store.listMemories('user-1').length, 1);

  const reloadStart = await runtime.handleUserMessage({ chatType: 'private', userId: 'user-2', rawText: '/陪伴 开始 放松 15分钟' });
  assert.strictEqual(reloadStart.handled, true);
  store.updateRoom('user-2', (room) => {
    room.status = 'paused';
    room.pauseReason = 'runtime_restart';
  });
  const resumedByMessage = await runtime.handleUserMessage({ chatType: 'private', userId: 'user-2', rawText: '我回来了' });
  assert.strictEqual(resumedByMessage.handled, false);
  assert.strictEqual(store.getRoom('user-2').status, 'active');
  assert.strictEqual(store.getRoom('user-2').lastUserNote, '我回来了');
  const reloaded = await runtime.handleAdminCommand({ chatType: 'private', userId: 'admin', rawText: '/陪伴插件 重载', isAdmin: true });
  assert.strictEqual(reloaded.code, 'reloaded');
  runtime.stop();
  assert.strictEqual(runtime.getStatus().running, false);
  assert.strictEqual(store.getRoom('user-2').status, 'paused');
  assert.strictEqual(storeRoom.activityType, 'relax');

  const failingStore = createMemoryStore();
  const failingRuntime = createCompanionRoomRuntime({
    config: { COMPANION_ROOM_ENABLED: false },
    stateStore: failingStore,
    getCharacterSnapshot: () => ({ character: {} }),
    generateMessage: async () => '结束小结',
    sendPrivateMessage: async () => { throw new Error('QQ send failed'); }
  });
  failingRuntime.start();
  await failingRuntime.handleAdminCommand({ chatType: 'private', userId: 'admin', rawText: '/陪伴插件 开启', isAdmin: true });
  await failingRuntime.handleUserMessage({ chatType: 'private', userId: 'send-failure', rawText: '/陪伴 开始 专注 15分钟' });
  failingStore.updateRoom('send-failure', (room) => { room.elapsedMs = room.durationMs; });
  await assert.rejects(() => failingRuntime.tick(), /QQ send failed/);
  assert.ok(failingStore.getRoom('send-failure'), 'send failure must keep the room for retry');
  assert.strictEqual(failingStore.listMemories('send-failure').length, 0);
  failingRuntime.stop();

  const rejectedStore = createMemoryStore();
  const rejectedRuntime = createCompanionRoomRuntime({
    config: { COMPANION_ROOM_ENABLED: false },
    stateStore: rejectedStore,
    getCharacterSnapshot: () => ({ character: {} }),
    generateMessage: async () => '节点消息',
    sendPrivateMessage: async () => ({ success: false, reason: 'not delivered' })
  });
  rejectedRuntime.start();
  await rejectedRuntime.handleAdminCommand({ chatType: 'private', userId: 'admin', rawText: '/陪伴插件 开启', isAdmin: true });
  await rejectedRuntime.handleUserMessage({ chatType: 'private', userId: 'rejected', rawText: '/陪伴 开始 专注 15分钟' });
  rejectedStore.updateRoom('rejected', (room) => { room.elapsedMs = room.durationMs * 0.5; });
  await assert.rejects(() => rejectedRuntime.tick(), /not delivered/);
  assert.deepStrictEqual(rejectedStore.getRoom('rejected').sentNodes, []);
  rejectedRuntime.stop();

  console.log('companionRoomRuntime.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
