const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-profile-identity-noise-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_EVENTS_DIR = path.join(process.env.MEMORY_V3_DIR, 'events');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_V3_ENABLED = 'true';
process.env.MEMORY_PROFILE_IDENTITY_NOISE_FILTER = 'true';

fs.mkdirSync(tempRoot, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({}, null, 2));

const { appendMemoryEvent } = require('../utils/memory-v3/events');
const { materializeMemoryViews } = require('../utils/memory-v3/materializer');

module.exports = (async () => {
  const now = Date.now();
  await appendMemoryEvent({
    type: 'memory_confirmed',
    ts: now + 1,
    id: 'identity-noise',
    userId: 'u_identity_noise',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'identity',
    semanticSlot: 'identity',
    text: 'someone being reprimanded by the assistant',
    confidence: 0.99,
    payload: { fieldKey: 'identity', type: 'identity' }
  });
  await appendMemoryEvent({
    type: 'memory_confirmed',
    ts: now + 2,
    id: 'identity-anchor',
    userId: 'u_identity_noise',
    scopeType: 'personal',
    source: 'explicit',
    sourceKind: 'explicit',
    status: 'active',
    memoryKind: 'identity',
    semanticSlot: 'identity',
    text: 'GD里的清流',
    confidence: 0.99,
    payload: { fieldKey: 'identity', type: 'identity' }
  });

  const result = materializeMemoryViews({ force: true });
  const profile = result.profileProjection.users.u_identity_noise;
  assert.ok(profile.strictProfile.identities.includes('GD里的清流'));
  assert.ok(!profile.strictProfile.identities.includes('someone being reprimanded by the assistant'));

  console.log('memoryProfileIdentityNoiseFilter.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
