const assert = require('assert');

process.env.API_KEY = process.env.API_KEY || 'test-key';

const { TOOL_SCHEMAS } = require('../api/toolSchemas');
const { deriveToolArgs } = require('../api/runtimeV2/planning/service');
const { enforceToolPolicy } = require('../utils/toolPolicy');

const draftArgs = enforceToolPolicy('qzone_draft', {
  mode: 'bot_diary',
  hint: '按你的口吻写今天的日记'
});

assert.strictEqual(draftArgs.mode, 'bot_diary');
assert.strictEqual(draftArgs.hint, '按你的口吻写今天的日记');
assert.strictEqual(draftArgs.content, '');

const legacyArgs = enforceToolPolicy('publish_qzone', {
  mode: 'agent',
  hint: '写一条有点冷但自然的空间'
});

assert.strictEqual(legacyArgs.mode, 'agent');
assert.strictEqual(legacyArgs.hint, '写一条有点冷但自然的空间');

const scheduledArgs = enforceToolPolicy('create_qzone_auto_task', {
  when: '明天 22:00',
  hint: '夜间随手说说'
});

assert.strictEqual(scheduledArgs.action, 'qzone_post');
assert.strictEqual(scheduledArgs.when, '明天 22:00');
assert.strictEqual(scheduledArgs.mode, 'agent');
assert.strictEqual(scheduledArgs.hint, '夜间随手说说');

const schemaNames = new Set(TOOL_SCHEMAS.map((item) => item?.function?.name).filter(Boolean));
assert.ok(schemaNames.has('qzone_draft'));
assert.ok(schemaNames.has('create_qzone_auto_task'));

const scheduledCommandSchema = TOOL_SCHEMAS.find((item) => item?.function?.name === 'create_scheduled_command');
assert.ok(scheduledCommandSchema.function.parameters.properties.mode.enum.includes('agent'));
assert.ok(scheduledCommandSchema.function.parameters.properties.mode.enum.includes('generic_autodraft'));

const route = {
  cleanText: '今晚写一点轻松的空间',
  meta: {
    command: {
      payload: '今晚写一点轻松的空间'
    },
    requestText: '今晚写一点轻松的空间'
  }
};
const draftDerivedArgs = deriveToolArgs('qzone_draft', route);
assert.strictEqual(draftDerivedArgs.mode, 'agent');
assert.strictEqual(draftDerivedArgs.content, '');
assert.strictEqual(draftDerivedArgs.hint, '今晚写一点轻松的空间');

const autoTaskDerivedArgs = deriveToolArgs('create_qzone_auto_task', route);
assert.strictEqual(autoTaskDerivedArgs.mode, 'agent');
assert.strictEqual(autoTaskDerivedArgs.hint, '今晚写一点轻松的空间');

console.log('toolPolicyQzone.test.js passed');
