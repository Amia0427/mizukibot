const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { createCompanionRoomStateStore } = require('../src/features/companion-room/state');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'companion-room-state-'));
const filePath = path.join(tempDir, 'state.json');
let now = 1000;
const store = createCompanionRoomStateStore(filePath, { now: () => now, defaultEnabled: false });

assert.strictEqual(store.isEnabled(), false);
store.setEnabled(true);
assert.strictEqual(store.isEnabled(), true);

const room = store.createRoom('user-1', {
  activityType: 'focus',
  contentType: 'read',
  contentTitle: '三体',
  durationMinutes: 30,
  density: 'occasional'
});
assert.strictEqual(room.status, 'active');
assert.strictEqual(room.contentType, 'read');
assert.strictEqual(room.contentTitle, '三体');
assert.strictEqual(store.createRoom('user-1', { activityType: 'relax' }).code, 'room_exists');

now = 6000;
assert.strictEqual(store.pauseRoom('user-1').status, 'paused');
now = 16000;
assert.strictEqual(store.resumeRoom('user-1').totalPausedMs, 10000);
store.recordUserNote('user-1', '今天完成了草稿');
store.recordProgress('user-1', '看到第 3 章');
store.markNodeSent('user-1', 'midpoint');

now = 20000;
const memory = store.completeRoom('user-1', {
  botNote: '我也把手边的事做完了一点。',
  completion: 'completed'
});
assert.strictEqual(memory.userNote, '今天完成了草稿');
assert.strictEqual(memory.contentType, 'read');
assert.strictEqual(memory.contentTitle, '三体');
assert.strictEqual(memory.progress, '看到第 3 章');
assert.strictEqual(store.getRoom('user-1'), null);
assert.strictEqual(store.listMemories('user-1').length, 1);
assert.strictEqual(store.updateMemory('user-1', memory.id, '改成：完成了两页草稿').userNote, '改成：完成了两页草稿');
assert.strictEqual(store.deleteMemory('user-1', memory.id), true);
assert.strictEqual(store.listMemories('user-1').length, 0);

store.createRoom('user-2', { activityType: 'relax', durationMinutes: 45, density: 'quiet' });
store.flush();
now = 1400000;
const restored = createCompanionRoomStateStore(filePath, { now: () => now, defaultEnabled: false });
assert.strictEqual(restored.getRoom('user-2').status, 'paused');
assert.strictEqual(restored.getRoom('user-2').pauseReason, 'runtime_restart');
assert.deepStrictEqual(restored.getRoom('user-2').sentNodes, ['midpoint']);
assert.strictEqual(restored.getRoom('user-2').contentType, '');

fs.writeFileSync(path.join(tempDir, 'broken.json'), '{broken', 'utf8');
const broken = createCompanionRoomStateStore(path.join(tempDir, 'broken.json'), { defaultEnabled: true });
assert.strictEqual(broken.getStatus().loadError, 'invalid_state_file');

console.log('companionRoomState.test.js passed');
