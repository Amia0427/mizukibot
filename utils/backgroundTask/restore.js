const fs = require('fs');
const path = require('path');

const {
  ACTIVE_STATUSES,
  normalizeTask,
  normalizeText,
  nowIso
} = require('./state');
const {
  ensureDir,
  safeReadJson
} = require('./store');

function buildRestoredSessionDefaults({
  list,
  now = nowIso,
  sessionTtlMs
}) {
  const sorted = list.slice().sort((a, b) => {
    const byRevision = Number(b.revision || 0) - Number(a.revision || 0);
    if (byRevision !== 0) return byRevision;
    return String(b.updated_at || '').localeCompare(String(a.updated_at || ''));
  });
  const latest = sorted[0];
  const explicitDone = sorted.find((item) => item.session_status === 'done');
  return {
    status: explicitDone ? 'done' : 'retained',
    active_task_id: '',
    latest_task_id: latest?.id || '',
    latest_summary: latest?.latest_summary || '',
    latest_result_excerpt: latest?.result_excerpt || '',
    original_text: latest?.original_text || '',
    revision: Number(latest?.revision || 0),
    updated_at: latest?.updated_at || now(),
    expires_at: latest?.expires_at || new Date(Date.now() + sessionTtlMs).toISOString(),
    closed_at: explicitDone?.completed_at || null
  };
}

function restoreBackgroundTasksFromDisk({
  storeDir,
  sessionTtlMs,
  tasksById,
  sessionsByKey,
  controllerRegistry,
  writeTask,
  saveSession,
  buildSessionSkeleton,
  now = nowIso
}) {
  ensureDir(storeDir);
  tasksById.clear();
  sessionsByKey.clear();
  if (controllerRegistry && typeof controllerRegistry.clearAll === 'function') {
    controllerRegistry.clearAll();
  }

  const files = fs.readdirSync(storeDir)
    .filter((name) => name.endsWith('.json'))
    .map((name) => path.join(storeDir, name));

  for (const filePath of files) {
    const parsed = safeReadJson(filePath, null);
    if (!parsed || typeof parsed !== 'object') continue;
    let task = normalizeTask(parsed, { sessionTtlMs });
    if (ACTIVE_STATUSES.has(task.status)) {
      task = {
        ...task,
        status: 'interrupted',
        stage: 'interrupted',
        suppress_followup: true,
        completed_at: task.completed_at || now(),
        error: task.error || 'interrupted on restore'
      };
    }
    writeTask(task);
  }

  const grouped = new Map();
  for (const task of tasksById.values()) {
    const sessionKey = normalizeText(task.session_key);
    if (!sessionKey) continue;
    const list = grouped.get(sessionKey) || [];
    list.push(task);
    grouped.set(sessionKey, list);
  }

  for (const [sessionKey, list] of grouped.entries()) {
    saveSession(buildSessionSkeleton(sessionKey, buildRestoredSessionDefaults({
      list,
      now,
      sessionTtlMs
    })));
  }
}

module.exports = {
  buildRestoredSessionDefaults,
  restoreBackgroundTasksFromDisk
};
