const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

module.exports = (async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mizukibot-followup-context-'));
  const stateFile = path.join(tempDir, 'followups.json');
  try {
    const { createFollowupStateStore, createCompanionFollowupService } = require('../src/features/companion-followups');
    const store = createFollowupStateStore(stateFile, { now: () => Date.now() });
    const followupService = createCompanionFollowupService({
      config: { DATA_DIR: tempDir, TIMEZONE: 'Asia/Shanghai' },
      store
    });
    followupService.execute('context-user', { action: 'add', title: '继续看共读章节' });
    followupService.execute('other-user', { action: 'add', title: '不应被注入' });

    const { createPrivateProactiveContextProvider } = require('../core/privateProactiveEngine/context');
    const provider = createPrivateProactiveContextProvider({ followupService });
    const context = await provider('context-user', { narratives: [] }, Date.now());
    assert.deepStrictEqual(context.followUps.map((item) => item.title), ['继续看共读章节']);
    assert.ok(!JSON.stringify(context).includes('不应被注入'));

    const { buildDedicatedInstructions } = require('../core/privateProactiveEngine/model');
    assert.ok(buildDedicatedInstructions('proactive').includes('followUps'));

    const { getToolExecutor, getToolSchemaByName } = require('../api/toolRegistry');
    const { resolveToolPolicy } = require('../utils/toolPolicy');
    assert.ok(getToolSchemaByName('companion_followup'));
    assert.strictEqual(typeof getToolExecutor('companion_followup'), 'function');
    assert.strictEqual(resolveToolPolicy('companion_followup', { action: 'list' }).policy.confirmation, 'none');
    assert.strictEqual(resolveToolPolicy('companion_followup', { action: 'add' }).policy.confirmation, 'explicit');
    assert.strictEqual(resolveToolPolicy('companion_followup', { action: 'delete' }).policy.effect, 'destructive');

    const { createToolAuthorizationService } = require('../api/toolAuthorization');
    const { createToolAuthorizationStore } = require('../utils/toolAuthorizationStore');
    const { enforceToolPolicy } = require('../utils/toolPolicy');
    const { validateToolCallArgs } = require('../api/runtimeV2/runtime/toolExecutionPrimitives');
    const authorizationStore = createToolAuthorizationStore({ file: ':memory:', ttlMs: 60000 });
    const authorization = createToolAuthorizationService({
      store: authorizationStore,
      getToolSchemaByName,
      getToolExecutor,
      hasPublicToolPolicy: () => true,
      resolveToolPolicy,
      enforceToolPolicy,
      validateToolCallArgs,
      isAdminUser: () => false
    });
    const pending = await authorization.executeAuthorizedToolCall({
      toolName: 'companion_followup',
      rawArgs: { action: 'add', title: '授权后才写入' },
      normalizedArgs: { action: 'add', title: '授权后才写入' },
      policy: resolveToolPolicy('companion_followup', { action: 'add' }).policy,
      actor: { userId: 'authorized-user', chatType: 'private', platform: 'qq' },
      invocationKey: 'followup-auth-test',
      toolContext: { userId: 'authorized-user', chatType: 'private' },
      executor: getToolExecutor('companion_followup')
    });
    assert.strictEqual(pending.status, 'confirmation_required');
    assert.strictEqual(
      followupService.execute('authorized-user', { action: 'list' }).items.length,
      0,
      '写操作在确认前不能落盘'
    );
    authorizationStore.close();
    console.log('companionFollowupIntegration.test.js passed');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})();
