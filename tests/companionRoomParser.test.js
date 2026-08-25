const assert = require('assert');

const { parseCompanionRoomMessage } = require('../src/features/companion-room/parser');

assert.deepStrictEqual(parseCompanionRoomMessage('陪我学习半小时', { chatType: 'private' }), {
  matched: true,
  action: 'start',
  activityType: 'focus',
  durationMinutes: 30
});
assert.deepStrictEqual(parseCompanionRoomMessage('陪我放松一下', { chatType: 'private' }), {
  matched: true,
  action: 'start',
  activityType: 'relax'
});
assert.strictEqual(parseCompanionRoomMessage('/陪伴 开始 专注 60分钟', { chatType: 'private' }).durationMinutes, 60);
assert.strictEqual(parseCompanionRoomMessage('/陪伴 开始 专注 15', { chatType: 'private' }).durationMinutes, 15);
assert.strictEqual(parseCompanionRoomMessage('/陪伴 开始 放松 2小时', { chatType: 'private' }).durationMinutes, 120);
assert.deepStrictEqual(parseCompanionRoomMessage('/陪伴 开始 共读 三体 30分钟', { chatType: 'private' }), {
  matched: true,
  action: 'start',
  activityType: 'focus',
  contentType: 'read',
  contentTitle: '三体',
  durationMinutes: 30
});
assert.deepStrictEqual(parseCompanionRoomMessage('陪我共看《葬送的芙莉莲》半小时', { chatType: 'private' }), {
  matched: true,
  action: 'start',
  activityType: 'relax',
  contentType: 'watch',
  contentTitle: '葬送的芙莉莲',
  durationMinutes: 30
});
assert.strictEqual(parseCompanionRoomMessage('陪我一起听 初音未来演唱会', { chatType: 'private' }).contentType, 'listen');
assert.deepStrictEqual(parseCompanionRoomMessage('/陪伴 进度 看到第 3 章', { chatType: 'private' }), {
  matched: true,
  action: 'progress',
  progress: '看到第 3 章'
});
assert.strictEqual(parseCompanionRoomMessage('/陪伴 开始 共读 30分钟', { chatType: 'private' }).action, 'usage');
assert.strictEqual(parseCompanionRoomMessage('/陪伴 开始 共读 三体 20分钟', { chatType: 'private' }).action, 'usage');
assert.strictEqual(parseCompanionRoomMessage('陪我共读三体20分钟', { chatType: 'private' }).action, 'usage');
assert.strictEqual(parseCompanionRoomMessage('/陪伴 开始 专注 20分钟', { chatType: 'private' }).action, 'usage');
assert.strictEqual(parseCompanionRoomMessage('陪我学习20分钟', { chatType: 'private' }).action, 'usage');
assert.strictEqual(parseCompanionRoomMessage('暂停陪伴', { chatType: 'private' }).action, 'pause');
assert.strictEqual(parseCompanionRoomMessage('继续陪伴', { chatType: 'private' }).action, 'resume');
assert.strictEqual(parseCompanionRoomMessage('结束陪伴', { chatType: 'private' }).action, 'end');
assert.deepStrictEqual(parseCompanionRoomMessage('安静一点', { chatType: 'private' }), {
  matched: true,
  action: 'density',
  density: 'quiet'
});
assert.strictEqual(parseCompanionRoomMessage('多陪我聊聊', { chatType: 'private' }).density, 'chatty');
assert.strictEqual(parseCompanionRoomMessage('/陪伴 回忆 删除 room-1', { chatType: 'private' }).action, 'memory_delete');
assert.strictEqual(parseCompanionRoomMessage('/陪伴 回忆 修改 room-1 今天完成了草稿', { chatType: 'private' }).action, 'memory_update');
assert.deepStrictEqual(parseCompanionRoomMessage('/陪伴 切换 放松', { chatType: 'private' }), {
  matched: true,
  action: 'switch',
  activityType: 'relax'
});
assert.strictEqual(parseCompanionRoomMessage('切换到专注', { chatType: 'private' }).action, 'switch');
assert.strictEqual(parseCompanionRoomMessage('今天学习了半小时', { chatType: 'private' }).matched, false);
assert.strictEqual(parseCompanionRoomMessage('陪我学习一下怎么配置环境', { chatType: 'private' }).matched, false);
assert.strictEqual(parseCompanionRoomMessage('一起看起来不错', { chatType: 'private' }).matched, false);
assert.strictEqual(parseCompanionRoomMessage('陪我学习半小时', { chatType: 'group' }).matched, false);

console.log('companionRoomParser.test.js passed');
