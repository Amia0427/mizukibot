const assert = require('assert');
const fs = require('fs');
const path = require('path');

const runtime05 = fs.readFileSync(path.join(__dirname, '..', 'core', 'messageHandler.runtime-05.chunk.js'), 'utf8');
const runtimeModule = fs.readFileSync(path.join(__dirname, '..', 'core', 'normalFastReplyRuntime.js'), 'utf8');

const fastGateIndex = runtime05.indexOf('buildNormalFastReplyDecision');
const plannerIndex = runtime05.indexOf('planDirectChat(route');
const dispatchIndex = runtime05.indexOf('routeFlow.dispatchFormalRoute');
const appendHistoryIndex = runtime05.indexOf('appendShortTermHistory');
const sendFailureWarnIndex = runtime05.indexOf("console.warn('[normal-fast-reply] send failed");
const sendFailureIndex = runtime05.lastIndexOf('if (!sent)', sendFailureWarnIndex);
const safetyMarkIndex = runtime05.indexOf('normalFastReplyResult?.hasSafetyRestriction === true');
const safetyEmojiIndex = runtime05.indexOf('markSafetyRestrictionEmojiAfterReply({', safetyMarkIndex);

assert.ok(fastGateIndex > 0, 'message handler should attempt normal fast reply');
assert.ok(plannerIndex > fastGateIndex, 'normal fast path should run before planDirectChat');
assert.ok(dispatchIndex > fastGateIndex, 'normal fast path should run before formal route dispatch');
assert.ok(sendFailureIndex > fastGateIndex, 'normal fast path should explicitly fall back on send failure');
assert.ok(appendHistoryIndex > sendFailureIndex, 'normal fast path should append history only after successful send branch');
assert.ok(safetyMarkIndex > sendFailureIndex, 'normal fast path should check safety restriction metadata after successful send');
assert.ok(safetyEmojiIndex > safetyMarkIndex && safetyEmojiIndex < appendHistoryIndex, 'normal fast path should mark safety restriction emoji before returning');
assert.ok(runtimeModule.includes('requestNonStreamingReply'), 'normal fast runtime should use requestNonStreamingReply');
assert.ok(!runtimeModule.includes('askAIByGraph'), 'normal fast runtime should not call askAIByGraph');
assert.ok(runtimeModule.includes('buildMainStableSystemBlocks'), 'normal fast runtime should reuse main stable prompt blocks');
assert.ok(runtimeModule.includes('stablePromptBlockIds'), 'normal fast runtime should expose stable prompt block diagnostics');
assert.ok(runtimeModule.includes('visibleMeta.hasSafetyRestriction'), 'normal fast runtime should preserve visible safety restriction metadata');
assert.ok(runtimeModule.includes('persistedMeta.hasSafetyRestriction'), 'normal fast runtime should preserve persisted safety restriction metadata');

console.log('normalFastReplyHandlerSource.test.js passed');
