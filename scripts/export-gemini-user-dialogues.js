#!/usr/bin/env node

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const readline = require('readline');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(PROJECT_ROOT, 'data');
const DEFAULT_MODEL_PATTERN = 'gemini';
const DEFAULT_HOURS = 24;

function normalizeText(value) {
  return String(value || '').trim();
}

function parseNumber(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function parseDateLike(value) {
  const text = normalizeText(value);
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const num = Number(text);
    if (!Number.isFinite(num)) return null;
    return num > 100000000000 ? num : num * 1000;
  }
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : null;
}

function takeArgValue(argv, index) {
  const item = String(argv[index] || '');
  const eq = item.indexOf('=');
  if (eq >= 0) return { value: item.slice(eq + 1), consumed: 0 };
  return { value: argv[index + 1], consumed: 1 };
}

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dataDir: DEFAULT_DATA_DIR,
    hours: DEFAULT_HOURS,
    since: null,
    until: Date.now(),
    out: '',
    format: '',
    modelPattern: DEFAULT_MODEL_PATTERN,
    includeSelfCheck: false,
    successOnly: false,
    requireMessage: false,
    help: false
  };

  for (let i = 0; i < argv.length; i += 1) {
    const item = String(argv[i] || '');
    const key = item.split('=')[0];
    if (key === '--help' || key === '-h') {
      options.help = true;
    } else if (key === '--data-dir') {
      const { value, consumed } = takeArgValue(argv, i);
      options.dataDir = path.resolve(String(value || ''));
      i += consumed;
    } else if (key === '--hours') {
      const { value, consumed } = takeArgValue(argv, i);
      options.hours = Math.max(1, parseNumber(value, DEFAULT_HOURS));
      i += consumed;
    } else if (key === '--since') {
      const { value, consumed } = takeArgValue(argv, i);
      options.since = parseDateLike(value);
      i += consumed;
    } else if (key === '--until') {
      const { value, consumed } = takeArgValue(argv, i);
      options.until = parseDateLike(value) || options.until;
      i += consumed;
    } else if (key === '--out') {
      const { value, consumed } = takeArgValue(argv, i);
      options.out = String(value || '');
      i += consumed;
    } else if (key === '--format') {
      const { value, consumed } = takeArgValue(argv, i);
      options.format = normalizeText(value).toLowerCase();
      i += consumed;
    } else if (key === '--model-pattern') {
      const { value, consumed } = takeArgValue(argv, i);
      options.modelPattern = normalizeText(value) || DEFAULT_MODEL_PATTERN;
      i += consumed;
    } else if (key === '--include-self-check') {
      options.includeSelfCheck = true;
    } else if (key === '--success-only') {
      options.successOnly = true;
    } else if (key === '--require-message') {
      options.requireMessage = true;
    }
  }

  if (!options.since) {
    options.since = options.until - options.hours * 60 * 60 * 1000;
  }
  if (!options.format) {
    options.format = /\.json$/i.test(options.out) ? 'json' : 'jsonl';
  }
  if (!new Set(['jsonl', 'json']).has(options.format)) {
    throw new Error(`unsupported --format: ${options.format}`);
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/export-gemini-user-dialogues.js [options]',
    '',
    'Options:',
    '  --hours <n>              Export the last n hours, default 24.',
    '  --since <iso|epoch>      Export from this time instead of --hours.',
    '  --until <iso|epoch>      Export until this time, default now.',
    '  --out <path>             Output file, default data/exports/gemini-user-dialogues-*.jsonl.',
    '  --format <jsonl|json>    Output format, default jsonl.',
    '  --model-pattern <regex>  Model/provider pattern, default gemini.',
    '  --include-self-check     Include model_self_check rows.',
    '  --success-only           Keep only successful Gemini calls.',
    '  --require-message        Drop rows that cannot be matched to a user message.'
  ].join('\n'));
}

async function listMatchingFiles(dir, baseName) {
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name !== baseName && !entry.name.startsWith(`${baseName}.`)) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat) continue;
    files.push({ path: fullPath, name: entry.name, mtimeMs: stat.mtimeMs, size: stat.size });
  }
  return files.sort((a, b) => a.name.localeCompare(b.name));
}

async function forEachJsonl(files, onRow) {
  const stats = {
    files: files.map((file) => file.path),
    rows: 0,
    parsedRows: 0,
    invalidRows: 0
  };

  for (const file of files) {
    const stream = fs.createReadStream(file.path, { encoding: 'utf8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity
    });
    let lineNo = 0;
    for await (const line of rl) {
      lineNo += 1;
      if (!line.trim()) continue;
      stats.rows += 1;
      try {
        const row = JSON.parse(line);
        stats.parsedRows += 1;
        await onRow(row, { file: file.path, lineNo });
      } catch (_) {
        stats.invalidRows += 1;
      }
    }
  }

  return stats;
}

function rowTimeMs(row) {
  const direct = Date.parse(row.ts || row.completed_at || row.started_at || row.recordedAt || '');
  if (Number.isFinite(direct)) return direct;
  const raw = Number(row.time || row.rawMessageTimestampMs || row.requestStartedAt || 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 100000000000 ? raw : raw * 1000;
}

function isGeminiCall(row, pattern) {
  const haystack = [
    row.model,
    row.provider,
    row.api_base_url,
    row.api_base_url_host,
    row.host,
    row.model_route_diagnostic?.model,
    row.model_route_diagnostic?.provider,
    row.model_route_diagnostic?.apiBaseUrlHost
  ].map((item) => normalizeText(item)).join(' ');
  return pattern.test(haystack);
}

function isSelfCheck(row) {
  const source = normalizeText(row.source).toLowerCase();
  const userId = normalizeText(row.user_id || row.userId);
  return source.includes('self_check') || userId === '__model_self_check_user__';
}

function compactModelCall(row) {
  const tokenBudget = row.prompt_integrity?.token_budget || {};
  return {
    id: normalizeText(row.id),
    ts: normalizeText(row.ts || row.completed_at || row.started_at),
    status: normalizeText(row.status),
    source: normalizeText(row.source),
    phase: normalizeText(row.phase),
    purpose: normalizeText(row.purpose),
    provider: normalizeText(row.provider),
    model: normalizeText(row.model),
    stream: row.stream === true,
    host: normalizeText(row.host || row.api_base_url_host),
    api_base_url_host: normalizeText(row.api_base_url_host),
    route_policy_key: normalizeText(row.route_policy_key),
    route_debug_key: normalizeText(row.route_debug_key),
    top_route_type: normalizeText(row.top_route_type),
    dispatch_branch: normalizeText(row.dispatch_branch),
    trigger_branch: normalizeText(row.trigger_branch),
    status_code: Number(row.status_code || 0) || null,
    attempts: Number(row.attempts || 0) || null,
    duration_ms: Number(row.duration_ms || 0) || null,
    error: normalizeText(row.error),
    final_error_code: normalizeText(row.final_error_code),
    usage: row.usage || null,
    prompt: {
      message_count: Number(row.message_count || 0) || 0,
      memory_injected: row.memory_injected === true,
      estimated_input_tokens: Number(tokenBudget.estimated_input_tokens || 0) || 0,
      has_system_prompt: row.prompt_integrity?.has_system_prompt === true,
      has_retrieved_memory: row.prompt_integrity?.has_retrieved_memory === true,
      has_daily_journal: row.prompt_integrity?.has_daily_journal === true,
      has_short_term_continuity: row.prompt_integrity?.has_short_term_continuity === true
    }
  };
}

async function collectGeminiCalls(options) {
  const pattern = new RegExp(options.modelPattern, 'i');
  const files = await listMatchingFiles(options.dataDir, 'model-calls.ndjson');
  const calls = [];
  const stats = await forEachJsonl(files, (row) => {
    const time = rowTimeMs(row);
    if (!time || time < options.since || time > options.until) return;
    if (!isGeminiCall(row, pattern)) return;
    if (!options.includeSelfCheck && isSelfCheck(row)) return;
    if (!options.includeSelfCheck && !normalizeText(row.request_id || row.requestId)) return;
    if (options.successOnly && normalizeText(row.status) !== 'succeeded') return;
    calls.push({
      ...compactModelCall(row),
      request_id: normalizeText(row.request_id || row.requestId),
      user_id: normalizeText(row.user_id || row.userId),
      user_role: normalizeText(row.user_role || row.userRole),
      _timeMs: time
    });
  });
  return { calls, stats };
}

function mergeTrace(target, row) {
  const traceTime = rowTimeMs(row);
  if (!target.first_trace_at_ms || (traceTime && traceTime < target.first_trace_at_ms)) {
    target.first_trace_at_ms = traceTime || target.first_trace_at_ms || 0;
  }
  if (!target.request_started_at_ms && Number(row.requestStartedAt || 0) > 0) {
    target.request_started_at_ms = Number(row.requestStartedAt);
  }
  const simpleFields = [
    ['message_id', row.messageId || row.message_id],
    ['group_id', row.groupId || row.group_id],
    ['user_id', row.userId || row.user_id],
    ['chat_type', row.chatType || row.messageType],
    ['route_policy_key', row.routePolicyKey],
    ['route_debug_key', row.routeDebugKey],
    ['top_route_type', row.topRouteType],
    ['dispatch_branch', row.dispatchBranch],
    ['trigger_branch', row.triggerBranch]
  ];
  for (const [key, value] of simpleFields) {
    if (!target[key] && normalizeText(value)) target[key] = normalizeText(value);
  }
  if (row.isAdmin === true) target.is_admin = true;
  if (!target.raw_message_time_ms && Number(row.rawMessageTimestampMs || 0) > 0) {
    target.raw_message_time_ms = Number(row.rawMessageTimestampMs);
  }
  if (!target.message_ingress_recorded_at && normalizeText(row.recordedAt) && normalizeText(row.tracePhase) === 'message_ingress') {
    target.message_ingress_recorded_at = normalizeText(row.recordedAt);
  }
}

async function collectRequestTraces(options, requestIds) {
  const files = await listMatchingFiles(options.dataDir, 'request-trace.ndjson');
  const byRequestId = new Map();
  const stats = await forEachJsonl(files, (row) => {
    const requestId = normalizeText(row.requestId || row.request_id);
    if (!requestId || !requestIds.has(requestId)) return;
    if (!byRequestId.has(requestId)) {
      byRequestId.set(requestId, {
        request_id: requestId,
        is_admin: false
      });
    }
    mergeTrace(byRequestId.get(requestId), row);
  });
  return { traces: byRequestId, stats };
}

function stripCq(raw) {
  return normalizeText(raw)
    .replace(/\[CQ:at,qq=([^\],]+)[^\]]*\]/g, '@$1 ')
    .replace(/\[CQ:image,[^\]]*\]/g, '[image]')
    .replace(/\[CQ:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanMessageText(row) {
  if (Array.isArray(row.message)) {
    const parts = row.message.map((part) => {
      const type = normalizeText(part?.type).toLowerCase();
      if (type === 'text') return normalizeText(part?.data?.text);
      if (type === 'at') return `@${normalizeText(part?.data?.qq)}`;
      if (type === 'image') return '[image]';
      if (type) return `[${type}]`;
      return '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
  return stripCq(row.raw_message);
}

function compactMessage(row) {
  const chatType = normalizeText(row.message_type).toLowerCase() === 'private' ? 'private' : 'group';
  const sender = row.sender && typeof row.sender === 'object' ? row.sender : {};
  const messageSegments = Array.isArray(row.message)
    ? row.message.map((part) => ({
      type: normalizeText(part?.type),
      data: part?.data && typeof part.data === 'object' ? part.data : {}
    }))
    : [];
  const timeMs = Number(row.time || 0) > 0 ? Number(row.time) * 1000 : 0;
  return {
    message_id: normalizeText(row.message_id),
    message_time: timeMs ? new Date(timeMs).toISOString() : '',
    _timeMs: timeMs,
    chat_type: chatType,
    group_id: normalizeText(row.group_id),
    group_name: normalizeText(row.group_name),
    user_id: normalizeText(row.user_id),
    sender: {
      user_id: normalizeText(sender.user_id || row.user_id),
      nickname: normalizeText(sender.nickname || sender.nick),
      card: normalizeText(sender.card),
      role: normalizeText(sender.role)
    },
    raw_message: normalizeText(row.raw_message),
    clean_text: cleanMessageText(row),
    message_segments: messageSegments
  };
}

function messageCompositeKey(chatType, groupId, userId, messageId) {
  return [normalizeText(chatType), normalizeText(groupId), normalizeText(userId), normalizeText(messageId)].join('|');
}

async function collectMessages(options) {
  const messageFile = path.join(options.dataDir, 'napcat-message-events.jsonl');
  const exists = await fsp.stat(messageFile).then((stat) => stat.isFile()).catch(() => false);
  const messages = [];
  const byComposite = new Map();
  const byMessageId = new Map();
  if (!exists) {
    return {
      messages,
      byComposite,
      byMessageId,
      stats: { files: [], rows: 0, parsedRows: 0, invalidRows: 0 }
    };
  }

  const minMessageTime = options.since - 2 * 60 * 60 * 1000;
  const maxMessageTime = options.until + 2 * 60 * 60 * 1000;
  const stats = await forEachJsonl([{ path: messageFile, name: path.basename(messageFile) }], (row) => {
    if (normalizeText(row.post_type) !== 'message') return;
    const chatType = normalizeText(row.message_type).toLowerCase();
    if (chatType !== 'group' && chatType !== 'private') return;
    const timeMs = Number(row.time || 0) > 0 ? Number(row.time) * 1000 : 0;
    if (timeMs && (timeMs < minMessageTime || timeMs > maxMessageTime)) return;
    const msg = compactMessage(row);
    messages.push(msg);
    if (msg.message_id) {
      byMessageId.set(msg.message_id, msg);
      byComposite.set(messageCompositeKey(msg.chat_type, msg.group_id, msg.user_id, msg.message_id), msg);
    }
  });

  return { messages, byComposite, byMessageId, stats };
}

function findMessageForTrace(trace, messageIndex, allMessages, firstCallTimeMs) {
  if (!trace) return { message: null, source: 'none' };
  const messageId = normalizeText(trace.message_id);
  const compositeKey = messageCompositeKey(trace.chat_type, trace.group_id, trace.user_id, messageId);
  if (messageId && messageIndex.byComposite.has(compositeKey)) {
    return { message: messageIndex.byComposite.get(compositeKey), source: 'request_trace+napcat_composite' };
  }
  if (messageId && messageIndex.byMessageId.has(messageId)) {
    return { message: messageIndex.byMessageId.get(messageId), source: 'request_trace+napcat_message_id' };
  }

  const traceTime = Number(trace.raw_message_time_ms || trace.request_started_at_ms || firstCallTimeMs || 0);
  let best = null;
  let bestDelta = Infinity;
  for (const msg of allMessages) {
    if (trace.user_id && msg.user_id !== trace.user_id) continue;
    if (trace.group_id && msg.group_id !== trace.group_id) continue;
    if (trace.chat_type && msg.chat_type !== trace.chat_type) continue;
    const delta = Math.abs(Number(msg._timeMs || 0) - traceTime);
    if (delta < bestDelta) {
      best = msg;
      bestDelta = delta;
    }
  }
  if (best && bestDelta <= 10 * 60 * 1000) {
    return { message: best, source: 'request_trace+nearest_napcat_message' };
  }
  return { message: null, source: trace ? 'request_trace_only' : 'none' };
}

async function collectAssistantReplies(options, requestIds) {
  const replies = new Map();
  const dir = path.join(options.dataDir, 'langgraph_v2_events');
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  const minMtime = options.since - 2 * 60 * 60 * 1000;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const fullPath = path.join(dir, entry.name);
    const stat = await fsp.stat(fullPath).catch(() => null);
    if (!stat || stat.mtimeMs < minMtime) continue;
    let events = null;
    try {
      events = JSON.parse(await fsp.readFile(fullPath, 'utf8'));
    } catch (_) {
      continue;
    }
    if (!Array.isArray(events)) continue;
    let activeRequestId = '';
    for (const event of events) {
      const requestId = normalizeText(event?.requestId || event?.request_id);
      if (requestId && requestIds.has(requestId)) activeRequestId = requestId;
      if (!activeRequestId) continue;
      if (normalizeText(event?.type) === 'persist_complete' && normalizeText(event?.finalReplyPreview)) {
        replies.set(activeRequestId, {
          assistant_reply_preview: normalizeText(event.finalReplyPreview),
          source_file: fullPath
        });
      }
    }
  }
  return replies;
}

function uniqueSorted(values) {
  return Array.from(new Set(values.map((value) => normalizeText(value)).filter(Boolean))).sort();
}

function summarizeCalls(calls) {
  const statuses = {};
  for (const call of calls) {
    const status = call.status || 'unknown';
    statuses[status] = (statuses[status] || 0) + 1;
  }
  return statuses;
}

function buildRecords({ groupedCalls, traces, messages, assistantReplies, requireMessage }) {
  const records = [];
  for (const [requestId, calls] of groupedCalls.entries()) {
    calls.sort((a, b) => a._timeMs - b._timeMs);
    const trace = traces.get(requestId) || null;
    const firstCallTime = calls[0]?._timeMs || 0;
    const { message, source } = findMessageForTrace(trace, messages, messages.messages, firstCallTime);
    if (requireMessage && !message) continue;
    const reply = assistantReplies.get(requestId) || null;
    const routeFromCall = calls.find((call) => call.route_policy_key || call.top_route_type || call.dispatch_branch) || {};
    const callPayloads = calls.map((call) => {
      const { _timeMs, request_id, user_id, user_role, ...payload } = call;
      return payload;
    });
    records.push({
      type: 'conversation',
      request_id: requestId,
      message_id: message?.message_id || trace?.message_id || '',
      message_time: message?.message_time || (trace?.raw_message_time_ms ? new Date(trace.raw_message_time_ms).toISOString() : ''),
      chat_type: message?.chat_type || trace?.chat_type || '',
      group_id: message?.group_id || trace?.group_id || '',
      group_name: message?.group_name || '',
      user_id: message?.user_id || trace?.user_id || calls[0]?.user_id || '',
      user_role: calls.find((call) => call.user_role)?.user_role || '',
      is_admin: trace?.is_admin === true,
      sender: message?.sender || null,
      raw_message: message?.raw_message || '',
      clean_text: message?.clean_text || '',
      message_segments: message?.message_segments || [],
      assistant_reply_preview: reply?.assistant_reply_preview || '',
      route: {
        route_policy_key: trace?.route_policy_key || routeFromCall.route_policy_key || '',
        route_debug_key: trace?.route_debug_key || routeFromCall.route_debug_key || '',
        top_route_type: trace?.top_route_type || routeFromCall.top_route_type || '',
        dispatch_branch: trace?.dispatch_branch || routeFromCall.dispatch_branch || '',
        trigger_branch: trace?.trigger_branch || routeFromCall.trigger_branch || ''
      },
      gemini_models: uniqueSorted(calls.map((call) => call.model)),
      gemini_call_count: calls.length,
      gemini_call_statuses: summarizeCalls(calls),
      gemini_calls: callPayloads,
      match: {
        source,
        has_request_trace: Boolean(trace),
        has_napcat_message: Boolean(message),
        has_assistant_reply_preview: Boolean(reply?.assistant_reply_preview)
      }
    });
  }
  records.sort((a, b) => {
    const at = Date.parse(a.message_time || '') || Date.parse(a.gemini_calls?.[0]?.ts || '') || 0;
    const bt = Date.parse(b.message_time || '') || Date.parse(b.gemini_calls?.[0]?.ts || '') || 0;
    return at - bt;
  });
  return records;
}

function defaultOutPath(options) {
  const stamp = new Date().toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/[-:]/g, '')
    .replace('T', '-');
  const ext = options.format === 'json' ? 'json' : 'jsonl';
  return path.join(options.dataDir || DEFAULT_DATA_DIR, 'exports', `gemini-user-dialogues-${stamp}.${ext}`);
}

async function writeOutput(options, metadata, records) {
  const outPath = path.resolve(options.out || defaultOutPath(options));
  await fsp.mkdir(path.dirname(outPath), { recursive: true });
  if (options.format === 'json') {
    await fsp.writeFile(outPath, `${JSON.stringify({ ...metadata, records }, null, 2)}\n`, 'utf8');
  } else {
    const lines = [
      JSON.stringify({ type: 'metadata', ...metadata }),
      ...records.map((record) => JSON.stringify(record))
    ];
    await fsp.writeFile(outPath, `${lines.join('\n')}\n`, 'utf8');
  }
  return outPath;
}

async function run() {
  const options = parseArgs();
  if (options.help) {
    printHelp();
    return;
  }

  const modelResult = await collectGeminiCalls(options);
  const groupedCalls = new Map();
  for (const call of modelResult.calls) {
    if (!groupedCalls.has(call.request_id)) groupedCalls.set(call.request_id, []);
    groupedCalls.get(call.request_id).push(call);
  }

  const requestIds = new Set(groupedCalls.keys());
  const [traceResult, messageResult, assistantReplies] = await Promise.all([
    collectRequestTraces(options, requestIds),
    collectMessages(options),
    collectAssistantReplies(options, requestIds)
  ]);

  const records = buildRecords({
    groupedCalls,
    traces: traceResult.traces,
    messages: messageResult,
    assistantReplies,
    requireMessage: options.requireMessage
  });

  const metadata = {
    exported_at: new Date().toISOString(),
    export_window: {
      since: new Date(options.since).toISOString(),
      until: new Date(options.until).toISOString(),
      hours: Math.round((options.until - options.since) / 36e5 * 100) / 100
    },
    filters: {
      model_pattern: options.modelPattern,
      include_self_check: options.includeSelfCheck,
      success_only: options.successOnly,
      require_message: options.requireMessage
    },
    summary: {
      conversation_records: records.length,
      gemini_model_calls: modelResult.calls.length,
      unique_requests: groupedCalls.size,
      matched_napcat_messages: records.filter((record) => record.match.has_napcat_message).length,
      matched_assistant_reply_previews: records.filter((record) => record.match.has_assistant_reply_preview).length,
      models: uniqueSorted(modelResult.calls.map((call) => call.model)),
      call_statuses: summarizeCalls(modelResult.calls)
    },
    sources: {
      data_dir: options.dataDir,
      model_call_files: modelResult.stats.files,
      request_trace_files: traceResult.stats.files,
      napcat_message_files: messageResult.stats.files
    }
  };

  const outPath = await writeOutput(options, metadata, records);
  console.log(JSON.stringify({
    ok: true,
    out: outPath,
    ...metadata.summary,
    since: metadata.export_window.since,
    until: metadata.export_window.until
  }, null, 2));
}

if (require.main === module) {
  run().catch((error) => {
    console.error(error?.stack || error?.message || error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildRecords,
  collectAssistantReplies,
  collectGeminiCalls,
  collectMessages,
  collectRequestTraces,
  defaultOutPath,
  parseArgs,
  run,
  writeOutput
};
