const assert = require('assert');

const { diagnoseWorldbook } = require('../scripts/diagnose-worldbook');
const { clearWorldbookSessionState } = require('../utils/personaWorldbookSearch/sessionState');
const {
  ensureWorldbookSqlImported,
  loadPersonaModuleCatalog
} = require('../utils/personaModules');

(async () => {
  ensureWorldbookSqlImported(loadPersonaModuleCatalog(), { force: true });
  clearWorldbookSessionState('diag-worldbook-test');
  const result = await diagnoseWorldbook({
    question: '服饰专门学校和N25两个都不放弃',
    sessionKey: 'diag-worldbook-test',
    chatType: 'private',
    consume: false
  });

  assert.strictEqual(result.schemaVersion, 'worldbook_diagnostic_v1');
  assert.ok(result.db && result.db.primaryRead);
  assert.ok(result.sqlHits && result.sqlHits.primaryRead);
  assert.ok(result.ftsHits && Object.prototype.hasOwnProperty.call(result.ftsHits, 'count'));
  assert.ok(result.semanticHits && Object.prototype.hasOwnProperty.call(result.semanticHits, 'count'));
  assert.ok(result.sessionHits && Array.isArray(result.sessionHits.activated));
  assert.ok(result.finalInjectedBlocks.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  assert.ok(Array.isArray(result.candidates));
  assert.ok(result.candidates.some((item) => item.id === 'wb_mizuki_future_two_tracks'));
  assert.ok(result.selected.some((item) => item.id === 'wb_mizuki_future_two_tracks'));
  assert.ok(result.activeWorldbookIds.includes('wb_mizuki_future_two_tracks'));
  assert.ok(result.dynamicFewShot.allowed);
  assert.ok(result.dynamicFewShot.exampleIds.includes('future_two_tracks'));
  assert.ok(result.sessionState.some((item) => item.moduleId === 'wb_mizuki_future_two_tracks'));
  clearWorldbookSessionState('diag-worldbook-test');

  console.log('worldbookDiagnostic.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
