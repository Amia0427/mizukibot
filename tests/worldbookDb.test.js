const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'waifu-worldbook-db-test-'));
process.env.PERSONA_WORLDBOOK_DB_FILE = path.join(tempDir, 'worldbook.sqlite');
process.env.LOCAL_PROMPT_RECALL_ENABLED = 'false';

const {
  buildPersonaModuleCandidatesAsync,
  ensureWorldbookSqlImported,
  loadPersonaModuleCatalog,
  loadPersonaModuleText,
  selectPersonaModules
} = require('../utils/personaModules');
const {
  clearSessionActivations,
  getDiagnostics,
  getWorldbookEntry,
  listActiveEntries,
  recordActivation,
  resetDbForTests,
  searchWorldbookEntries,
  upsertWorldbookEntry
} = require('../utils/worldbookDb');
const { clearWorldbookSessionState } = require('../utils/personaWorldbookSearch/sessionState');

(async () => {
  resetDbForTests();
  const catalog = loadPersonaModuleCatalog();
  const firstImport = ensureWorldbookSqlImported(catalog, { force: true });
  assert.ok(firstImport.ok, firstImport.reason || 'worldbook import failed');
  assert.ok(firstImport.rowsSeen >= 30);

  const secondImport = ensureWorldbookSqlImported(catalog, { force: true });
  assert.ok(secondImport.ok, secondImport.reason || 'worldbook second import failed');
  assert.strictEqual(secondImport.rowsChanged, 0);

  const diagnostics = getDiagnostics({ benchmark: false });
  assert.ok(diagnostics.ok);
  assert.ok(diagnostics.primaryRead);
  assert.ok(diagnostics.activeEntries >= 30);

  const entry = getWorldbookEntry('wb_mizuki_future_two_tracks');
  assert.ok(entry);
  assert.strictEqual(entry.moduleId, 'wb_mizuki_future_two_tracks');
  assert.ok(entry.body.includes('两个都想继续'));

  const hiddenId = 'wb_mizuki_test_archived';
  upsertWorldbookEntry({
    id: hiddenId,
    moduleId: hiddenId,
    body: '测试归档条目，不应该被 active 查询召回',
    purpose: 'archived status filter test',
    triggerHints: ['归档测试'],
    status: 'archived',
    sourcePath: 'persona_worldbook/test_archived.txt'
  });
  assert.ok(!listActiveEntries().some((item) => item.moduleId === hiddenId));
  const hiddenSearch = searchWorldbookEntries('归档测试', { limit: 5 });
  assert.ok(!hiddenSearch.results.some((item) => item.moduleId === hiddenId));

  const ftsSearch = searchWorldbookEntries('瑞希未来两个都不放弃是什么意思', { limit: 4 });
  assert.ok(ftsSearch.ok);
  assert.ok(ftsSearch.results.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  assert.ok(Number(ftsSearch.diagnostics.ftsCandidates || 0) >= 0);

  const englishFtsSearch = searchWorldbookEntries('open campus N25', { limit: 4 });
  assert.ok(englishFtsSearch.results.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  assert.ok(Number(englishFtsSearch.diagnostics.ftsCandidates || 0) > 0);

  upsertWorldbookEntry({
    id: 'wb_mizuki_test_slot_a',
    moduleId: 'wb_mizuki_test_slot_a',
    body: 'slot conflict smoke unique alpha',
    purpose: 'slot conflict smoke unique alpha',
    triggerHints: ['slot conflict smoke'],
    slot: 'worldbook_test_slot',
    priority: 1,
    status: 'active',
    sourcePath: 'persona_worldbook/test_slot_a.txt'
  });
  upsertWorldbookEntry({
    id: 'wb_mizuki_test_slot_b',
    moduleId: 'wb_mizuki_test_slot_b',
    body: 'slot conflict smoke unique beta',
    purpose: 'slot conflict smoke unique beta',
    triggerHints: ['slot conflict smoke'],
    slot: 'worldbook_test_slot',
    priority: 2,
    status: 'active',
    sourcePath: 'persona_worldbook/test_slot_b.txt'
  });
  const slotLimited = searchWorldbookEntries('slot conflict smoke', { limit: 10, slotLimit: 1 });
  assert.strictEqual(
    slotLimited.results.filter((item) => item.slot === 'worldbook_test_slot').length,
    1
  );

  clearSessionActivations('worldbook-db-test');
  recordActivation({
    sessionKey: 'worldbook-db-test',
    moduleId: 'wb_mizuki_future_two_tracks',
    activationMode: 'session',
    remainingTurns: 1,
    linkedExamples: ['future_two_tracks']
  });
  const sticky = await buildPersonaModuleCandidatesAsync({
    question: '刚才那个话题继续说',
    chatType: 'private',
    sessionKey: 'worldbook-db-test',
    forceWorldbook: true,
    disableLocalPromptRecall: true,
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  assert.ok(sticky.some((item) => item.id === 'wb_mizuki_future_two_tracks'));
  assert.ok(sticky.find((item) => item.id === 'wb_mizuki_future_two_tracks').activationState);
  clearWorldbookSessionState('worldbook-db-test');

  const sqlBody = loadPersonaModuleText('wb_mizuki_future_two_tracks');
  assert.ok(sqlBody.includes('服饰专门学校'));
  assert.ok(sqlBody.includes('两个都想继续'));

  const candidates = await buildPersonaModuleCandidatesAsync({
    question: '瑞希未来两个都不放弃是什么意思',
    chatType: 'private',
    disableLocalPromptRecall: true,
    worldbookEmbeddingHotPath: false,
    worldbookSemanticLimit: 0
  });
  const selection = selectPersonaModules({}, {
    question: '瑞希未来两个都不放弃是什么意思',
    chatType: 'private',
    personaModuleCandidates: candidates
  });
  assert.ok(selection.activeWorldbookIds.includes('wb_mizuki_future_two_tracks'));

  console.log('worldbookDb.test.js passed');
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
