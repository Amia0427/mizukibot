const assert = require('assert');
const fs = require('fs');
const path = require('path');

function readProjectFile(relPath) {
  return fs.readFileSync(path.join(__dirname, '..', relPath), 'utf8');
}

const runtime05 = readProjectFile('core/messageHandler.runtime-05.chunk.js');
assert.ok(
  /planDirectChat\(route,\s*\{[\s\S]*directedContext[\s\S]*memoryContext[\s\S]*availableContextSignals[\s\S]*dynamicFewShotPrompt[\s\S]*memoryCliTurn[\s\S]*schedulerInjection/.test(runtime05),
  'messageHandler.runtime-05 should pass existing rich context into planDirectChat'
);

const routeFlow = readProjectFile('core/messageRouteFlow/index.js');
assert.ok(
  /planDirectChat\(route,\s*\{[\s\S]*directedContext:\s*route\?\.meta\?\.directedContext[\s\S]*memoryContext:\s*route\?\.meta\?\.memoryContext[\s\S]*dynamicPromptBlockCatalog/.test(routeFlow),
  'messageRouteFlow supplement path should preserve route meta planner context'
);

const taskControl = readProjectFile('core/messageTaskControl.js');
assert.ok(
  /planDirectChat\(route,\s*\{[\s\S]*directedContext:\s*route\?\.meta\?\.directedContext[\s\S]*memoryContext:\s*route\?\.meta\?\.memoryContext[\s\S]*dynamicPromptBlockCatalog/.test(taskControl),
  'messageTaskControl supplement path should preserve route meta planner context'
);

console.log('plannerRichContextSource.test.js passed');
