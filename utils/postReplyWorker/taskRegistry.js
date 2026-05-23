const TASK_DEFINITIONS = Object.freeze({
  memoryLearning: Object.freeze({
    key: 'memoryLearning',
    phase: 'core',
    step: 'learnSomethingNew',
    dependsOn: [],
    failurePolicy: 'fatal'
  }),
  selfImprovement: Object.freeze({
    key: 'selfImprovement',
    phase: 'core',
    step: 'learnSelfImprovement',
    dependsOn: [],
    failurePolicy: 'fatal',
    pressureSkippable: true
  }),
  dailyJournal: Object.freeze({
    key: 'dailyJournal',
    phase: 'both',
    step: 'appendDailyJournalEntry',
    dependsOn: [],
    failurePolicy: 'fatal'
  }),
  memoryEvent: Object.freeze({
    key: 'memoryEvent',
    phase: 'core',
    step: 'appendVersionedMemoryUpdate',
    dependsOn: [],
    failurePolicy: 'fatal'
  }),
  materialize: Object.freeze({
    key: 'materialize',
    phase: 'core',
    step: 'scheduleMaterializeMemoryViews',
    dependsOn: ['memoryEvent'],
    failurePolicy: 'fatal'
  }),
  vectorMaintenance: Object.freeze({
    key: 'vectorMaintenance',
    phase: 'core',
    step: 'runVectorMaintenance',
    dependsOn: ['materialize'],
    failurePolicy: 'nonfatal',
    pressureSkippable: true
  }),
  memoryQualityAudit: Object.freeze({
    key: 'memoryQualityAudit',
    phase: 'core',
    step: 'runMemoryQualityAudit',
    dependsOn: ['materialize'],
    failurePolicy: 'nonfatal',
    pressureSkippable: true
  }),
  profileMaintenance: Object.freeze({
    key: 'profileMaintenance',
    phase: 'core',
    step: 'runProfileMaintenance',
    dependsOn: ['materialize'],
    failurePolicy: 'nonfatal',
    pressureSkippable: true
  }),
  enrich: Object.freeze({
    key: 'enrich',
    phase: 'enrich',
    step: 'runEnrichPhase',
    dependsOn: [],
    failurePolicy: 'fatal'
  })
});

function normalizeText(value = '') {
  return String(value || '').trim();
}

function getTaskDefinition(taskKey = '') {
  const key = normalizeText(taskKey);
  return TASK_DEFINITIONS[key] || Object.freeze({
    key,
    phase: 'both',
    step: key,
    dependsOn: [],
    failurePolicy: 'fatal'
  });
}

function listTaskDefinitions() {
  return Object.values(TASK_DEFINITIONS);
}

module.exports = {
  TASK_DEFINITIONS,
  getTaskDefinition,
  listTaskDefinitions
};
