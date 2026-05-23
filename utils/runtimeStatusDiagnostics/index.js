const path = require('path');
const config = require('../../config');
const PROJECT_ROOT = path.resolve(__dirname, '..', '..');
const {
  compactProcess,
  isProcessAliveDefault,
  listProcesses,
  listProcessesDefault,
  processMatchesMain,
  processMatchesPostReplyWorker,
  processMatchesSubagent
} = require('./processes');
const {
  buildCreateAgentRuntimeState,
  buildMemoryMaterializeLock,
  buildPidFileStatus,
  isoFromMs,
  normalizeNumber,
  normalizePath,
  normalizeText,
  nowMs,
  safeReadDir,
  safeReadJson,
  safeStat
} = require('./files');
const {
  buildBackgroundTaskSummary,
  buildLangGraphV2StoreSummary,
  buildPostReplyQueueSummary
} = require('./stores');

const SCHEMA_VERSION = 'runtime_status_diagnostic_v1';
const DEFAULT_BACKGROUND_TASK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LANGGRAPH_V2_CHECKPOINT_STALE_MS = 30 * 60 * 1000;

function getSubagentRuntimeSnapshots() {
  const fallback = {
    executor: null,
    persistentWorkers: [],
    persistentWorkerStats: null,
    snapshotScope: 'current_process_only'
  };
  try {
    const executor = require('../../api/subagentExecutor');
    if (typeof executor.getSubagentExecutorSnapshot === 'function') {
      fallback.executor = executor.getSubagentExecutorSnapshot();
    }
  } catch (_) {}
  try {
    const commandBackend = require('../../api/subagentBackends/commandBackend');
    if (typeof commandBackend.getPersistentWorkerSnapshot === 'function') {
      fallback.persistentWorkers = commandBackend.getPersistentWorkerSnapshot();
    }
    if (commandBackend.__persistentWorkerStats) {
      fallback.persistentWorkerStats = { ...commandBackend.__persistentWorkerStats };
    }
  } catch (_) {}
  return fallback;
}

function buildSubagentSummary(processes = []) {
  const snapshots = getSubagentRuntimeSnapshots();
  const osProcesses = processes
    .filter(processMatchesSubagent)
    .map(compactProcess)
    .slice(0, 20);
  return {
    enabled: config.SUBAGENT_ENABLED === true,
    backend: normalizeText(config.SUBAGENT_BACKEND || 'command'),
    commandMode: normalizeText(config.SUBAGENT_COMMAND_MODE || ''),
    maxConcurrency: Math.max(1, normalizeNumber(config.SUBAGENT_MAX_CONCURRENCY, 1)),
    processes: osProcesses,
    processCount: osProcesses.length,
    executor: snapshots.executor,
    persistentWorkers: snapshots.persistentWorkers,
    persistentWorkerStats: snapshots.persistentWorkerStats,
    snapshotScope: snapshots.snapshotScope
  };
}

function addSignal(signals, level, component, code, message, extra = {}) {
  signals.push({
    level,
    component,
    code,
    message,
    ...extra
  });
}

function buildRuntimeStatusDiagnostic(options = {}) {
  const projectRoot = normalizePath(options.projectRoot || PROJECT_ROOT);
  const now = nowMs(options);
  const processes = listProcesses(options);
  const alive = typeof options.isProcessAlive === 'function'
    ? (pid) => Boolean(options.isProcessAlive(pid))
    : isProcessAliveDefault;
  const signals = [];

  const singleInstanceLock = buildPidFileStatus({
    name: 'singleInstanceLock',
    filePath: path.join(projectRoot, '.mizukibot.lock'),
    processes,
    isProcessAlive: alive,
    expectedProcess: processMatchesMain,
    now
  });
  const linuxMainPidFile = buildPidFileStatus({
    name: 'linuxMainPidFile',
    filePath: path.join(projectRoot, '.mizukibot.pid'),
    processes,
    isProcessAlive: alive,
    expectedProcess: processMatchesMain,
    now
  });
  const postReplyPidFile = buildPidFileStatus({
    name: 'postReplyWorkerPidFile',
    filePath: path.join(projectRoot, '.mizukibot-postreply-worker.pid'),
    processes,
    isProcessAlive: alive,
    expectedProcess: processMatchesPostReplyWorker,
    now
  });
  const memoryMaterializeLock = buildMemoryMaterializeLock({
    filePath: config.MEMORY_V3_MATERIALIZE_LOCK_FILE,
    isProcessAlive: alive,
    now
  });
  const createAgentRuntime = buildCreateAgentRuntimeState({
    filePath: path.join(config.DATA_DIR, 'create-agent', 'runtime.json'),
    isProcessAlive: alive,
    now
  });

  const mainProcesses = processes.filter(processMatchesMain).map(compactProcess);
  const workerProcesses = processes.filter(processMatchesPostReplyWorker).map(compactProcess);
  const backgroundTaskStaleMs = Math.max(
    1000,
    normalizeNumber(options.backgroundTaskStaleMs || process.env.BACKGROUND_TASK_STALE_MS, DEFAULT_BACKGROUND_TASK_STALE_MS)
  );
  const langGraphV2CheckpointStaleMs = Math.max(
    1000,
    normalizeNumber(
      options.langGraphV2CheckpointStaleMs || process.env.LANGGRAPH_V2_CHECKPOINT_STALE_MS,
      DEFAULT_LANGGRAPH_V2_CHECKPOINT_STALE_MS
    )
  );
  const backgroundTasks = buildBackgroundTaskSummary({
    storeDir: config.BACKGROUND_TASK_STORE_DIR,
    now,
    staleMs: backgroundTaskStaleMs,
    safeReadDir,
    safeReadJson,
    safeStat
  });
  const langGraphV2Store = buildLangGraphV2StoreSummary({
    checkpointDir: config.LANGGRAPH_V2_CHECKPOINT_DIR,
    eventDir: config.LANGGRAPH_V2_EVENT_DIR,
    now,
    staleCheckpointMs: langGraphV2CheckpointStaleMs,
    safeReadDir,
    safeReadJson,
    safeStat
  });
  const postReplyQueue = buildPostReplyQueueSummary({
    queueDir: config.POST_REPLY_QUEUE_DIR,
    now,
    staleProcessingMs: Math.max(1000, normalizeNumber(config.POST_REPLY_WORKER_STALE_PROCESSING_MS, 5 * 60 * 1000)),
    safeReadDir,
    safeReadJson,
    safeStat
  });
  const subagents = buildSubagentSummary(processes);
  const journalHealth = (() => {
    try {
      const { buildJournalHealthSummary } = require('../memory-v3/journalDiagnostics');
      return buildJournalHealthSummary({ limit: Math.max(1, normalizeNumber(options.journalLimit, 5)) });
    } catch (error) {
      return {
        ok: false,
        error: normalizeText(error?.message || error)
      };
    }
  })();

  if (singleInstanceLock.status === 'stale') {
    addSignal(signals, 'warning', 'mainProcess', 'main_lock_stale', 'main lock pid is not alive', { pid: singleInstanceLock.pid });
  } else if (singleInstanceLock.status === 'invalid') {
    addSignal(signals, 'warning', 'mainProcess', 'main_lock_invalid', 'main lock file exists but does not contain a pid');
  }
  if (singleInstanceLock.status === 'mismatch') {
    addSignal(signals, 'warning', 'mainProcess', 'main_lock_pid_mismatch', 'main lock pid is alive but does not look like index.js', { pid: singleInstanceLock.pid });
  }
  if (mainProcesses.length > 1) {
    addSignal(signals, 'warning', 'mainProcess', 'main_process_duplicate', 'multiple index.js processes were found', { count: mainProcesses.length });
  }

  const postReplyExpected = config.POST_REPLY_WORKER_ENABLED === true && config.POST_REPLY_WORKER_INLINE !== true;
  const postReplyDiagnosticsEnabled = postReplyExpected || config.POST_REPLY_WORKER_INLINE === true;
  if (postReplyExpected && postReplyPidFile.status === 'missing' && workerProcesses.length === 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_pid_missing', 'post-reply worker pid file is missing and no worker process was found');
  }
  if (postReplyDiagnosticsEnabled && postReplyPidFile.status === 'stale') {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_pid_stale', 'post-reply worker pid is not alive', { pid: postReplyPidFile.pid });
  }
  if (postReplyDiagnosticsEnabled && postReplyPidFile.status === 'mismatch') {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_pid_mismatch', 'post-reply worker pid is alive but command line does not look like post-reply-worker.js', { pid: postReplyPidFile.pid });
  }
  if (postReplyDiagnosticsEnabled && workerProcesses.length > 1) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_worker_duplicate', 'multiple post-reply worker processes were found', { count: workerProcesses.length });
  }
  if (postReplyDiagnosticsEnabled && postReplyQueue.staleProcessingCount > 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_processing_stale', 'post-reply processing jobs exceeded stale threshold', { count: postReplyQueue.staleProcessingCount });
  }
  if (postReplyDiagnosticsEnabled && postReplyQueue.counts.failed > 0) {
    addSignal(signals, 'warning', 'postReplyWorker', 'post_reply_failed_jobs', 'post-reply queue has failed jobs', { count: postReplyQueue.counts.failed });
  }

  if (backgroundTasks.staleActiveCount > 0) {
    addSignal(signals, 'warning', 'backgroundTasks', 'background_task_stale', 'active background tasks exceeded stale threshold', { count: backgroundTasks.staleActiveCount });
  }
  if (langGraphV2Store.staleRunningCheckpointCount > 0) {
    addSignal(signals, 'warning', 'langGraphV2', 'langgraph_v2_checkpoint_stale', 'active LangGraph V2 checkpoints exceeded stale threshold', { count: langGraphV2Store.staleRunningCheckpointCount });
  }
  if (langGraphV2Store.invalidCheckpointCount > 0) {
    addSignal(signals, 'warning', 'langGraphV2', 'langgraph_v2_checkpoint_invalid', 'LangGraph V2 checkpoint files could not be parsed', { count: langGraphV2Store.invalidCheckpointCount });
  }
  if (langGraphV2Store.invalidEventFileCount > 0) {
    addSignal(signals, 'warning', 'langGraphV2', 'langgraph_v2_event_file_invalid', 'LangGraph V2 event files could not be parsed as event arrays', { count: langGraphV2Store.invalidEventFileCount });
  }
  if (memoryMaterializeLock.status === 'stale') {
    addSignal(signals, 'warning', 'locks', 'memory_materialize_lock_stale', 'memory materialize lock is stale', { pid: memoryMaterializeLock.pid });
  }
  if (createAgentRuntime.status === 'stale') {
    addSignal(signals, 'warning', 'locks', 'create_agent_runtime_stale', 'create-agent runtime reports active work but owner pid is not alive', { pid: createAgentRuntime.ownerPid });
  }
  if (subagents.persistentWorkers.some((worker) => worker?.broken)) {
    addSignal(signals, 'warning', 'subagents', 'subagent_persistent_worker_broken', 'persistent subagent worker snapshot contains broken workers');
  }
  if (normalizeNumber(subagents.executor?.pendingSubagentRuns, 0) > 0) {
    addSignal(signals, 'warning', 'subagents', 'subagent_executor_queue_pending', 'subagent executor has queued calls', { count: normalizeNumber(subagents.executor?.pendingSubagentRuns, 0) });
  }

  const mainStatus = (() => {
    if (singleInstanceLock.status === 'running' || linuxMainPidFile.status === 'running' || mainProcesses.length > 0) return 'running';
    if (singleInstanceLock.status === 'stale' || linuxMainPidFile.status === 'stale') return 'stale_pid';
    if (singleInstanceLock.status === 'invalid') return 'invalid_lock';
    return 'missing';
  })();
  const postReplyStatus = (() => {
    if (config.POST_REPLY_WORKER_INLINE === true) return 'inline';
    if (postReplyPidFile.status === 'running' || workerProcesses.length > 0) return 'running';
    if (config.POST_REPLY_WORKER_ENABLED !== true) return 'disabled';
    if (postReplyPidFile.status === 'stale') return 'stale_pid';
    if (postReplyPidFile.status === 'invalid') return 'invalid_pid';
    return 'missing';
  })();
  const overallStatus = signals.some((signal) => signal.level === 'critical')
    ? 'critical'
    : (signals.length > 0 ? 'warning' : 'ok');

  return {
    schemaVersion: SCHEMA_VERSION,
    checkedAt: isoFromMs(now),
    summary: {
      overallStatus,
      signalCount: signals.length,
      signals: signals.map((signal) => signal.code),
      mainProcess: {
        status: mainStatus,
        lockPid: singleInstanceLock.pid || linuxMainPidFile.pid || 0,
        processCount: mainProcesses.length
      },
      postReplyWorker: {
        status: postReplyStatus,
        pid: postReplyPidFile.pid,
        pidFileMatch: postReplyPidFile.status !== 'mismatch',
        processCount: workerProcesses.length,
        queue: postReplyQueue.counts,
        queueByPhase: postReplyQueue.countsByPhase,
        failedByErrorClass: postReplyQueue.failedByErrorClass,
        oldestQueuedAgeMs: postReplyQueue.oldestQueued?.availableAgeMs || 0,
        oldestProcessingLeaseAgeMs: postReplyQueue.oldestProcessingLease?.leaseAgeMs || 0
      },
      activeBackgroundTasks: backgroundTasks.activeCount,
      staleBackgroundTasks: backgroundTasks.staleActiveCount,
      langGraphV2: {
        checkpoints: langGraphV2Store.checkpointCount,
        events: langGraphV2Store.eventFileCount,
        activeCheckpoints: langGraphV2Store.activeCheckpointCount,
        staleRunningCheckpoints: langGraphV2Store.staleRunningCheckpointCount,
        checkpointBytes: langGraphV2Store.totalCheckpointBytes,
        eventBytes: langGraphV2Store.totalEventBytes
      },
      activeSubagentProcesses: subagents.processCount,
      persistentSubagentWorkers: subagents.persistentWorkers.length,
      journalHealth: journalHealth.totals || {}
    },
    components: {
      projectRoot,
      mainProcess: {
        lockFile: singleInstanceLock,
        linuxPidFile: linuxMainPidFile,
        processes: mainProcesses
      },
      postReplyWorker: {
        enabled: config.POST_REPLY_WORKER_ENABLED === true,
        inline: config.POST_REPLY_WORKER_INLINE === true,
        pidFile: postReplyPidFile,
        processes: workerProcesses,
        queue: postReplyQueue
      },
      lockFiles: [
        singleInstanceLock,
        linuxMainPidFile,
        postReplyPidFile,
        memoryMaterializeLock,
        createAgentRuntime
      ],
      backgroundTasks,
      langGraphV2Store,
      subagents,
      journalHealth
    },
    signals
  };
}

function buildRuntimeStatusText(report = {}) {
  const summary = report.summary || {};
  const postQueue = summary.postReplyWorker?.queue || {};
  const failedByErrorClass = summary.postReplyWorker?.failedByErrorClass || {};
  const langGraphV2 = summary.langGraphV2 || {};
  const lines = [
    `runtime: ${summary.overallStatus || 'unknown'} (${summary.signalCount || 0} signals)`,
    `main: ${summary.mainProcess?.status || 'unknown'} pid=${summary.mainProcess?.lockPid || 0} processes=${summary.mainProcess?.processCount || 0}`,
    `post-reply: ${summary.postReplyWorker?.status || 'unknown'} pid=${summary.postReplyWorker?.pid || 0} processes=${summary.postReplyWorker?.processCount || 0} queue=queued:${postQueue.queued || 0} processing:${postQueue.processing || 0} failed:${postQueue.failed || 0} oldestQueuedMs=${summary.postReplyWorker?.oldestQueuedAgeMs || 0}`,
    `background-tasks: active=${summary.activeBackgroundTasks || 0} stale=${summary.staleBackgroundTasks || 0}`,
    `langgraph-v2: checkpoints=${langGraphV2.checkpoints || 0} active=${langGraphV2.activeCheckpoints || 0} stale=${langGraphV2.staleRunningCheckpoints || 0} events=${langGraphV2.events || 0}`,
    `subagents: osProcesses=${summary.activeSubagentProcesses || 0} persistentWorkers=${summary.persistentSubagentWorkers || 0}`
  ];
  const journal = summary.journalHealth || {};
  if (Object.keys(journal).length > 0) {
    lines.push(`journal: users=${journal.users || 0} days=${journal.days || 0} summaries=${journal.summaryDays || 0} segments=${journal.segments || 0} v3Events=${journal.v3EpisodeEvents || 0} embeddingReady=${journal.embeddingReady || 0} pending=${journal.embeddingPending || 0} failed=${journal.embeddingFailed || 0}`);
  }
  if (Object.keys(failedByErrorClass).length > 0) {
    lines.push(`post-reply-failed: ${Object.entries(failedByErrorClass).map(([key, value]) => `${key}:${value}`).join(' ')}`);
  }
  if (Array.isArray(report.signals) && report.signals.length > 0) {
    lines.push('signals:');
    for (const signal of report.signals) {
      lines.push(`- [${signal.level}] ${signal.component}/${signal.code}: ${signal.message}`);
    }
  }
  return lines.join('\n');
}

module.exports = {
  SCHEMA_VERSION,
  buildRuntimeStatusDiagnostic,
  buildRuntimeStatusText,
  isProcessAliveDefault,
  listProcessesDefault
};
