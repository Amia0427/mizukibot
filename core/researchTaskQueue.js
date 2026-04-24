const config = require('../config');
const { runResearchSubagent } = require('./researchSubagent');
const { normalizeQuery, saveResearchBrief } = require('../utils/sessionResearchCache');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function buildTaskKey(task = {}) {
  return [normalizeText(task.sessionKey) || `user:${normalizeText(task.userId) || 'unknown'}`, normalizeQuery(task.query)].join('|');
}

function createTimeoutPromise(timeoutMs, message = 'research_subagent timeout') {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), Math.max(1, timeoutMs));
    if (typeof timer.unref === 'function') timer.unref();
  });
}

class ResearchTaskQueue {
  constructor(options = {}) {
    this.config = options.config || config;
    this.runner = options.runner || runResearchSubagent;
    this.tasksByKey = new Map();
    this.pending = [];
    this.activeCount = 0;
  }

  isEnabled() {
    return this.config.RESEARCH_SUBAGENT_ENABLED !== false;
  }

  getMaxConcurrency() {
    return Math.max(1, Number(this.config.RESEARCH_SUBAGENT_MAX_CONCURRENCY || 1) || 1);
  }

  getTimeoutMs() {
    return Math.max(1000, Number(this.config.RESEARCH_SUBAGENT_TIMEOUT_MS || 90000) || 90000);
  }

  enqueue(task = {}) {
    const query = normalizeText(task.query || task.question);
    if (!this.isEnabled() || !query) {
      return { enqueued: false, deduped: false, task: null, reason: !query ? 'empty-query' : 'disabled' };
    }
    const key = buildTaskKey({ ...task, query });
    const existing = this.tasksByKey.get(key);
    if (existing && (existing.status === 'queued' || existing.status === 'running')) {
      return { enqueued: false, deduped: true, task: existing, reason: 'deduped' };
    }
    const now = Date.now();
    const record = {
      id: `research_${now}_${Math.random().toString(16).slice(2, 8)}`,
      key,
      query,
      sessionKey: normalizeText(task.sessionKey),
      userId: normalizeText(task.userId),
      routeMeta: task.routeMeta && typeof task.routeMeta === 'object' ? { ...task.routeMeta } : {},
      status: 'queued',
      createdAt: new Date(now).toISOString(),
      startedAt: '',
      finishedAt: '',
      result: null,
      error: ''
    };
    this.tasksByKey.set(key, record);
    this.pending.push(record);
    this.drain();
    return { enqueued: true, deduped: false, task: record, reason: 'queued' };
  }

  drain() {
    while (this.activeCount < this.getMaxConcurrency() && this.pending.length > 0) {
      const record = this.pending.shift();
      if (!record || record.status !== 'queued') continue;
      this.runRecord(record);
    }
  }

  runRecord(record) {
    this.activeCount += 1;
    record.status = 'running';
    record.startedAt = new Date().toISOString();
    const timeoutMs = this.getTimeoutMs();
    Promise.race([
      this.runner(record, {
        maxToolRounds: this.config.RESEARCH_SUBAGENT_MAX_TOOL_ROUNDS,
        cacheTtlMs: this.config.RESEARCH_SUBAGENT_CACHE_TTL_MS
      }),
      createTimeoutPromise(timeoutMs)
    ]).then((result) => {
      record.status = 'completed';
      record.result = result;
      record.finishedAt = new Date().toISOString();
    }).catch((error) => {
      record.status = 'failed';
      record.error = String(error?.message || error || 'unknown error').slice(0, 500);
      record.finishedAt = new Date().toISOString();
      saveResearchBrief({
        sessionKey: record.sessionKey,
        userId: record.userId,
        query: record.query,
        status: 'failed',
        error: record.error,
        summary: ''
      });
    }).finally(() => {
      this.activeCount = Math.max(0, this.activeCount - 1);
      this.drain();
    });
  }

  getTask(key = '') {
    return this.tasksByKey.get(normalizeText(key)) || null;
  }

  reset() {
    this.tasksByKey.clear();
    this.pending = [];
    this.activeCount = 0;
  }
}

const defaultResearchTaskQueue = new ResearchTaskQueue();

function enqueueResearchTask(task = {}) {
  return defaultResearchTaskQueue.enqueue(task);
}

module.exports = {
  ResearchTaskQueue,
  buildTaskKey,
  defaultResearchTaskQueue,
  enqueueResearchTask
};
