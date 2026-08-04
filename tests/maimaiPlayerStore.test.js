const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createMaimaiPlayerStore,
  decodeCredentialMasterKey
} = require('../src/features/maimai/player-store');

module.exports = (() => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-maimai-player-'));
  const dbFile = path.join(tempRoot, 'player.sqlite');
  const masterKey = Buffer.alloc(32, 7).toString('base64');
  const store = createMaimaiPlayerStore({ dbFile, masterKey });

  try {
    assert.strictEqual(decodeCredentialMasterKey(masterKey).length, 32);
    assert.throws(() => decodeCredentialMasterKey('not-base64'), /Base64.*32/);
    assert.throws(() => decodeCredentialMasterKey(Buffer.alloc(31).toString('base64')), /Base64.*32/);

    store.saveCredential('10001', 'unique-import-token');
    assert.strictEqual(store.isBound('10001'), true);
    assert.strictEqual(store.getCredentialToken('10001'), 'unique-import-token');
    assert.throws(() => store.getCredentialToken('10002'), /not bound/);

    const encrypted = store.db.prepare(`
      SELECT token_ciphertext, nonce, auth_tag FROM maimai_player_credentials WHERE qq_user_id = ?
    `).get('10001');
    assert.ok(!Buffer.from(encrypted.token_ciphertext).includes(Buffer.from('unique-import-token')));

    store.db.prepare(`
      UPDATE maimai_player_credentials SET qq_user_id = ? WHERE qq_user_id = ?
    `).run('10002', '10001');
    assert.throws(() => store.getCredentialToken('10002'), /authenticate|decrypt/i);
    store.db.prepare(`
      UPDATE maimai_player_credentials SET qq_user_id = ? WHERE qq_user_id = ?
    `).run('10001', '10002');

    const fetchedAt = '2026-08-04T03:00:00.000Z';
    store.saveSnapshot('10001', {
      fetchedAt,
      raw: { records: 1 },
      records: [{ chartKey: 'df:1001:SD:3', achievement: 100.5, performanceZ: -0.5 }],
      weaknesses: [{ feature: 'slideIntensity', correlation: -0.4, sampleSize: 12 }]
    });

    const fresh = store.getLatestSnapshot('10001', {
      now: Date.parse(fetchedAt) + 14 * 60 * 1000
    });
    assert.strictEqual(fresh.status, 'fresh');
    assert.strictEqual(fresh.records[0].chartKey, 'df:1001:SD:3');
    assert.strictEqual(fresh.weaknesses[0].feature, 'slideIntensity');

    const stale = store.getLatestSnapshot('10001', {
      now: Date.parse(fetchedAt) + 16 * 60 * 1000
    });
    assert.strictEqual(stale.status, 'stale');
    assert.strictEqual(stale.fetchedAt, fetchedAt);

    assert.strictEqual(store.unbind('10001'), true);
    assert.strictEqual(store.isBound('10001'), false);
    assert.strictEqual(store.getLatestSnapshot('10001').status, 'missing');

    const publicOnly = createMaimaiPlayerStore({ dbFile: path.join(tempRoot, 'public.sqlite') });
    try {
      assert.throws(() => publicOnly.saveCredential('10001', 'token'), /MAIMAI_CREDENTIAL_MASTER_KEY/);
    } finally {
      publicOnly.close();
    }

    console.log('maimaiPlayerStore.test.js passed');
  } finally {
    store.close();
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
})();
