const fs = require('fs');
const path = require('path');
const config = require('../../config');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function normalizeObject(value, fallback = {}) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
}

function getTraceDir(options = {}) {
  return normalizeText(options.traceDir || config.POST_REPLY_TRACE_DIR)
    || path.join(config.DATA_DIR, 'post_reply_traces');
}

function getTracePath(jobOrId = '', options = {}) {
  const jobId = normalizeText(typeof jobOrId === 'object' ? jobOrId.jobId : jobOrId);
  if (!jobId) return '';
  return path.join(getTraceDir(options), `${jobId}.jsonl`);
}

function sanitizeTracePayload(payload = {}) {
  const source = normalizeObject(payload, {});
  const out = {};
  for (const [key, value] of Object.entries(source)) {
    if (/api[_-]?key|token|secret|password/i.test(key)) {
      out[key] = '[redacted]';
    } else if (typeof value === 'string') {
      out[key] = value.length > 1200 ? `${value.slice(0, 1200)}...` : value;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function appendPostReplyJobTrace(jobOrId = '', event = '', payload = {}, options = {}) {
  const job = typeof jobOrId === 'object' && jobOrId ? jobOrId : {};
  const jobId = normalizeText(job.jobId || jobOrId);
  if (!jobId) return { written: false, reason: 'missing_job_id' };
  const tracePath = getTracePath(jobId, options);
  const entry = {
    ts: new Date().toISOString(),
    jobId,
    traceId: normalizeText(job.traceId),
    phase: normalizeText(job.phase),
    event: normalizeText(event) || 'event',
    payload: sanitizeTracePayload(payload)
  };
  try {
    fs.mkdirSync(path.dirname(tracePath), { recursive: true });
    fs.appendFileSync(tracePath, `${JSON.stringify(entry)}\n`, 'utf8');
    return { written: true, tracePath };
  } catch (error) {
    return {
      written: false,
      reason: error?.message || String(error)
    };
  }
}

function readPostReplyJobTrace(jobId = '', options = {}) {
  const tracePath = getTracePath(jobId, options);
  if (!tracePath || !fs.existsSync(tracePath)) return [];
  return String(fs.readFileSync(tracePath, 'utf8') || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch (_) {
        return null;
      }
    })
    .filter(Boolean);
}

function summarizePostReplyJobTrace(jobId = '', options = {}) {
  const events = readPostReplyJobTrace(jobId, options);
  const countsByEvent = {};
  for (const event of events) {
    const key = normalizeText(event.event) || 'event';
    countsByEvent[key] = (countsByEvent[key] || 0) + 1;
  }
  return {
    jobId: normalizeText(jobId),
    tracePath: getTracePath(jobId, options),
    eventCount: events.length,
    firstEventAt: events[0]?.ts || '',
    lastEventAt: events[events.length - 1]?.ts || '',
    countsByEvent,
    events
  };
}

module.exports = {
  appendPostReplyJobTrace,
  getTraceDir,
  getTracePath,
  readPostReplyJobTrace,
  summarizePostReplyJobTrace
};
