const assert = require('assert');
const { createMaimaiPlayerService } = require('../src/features/maimai/player-service');

module.exports = (async () => {
  const requests = [];
  const service = createMaimaiPlayerService({
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return {
        ok: true,
        status: 200,
        async json() { return { records: [{ song_id: '1001', type: 'DX', level_index: 3, achievements: 99.5 }] }; }
      };
    },
    recordsUrl: 'https://example.test/player/records'
  });
  const result = await service.fetchRecords('secret-token');
  assert.strictEqual(result.records.length, 1);
  assert.strictEqual(requests[0].options.headers['Import-Token'], 'secret-token');
  assert.strictEqual(service.normalizeRecord(result.records[0]).chartKey, 'df:1001:DX:3');
  assert.strictEqual(service.enrichRecords(result.records, { getChartByKey: () => ({ mappingConfidence: 0.87 }) }).length, 0);

  const playerStore = {
    saveCredentialCalls: [],
    saveCredential(userId, token) { this.saveCredentialCalls.push([userId, token]); },
    saveSnapshot(userId, snapshot) { this.snapshot = [userId, snapshot]; },
    getCredentialToken() { return 'secret-token'; }
  };
  const catalog = { getChartByKey: () => ({ statsAvg: 100, statsStdDev: 2, density: 1, slideComboCount: 2 }) };
  const bound = await service.bind('10001', 'new-token', { playerStore, catalog });
  assert.strictEqual(bound.ok, true);
  assert.deepStrictEqual(playerStore.saveCredentialCalls, [['10001', 'new-token']]);
  assert.ok(!JSON.stringify(bound).includes('new-token'));

  const refreshed = await service.refresh('10001', { playerStore, catalog });
  assert.strictEqual(refreshed.ok, true);
  assert.strictEqual(playerStore.snapshot[0], '10001');
  assert.strictEqual(playerStore.snapshot[1].records[0].performanceZ, -0.25);
  console.log('maimaiPlayerService.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
