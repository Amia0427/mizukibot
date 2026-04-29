const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mizuki-memory-profile-audit-'));
process.env.DATA_DIR = tempRoot;
process.env.MEMORY_FILE = path.join(tempRoot, 'memories.json');
process.env.DATA_FILE = path.join(tempRoot, 'favorites.json');
process.env.MEMORY_V3_DIR = path.join(tempRoot, 'memory-v3');
process.env.MEMORY_V3_PROJECTIONS_DIR = path.join(process.env.MEMORY_V3_DIR, 'projections');
process.env.MEMORY_PROFILE_LEGACY_AUDIT_ENABLED = 'true';
process.env.MEMORY_PROFILE_SHADOW_MIGRATION_ENABLED = 'false';

fs.mkdirSync(process.env.MEMORY_V3_PROJECTIONS_DIR, { recursive: true });
fs.writeFileSync(process.env.DATA_FILE, JSON.stringify({}, null, 2));
fs.writeFileSync(process.env.MEMORY_FILE, JSON.stringify({
  u_audit: {
    facts: [],
    profile: {
      identities: ['legacy only identity', 'duplicate identity'],
      personality_traits: [],
      hobbies: [],
      likes: ['same object', 'legacy only like'],
      dislikes: ['legacy dislike only'],
      goals: [],
      recent_topics: ['legacy rolling topic'],
      relation_stage: '陌生人'
    },
    summary: '',
    impression: ''
  }
}, null, 2));
fs.writeFileSync(path.join(process.env.MEMORY_V3_PROJECTIONS_DIR, 'profile_projection.json'), JSON.stringify({
  version: 2,
  updatedAt: Date.now(),
  users: {
    u_audit: {
      personaCore: {},
      strictProfile: {
        identities: ['duplicate identity', 'v3 only identity'],
        personality_traits: [],
        hobbies: [],
        likes: ['v3 only like'],
        dislikes: ['same object'],
        goals: [],
        boundaries: []
      },
      weakProfile: {
        single_hit_preferences: [],
        single_hit_traits: [],
        recent_topics: []
      },
      relation_stage: '陌生人'
    }
  }
}, null, 2));

const { auditLegacyProfileProjection } = require('../utils/memoryProfileSurface');

const report = auditLegacyProfileProjection('u_audit');
assert.strictEqual(report.enabled, true);
assert.ok(report.users.u_audit.legacyOnly.some((item) => item.text === 'legacy only identity'));
assert.ok(report.users.u_audit.v3Only.some((item) => item.text === 'v3 only identity'));
assert.ok(report.users.u_audit.duplicates.some((item) => item.text === 'duplicate identity'));
assert.ok(report.users.u_audit.conflicts.some((item) => item.text === 'same object' || item.otherText === 'same object'));
assert.ok(report.users.u_audit.suspicious.some((item) => item.reason === 'legacy_recent_topic_no_ttl'));
assert.strictEqual(report.shadowMigrationEvents.length, 0);

console.log('memoryProfileLegacyAudit.test.js passed');
