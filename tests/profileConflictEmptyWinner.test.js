const assert = require('assert');
const { resolveProfileNodeConflicts } = require('../utils/memory-v3/profileProjection/conflicts');

const nodes = [
  {
    id: 'empty-winner',
    userId: 'u_conflict_empty',
    scopeType: 'personal',
    fieldKey: 'identity',
    semanticSlot: 'identity',
    text: '',
    status: 'active',
    sourceKind: 'explicit',
    evidenceTier: 'strict',
    stabilityScore: 1,
    confidence: 1,
    updatedAt: 2,
    conflictKey: 'u_conflict_empty|personal|identity|identity'
  },
  {
    id: 'strong-anchor',
    userId: 'u_conflict_empty',
    scopeType: 'personal',
    fieldKey: 'identity',
    semanticSlot: 'identity',
    text: 'GD里的清流',
    status: 'active',
    sourceKind: 'explicit',
    evidenceTier: 'strict',
    stabilityScore: 0.99,
    confidence: 0.99,
    updatedAt: 1,
    conflictKey: 'u_conflict_empty|personal|identity|identity'
  }
];

const result = resolveProfileNodeConflicts(nodes);
assert.ok(result.selected.some((item) => item.id === 'strong-anchor'));
assert.ok(result.conflicts.some((item) => item.reason === 'profile_conflict_empty_winner_ignored'));
assert.ok(!nodes[1].suppressedBy);

console.log('profileConflictEmptyWinner.test.js passed');
