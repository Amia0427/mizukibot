const assert = require('assert');
const { createMaimaiCommandHandler, parseMaimaiCommand } = require('../src/features/maimai/commands');

module.exports = (async () => {
  assert.deepStrictEqual(parseMaimaiCommand('/mai bind sentinel-token'), { command: 'bind', args: ['sentinel-token'] });
  assert.strictEqual(parseMaimaiCommand('mai bind sentinel-token'), null);
  const replies = [];
  const runtime = {
    playerStore: {
      isBound: () => true,
      unbind: () => true,
      getLatestSnapshot: () => ({ status: 'missing' })
    },
    catalog: { getActiveGeneration: () => ({ sourceRevision: 'tree-1', finishedAt: 'now' }) },
    syncWorker: { runOnce: async () => ({ status: 'active' }) }
  };
  const handler = createMaimaiCommandHandler({
    getRuntime: () => runtime,
    isAdmin: (userId) => userId === 'admin',
    sendReply: async (_msg, text) => replies.push(text),
    playerService: {
      bind: async () => { throw new Error('invalid token'); },
      refresh: async () => ({ ok: true, recordCount: 2, fetchedAt: 'now' })
    }
  });
  assert.strictEqual(await handler.handle({ raw_message: '/mai bind sentinel-token', message_type: 'group', user_id: '10001', group_id: 'g1' }), true);
  assert.match(replies.pop(), /只能私聊/);
  assert.strictEqual(await handler.handle({ raw_message: '/mai bind sentinel-token', message_type: 'private', user_id: '10001' }), true);
  const bindReply = replies.pop();
  assert.match(bindReply, /绑定验证失败/);
  assert.ok(!bindReply.includes('sentinel-token'));
  await handler.handle({ raw_message: '/mai sync', message_type: 'group', user_id: '10001', group_id: 'g1' });
  assert.match(replies.pop(), /管理员/);
  await handler.handle({ raw_message: '/mai sync', message_type: 'private', user_id: 'admin' });
  assert.match(replies.pop(), /后台启动/);
  console.log('maimaiCommands.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
