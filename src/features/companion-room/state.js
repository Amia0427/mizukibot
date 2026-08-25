const fs = require('fs');
const { createJsonHotStore } = require('../../../utils/jsonHotStore');

const STATE_VERSION = 2;
const MAX_MEMORIES_PER_USER = 100;
const CONTENT_TYPES = new Set(['read', 'watch', 'listen']);

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function defaultState(defaultEnabled = false) {
  return {
    version: STATE_VERSION,
    enabled: defaultEnabled === true,
    rooms: {},
    memories: {},
    runtime: { loadError: '', updatedAt: 0 }
  };
}

function normalizeRoom(value = {}, now = Date.now(), restoreActive = false) {
  const startedAt = Number(value.startedAt || now) || now;
  const durationMinutes = [15, 30, 45, 60, 120].includes(Number(value.durationMinutes))
    ? Number(value.durationMinutes)
    : 45;
  const status = value.status === 'paused' || (restoreActive && value.status === 'active') ? 'paused' : 'active';
  const activeElapsedMs = Math.max(0, Number(value.activeElapsedMs || 0) || 0)
    + (restoreActive && value.status === 'active' ? Math.max(0, now - Number(value.resumedAt || startedAt)) : 0);
  const durationMs = durationMinutes * 60 * 1000;
  const sentNodes = [...new Set((Array.isArray(value.sentNodes) ? value.sentNodes : []).filter((node) => ['midpoint', 'closing'].includes(node)))];
  if (restoreActive && value.status === 'active') {
    if (activeElapsedMs >= durationMs * 0.5 && !sentNodes.includes('midpoint')) sentNodes.push('midpoint');
    if (activeElapsedMs >= durationMs * 0.85 && !sentNodes.includes('closing')) sentNodes.push('closing');
  }
  return {
    id: String(value.id || `room-${startedAt}`).trim(),
    activityType: value.activityType === 'relax' ? 'relax' : 'focus',
    contentType: CONTENT_TYPES.has(value.contentType) ? value.contentType : '',
    contentTitle: String(value.contentTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    contentProgress: String(value.contentProgress || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    durationMinutes,
    durationMs,
    density: ['quiet', 'occasional', 'chatty'].includes(value.density) ? value.density : 'occasional',
    status,
    startedAt,
    resumedAt: status === 'active' ? Number(value.resumedAt || startedAt) || startedAt : 0,
    activeElapsedMs,
    pausedAt: status === 'paused' ? Number(value.pausedAt || now) || now : 0,
    totalPausedMs: Math.max(0, Number(value.totalPausedMs || 0) || 0),
    pauseReason: restoreActive && value.status === 'active' ? 'runtime_restart' : String(value.pauseReason || '').trim(),
    sentNodes,
    lastUserNote: String(value.lastUserNote || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  };
}

function normalizeMemory(value = {}) {
  return {
    id: String(value.id || '').trim(),
    activityType: value.activityType === 'relax' ? 'relax' : 'focus',
    contentType: CONTENT_TYPES.has(value.contentType) ? value.contentType : '',
    contentTitle: String(value.contentTitle || '').replace(/\s+/g, ' ').trim().slice(0, 120),
    progress: String(value.progress || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    startedAt: Number(value.startedAt || 0) || 0,
    endedAt: Number(value.endedAt || 0) || 0,
    durationMinutes: Math.max(0, Number(value.durationMinutes || 0) || 0),
    userNote: String(value.userNote || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    botNote: String(value.botNote || '').replace(/\s+/g, ' ').trim().slice(0, 200),
    completion: value.completion === 'completed' ? 'completed' : 'ended_early'
  };
}

function normalizeState(value = {}, options = {}) {
  const now = Number(options.now || Date.now()) || Date.now();
  const normalized = defaultState(options.defaultEnabled);
  normalized.enabled = typeof value.enabled === 'boolean' ? value.enabled : normalized.enabled;
  for (const [userId, room] of Object.entries(value.rooms || {})) {
    if (String(userId || '').trim()) normalized.rooms[userId] = normalizeRoom(room, now, options.restoreActive === true);
  }
  for (const [userId, memories] of Object.entries(value.memories || {})) {
    if (!String(userId || '').trim() || !Array.isArray(memories)) continue;
    normalized.memories[userId] = memories.map(normalizeMemory).filter((item) => item.id).slice(0, MAX_MEMORIES_PER_USER);
  }
  normalized.runtime = {
    loadError: String(value.runtime?.loadError || '').trim(),
    updatedAt: Number(value.runtime?.updatedAt || 0) || 0
  };
  return normalized;
}

function createCompanionRoomStateStore(filePath, options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const defaultEnabled = options.defaultEnabled === true;
  let loadError = '';
  if (fs.existsSync(filePath)) {
    try {
      JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      loadError = 'invalid_state_file';
    }
  }
  const hotStore = options.hotStore || createJsonHotStore(filePath, {
    fallback: () => defaultState(defaultEnabled),
    deserialize(raw) {
      return normalizeState(JSON.parse(raw), { now: now(), defaultEnabled, restoreActive: true });
    }
  });
  const initial = hotStore.read();
  if (loadError) initial.runtime.loadError = loadError;

  function update(mutator, flushNow = true) {
    hotStore.update((state) => {
      mutator(state);
      state.runtime.updatedAt = now();
      return state;
    }, { flushNow });
  }

  function getRoom(userId) {
    return clone(hotStore.read().rooms[String(userId || '').trim()] || null);
  }

  function updateRoom(userId, mutator) {
    const id = String(userId || '').trim();
    let result = null;
    update((state) => {
      const room = state.rooms[id];
      if (!room) return;
      mutator(room);
      result = clone(room);
    });
    return result;
  }

  function elapsedMs(room, timestamp = now()) {
    if (!room) return 0;
    return Math.max(0, Number(room.activeElapsedMs || 0) || 0)
      + (room.status === 'active' ? Math.max(0, timestamp - Number(room.resumedAt || room.startedAt)) : 0);
  }

  return {
    completeRoom(userId, input = {}) {
      const id = String(userId || '').trim();
      let memory = null;
      update((state) => {
        const room = state.rooms[id];
        if (!room) return;
        const endedAt = now();
        memory = normalizeMemory({
          id: room.id,
          activityType: room.activityType,
          contentType: room.contentType,
          contentTitle: room.contentTitle,
          progress: room.contentProgress,
          startedAt: room.startedAt,
          endedAt,
          durationMinutes: Math.max(1, Math.round(elapsedMs(room, endedAt) / 60000)),
          userNote: input.userNote || room.lastUserNote || '这次没有留下成果备注',
          botNote: input.botNote,
          completion: input.completion
        });
        state.memories[id] = [memory, ...(state.memories[id] || [])].slice(0, MAX_MEMORIES_PER_USER);
        delete state.rooms[id];
      });
      return clone(memory);
    },
    createRoom(userId, input = {}) {
      const id = String(userId || '').trim();
      const existing = getRoom(id);
      if (existing) return { code: 'room_exists', ...existing };
      let room;
      update((state) => {
        room = normalizeRoom({
          id: `room-${now()}`,
          activityType: input.activityType,
          contentType: input.contentType,
          contentTitle: input.contentTitle,
          durationMinutes: input.durationMinutes,
          density: input.density,
          status: 'active',
          startedAt: now(),
          resumedAt: now()
        }, now());
        state.rooms[id] = room;
      });
      return clone(room);
    },
    deleteMemory(userId, memoryId) {
      const id = String(userId || '').trim();
      let deleted = false;
      update((state) => {
        const current = state.memories[id] || [];
        state.memories[id] = current.filter((item) => item.id !== String(memoryId || '').trim());
        deleted = state.memories[id].length !== current.length;
      });
      return deleted;
    },
    elapsedMs,
    flush: () => hotStore.flushSync(),
    getRoom,
    getStatus() {
      const state = hotStore.read();
      const rooms = Object.values(state.rooms);
      return {
        enabled: state.enabled === true,
        activeRooms: rooms.filter((room) => room.status === 'active').length,
        pausedRooms: rooms.filter((room) => room.status === 'paused').length,
        memories: Object.values(state.memories).reduce((sum, list) => sum + list.length, 0),
        loadError: state.runtime.loadError || ''
      };
    },
    isEnabled: () => hotStore.read().enabled === true,
    listMemories: (userId, limit = 10) => clone((hotStore.read().memories[String(userId || '').trim()] || []).slice(0, limit)),
    listRooms: () => Object.entries(hotStore.read().rooms).map(([userId, room]) => ({ userId, ...clone(room) })),
    markNodeSent: (userId, node) => updateRoom(userId, (room) => {
      if (!room.sentNodes.includes(node)) room.sentNodes.push(node);
    }),
    pauseRoom: (userId, reason = 'user') => updateRoom(userId, (room) => {
      if (room.status !== 'active') return;
      room.activeElapsedMs = elapsedMs(room);
      room.status = 'paused';
      room.pausedAt = now();
      room.resumedAt = 0;
      room.pauseReason = reason;
    }),
    recordUserNote: (userId, note) => updateRoom(userId, (room) => {
      room.lastUserNote = String(note || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }),
    recordProgress: (userId, progress) => updateRoom(userId, (room) => {
      room.contentProgress = String(progress || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    }),
    reload() {
      hotStore.invalidate();
      hotStore.read({ forceReload: true });
    },
    resumeRoom: (userId) => updateRoom(userId, (room) => {
      if (room.status !== 'paused') return;
      room.totalPausedMs += Math.max(0, now() - Number(room.pausedAt || now()));
      room.status = 'active';
      room.resumedAt = now();
      room.pausedAt = 0;
      room.pauseReason = '';
    }),
    setEnabled(value) {
      update((state) => { state.enabled = value === true; });
      return value === true;
    },
    updateMemory(userId, memoryId, userNote) {
      const id = String(userId || '').trim();
      let updated = null;
      update((state) => {
        const memory = (state.memories[id] || []).find((item) => item.id === String(memoryId || '').trim());
        if (!memory) return;
        memory.userNote = String(userNote || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        updated = clone(memory);
      });
      return updated;
    },
    updateRoom
  };
}

module.exports = {
  STATE_VERSION,
  createCompanionRoomStateStore,
  defaultState,
  normalizeRoom,
  normalizeState
};
