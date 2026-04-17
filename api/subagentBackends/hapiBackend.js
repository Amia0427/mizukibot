const axios = require('axios');
const config = require('../../config');
const { buildForwardPrompt } = require('./commandBackend');
const { getHapiControlRuntime } = require('../../utils/hapiControlRuntime');
const { detectSensitiveOutput } = require('../../utils/promptSecurity');

function normalizeText(value = '') {
  return String(value || '').trim();
}

function buildBaseUrl() {
  return normalizeText(config.HAPI_BASE_URL).replace(/\/+$/, '');
}

function buildHeaders() {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream, */*'
  };
  const token = normalizeText(config.HAPI_AUTH_TOKEN);
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function createHttpClient(timeoutMs) {
  return axios.create({
    baseURL: buildBaseUrl(),
    headers: buildHeaders(),
    timeout: Math.max(10000, Number(timeoutMs) || Number(config.HAPI_TIMEOUT_MS) || 180000),
    proxy: false
  });
}

function routeLooksCoding(routePolicyKey = '', topRouteType = '') {
  const policy = normalizeText(routePolicyKey).toLowerCase();
  const top = normalizeText(topRouteType).toLowerCase();
  if (policy === 'admin/full') return true;
  if (top === 'admin') return true;
  return /(?:act|tool|plan)\//i.test(policy);
}

function resolveMachineId(options = {}) {
  const explicit = normalizeText(options?.hapiMachineId || options?.machineId);
  if (explicit) return explicit;
  const routePolicyKey = normalizeText(options?.routePolicyKey);
  const topRouteType = normalizeText(options?.topRouteType);
  if (routePolicyKey === 'tool/review') return normalizeText(config.HAPI_CLAUDE_MACHINE) || 'claude-local';
  if (/(review|summary|rewrite|answer)$/i.test(routePolicyKey)) {
    return normalizeText(config.HAPI_CLAUDE_MACHINE) || 'claude-local';
  }
  if (routeLooksCoding(routePolicyKey, topRouteType)) {
    return normalizeText(config.HAPI_CODEX_MACHINE) || 'codex-local';
  }
  return normalizeText(config.HAPI_DEFAULT_MACHINE) || 'claude-local';
}

function buildForwardedMessage(question, customPrompt = null, imageUrl = null, options = {}) {
  const routePrompt = normalizeText(options?.subagentRoutePrompt || options?.routePrompt) || null;
  return buildForwardPrompt(question, customPrompt, imageUrl, routePrompt);
}

function parseSseEvents(raw = '') {
  const text = String(raw || '');
  const chunks = text.split(/\r?\n\r?\n/).map((item) => item.trim()).filter(Boolean);
  const events = [];
  for (const chunk of chunks) {
    const lines = chunk.split(/\r?\n/);
    let type = 'message';
    const dataLines = [];
    for (const line of lines) {
      if (/^event:/i.test(line)) {
        type = line.replace(/^event:/i, '').trim() || 'message';
        continue;
      }
      if (/^data:/i.test(line)) {
        dataLines.push(line.replace(/^data:/i, '').trim());
      }
    }
    const payloadText = dataLines.join('\n').trim();
    let payload = payloadText;
    if (payloadText) {
      try {
        payload = JSON.parse(payloadText);
      } catch (_) {}
    }
    events.push({ type, payload });
  }
  return events;
}

function readEventText(event = {}) {
  const payload = event?.payload;
  if (typeof payload === 'string') return payload.trim();
  if (!payload || typeof payload !== 'object') return '';
  const candidates = [
    payload.text,
    payload.message,
    payload.output,
    payload.summary,
    payload.delta,
    payload?.data?.text,
    payload?.data?.message,
    payload?.result?.text,
    payload?.result?.message
  ];
  for (const item of candidates) {
    const text = normalizeText(item);
    if (text) return text;
  }
  return '';
}

function normalizeEventType(event = {}) {
  const base = normalizeText(event?.type).toLowerCase();
  const payloadType = normalizeText(event?.payload?.type || event?.payload?.event || event?.payload?.status).toLowerCase();
  const candidate = base || payloadType || 'message';
  if (/(permission|approval)/i.test(candidate)) return 'approval_request';
  if (/(done|complete|completed|finished|final)/i.test(candidate)) return 'done';
  if (/(error|failed|failure)/i.test(candidate)) return 'error';
  if (/(message|delta|chunk|output)/i.test(candidate)) return 'message';
  return 'message';
}

function buildApprovalSummary(event = {}) {
  const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
  return normalizeText(payload.summary || payload.message || payload.reason || payload.text) || 'remote permission request';
}

async function ensureSession(client, sessionId, machineId, options = {}) {
  const payload = {
    sessionId,
    machineId,
    cwd: normalizeText(options?.workspaceRoot || config.HAPI_WORKSPACE_ROOT),
    metadata: {
      routePolicyKey: normalizeText(options?.routePolicyKey),
      topRouteType: normalizeText(options?.topRouteType),
      userId: normalizeText(options?.userId),
      groupId: normalizeText(options?.groupId),
      taskId: normalizeText(options?.backgroundTaskId)
    }
  };

  try {
    await client.post(`/api/machines/${encodeURIComponent(machineId)}/spawn`, payload);
  } catch (error) {
    const status = Number(error?.response?.status);
    if (status !== 409 && status !== 422) throw error;
  }
}

async function postSessionMessage(client, sessionId, body = {}, requestOptions = {}) {
  return client.post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, body, {
    responseType: config.HAPI_STREAM !== false ? 'stream' : 'json'
    ,
    ...requestOptions
  });
}

async function readStreamToString(stream) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let buffer = '';
    const done = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) return reject(error);
      resolve(buffer);
    };

    stream.on('data', (chunk) => {
      buffer += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    });
    stream.once('end', () => done());
    stream.once('close', () => done());
    stream.once('error', (error) => done(error));
  });
}

async function approveOrDeny(client, sessionId, approval = {}, resolution = 'approve') {
  const requestId = normalizeText(approval?.request_id || approval?.id);
  if (!requestId) {
    throw new Error('missing approval request id');
  }
  const action = resolution === 'approve' ? 'approve' : 'deny';
  await client.post(
    `/api/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(requestId)}/${action}`,
    { note: normalizeText(approval?.resolution_note || '') || `${action}d by mizuki` }
  );
}

function chooseFinalText(events = []) {
  const texts = [];
  for (const event of events) {
    const type = normalizeEventType(event);
    if (type !== 'message' && type !== 'done') continue;
    const text = readEventText(event);
    if (text) texts.push(text);
  }
  return texts.join('\n').trim();
}

function normalizeHapiError(error) {
  const status = Number(error?.response?.status);
  if (status === 401 || status === 403) return new Error(`hapi unauthorized (${status})`);
  if (status === 404) return new Error('hapi endpoint or session not found (404)');
  if (status === 409) return new Error('hapi session conflict (409)');
  if (status >= 500) return new Error(`hapi server error (${status})`);
  if (error?.code === 'ERR_CANCELED') {
    const err = new Error('hapi cancelled');
    err.code = 'SUBAGENT_CANCELLED';
    return err;
  }
  return error instanceof Error ? error : new Error(String(error || 'hapi request failed'));
}

function createHapiBridgeCall({ question, sessionId, customPrompt = null, imageUrl = null, options = {} } = {}) {
  const baseUrl = buildBaseUrl();
  if (!baseUrl) {
    throw new Error('HAPI_BASE_URL is empty');
  }
  if (!sessionId) {
    throw new Error('hapi sessionId is empty');
  }

  const machineId = resolveMachineId(options);
  const message = buildForwardedMessage(question, customPrompt, imageUrl, options);
  const client = createHttpClient(options?.timeoutMs || config.HAPI_TIMEOUT_MS);
  const controlRuntime = getHapiControlRuntime();
  const groupId = normalizeText(options?.routeMeta?.groupId || options?.groupId);
  const userId = normalizeText(options?.userId || options?.routeMeta?.userId);
  const taskId = normalizeText(options?.backgroundTaskId);

  controlRuntime.upsertSession({
    session_id: sessionId,
    machine_id: machineId,
    user_id: userId,
    group_id: groupId,
    task_id: taskId,
    route_policy_key: normalizeText(options?.routePolicyKey),
    status: 'starting'
  });

  let abortController = null;
  let cancelled = false;

  const promise = (async () => {
    try {
      await ensureSession(client, sessionId, machineId, {
        workspaceRoot: options?.workspaceRoot || config.HAPI_WORKSPACE_ROOT,
        routePolicyKey: options?.routePolicyKey,
        topRouteType: options?.topRouteType,
        userId,
        groupId,
        backgroundTaskId: taskId
      });

      controlRuntime.markSessionEvent(sessionId, {
        machine_id: machineId,
        user_id: userId,
        group_id: groupId,
        task_id: taskId,
        route_policy_key: normalizeText(options?.routePolicyKey),
        status: 'running',
        last_event_type: 'message'
      });

      abortController = new AbortController();
      const response = await postSessionMessage(client, sessionId, {
        message,
        machineId,
        stream: config.HAPI_STREAM !== false,
        approvalMode: normalizeText(config.HAPI_APPROVAL_MODE || 'manual') || 'manual',
        metadata: {
          routePolicyKey: normalizeText(options?.routePolicyKey),
          topRouteType: normalizeText(options?.topRouteType),
          taskId,
          userId,
          groupId
        }
      }, {
        signal: abortController.signal
      });

      let events = [];
      if (config.HAPI_STREAM !== false) {
        const raw = await readStreamToString(response?.data);
        events = parseSseEvents(raw);
      } else {
        const payload = response?.data;
        events = Array.isArray(payload?.events)
          ? payload.events.map((item) => ({ type: item?.type || 'message', payload: item }))
          : [{ type: 'done', payload }];
      }

      for (const event of events) {
        const eventType = normalizeEventType(event);
        if (eventType === 'approval_request') {
          const payload = event?.payload && typeof event.payload === 'object' ? event.payload : {};
          const created = controlRuntime.createApproval({
            request_id: normalizeText(payload.requestId || payload.id),
            session_id: sessionId,
            task_id: taskId,
            user_id: userId,
            group_id: groupId,
            machine_id: machineId,
            summary: buildApprovalSummary(event),
            title: normalizeText(payload.title || '远程权限请求'),
            raw_event: payload
          });

          if (normalizeText(config.HAPI_APPROVAL_MODE).toLowerCase() !== 'manual') {
            const resolution = normalizeText(config.HAPI_APPROVAL_MODE).toLowerCase() === 'approve' ? 'approve' : 'deny';
            await approveOrDeny(client, sessionId, created, resolution);
            controlRuntime.resolveApproval(created.id, resolution, `auto ${resolution}`);
          }
        } else if (eventType === 'error') {
          const errorText = readEventText(event) || buildApprovalSummary(event) || 'hapi remote task failed';
          controlRuntime.markSessionEvent(sessionId, {
            status: 'failed',
            last_event_type: 'error',
            latest_error: errorText
          });
          throw new Error(errorText);
        } else {
          controlRuntime.markSessionEvent(sessionId, {
            status: eventType === 'done' ? 'idle' : 'running',
            last_event_type: eventType,
            latest_summary: readEventText(event) || undefined
          });
        }
      }

      if (cancelled) {
        const err = new Error('hapi cancelled');
        err.code = 'SUBAGENT_CANCELLED';
        throw err;
      }

      const finalText = chooseFinalText(events);
      if (!finalText) {
        throw new Error('hapi returned empty reply');
      }
      if (detectSensitiveOutput(finalText).blocked) {
        throw new Error('hapi returned sensitive output');
      }
      controlRuntime.markSessionEvent(sessionId, {
        status: 'idle',
        last_event_type: 'done',
        latest_summary: finalText
      });
      return finalText;
    } catch (error) {
      throw normalizeHapiError(error);
    }
  })();

  return {
    promise,
    cancel(reason = 'cancelled') {
      cancelled = true;
      controlRuntime.markSessionEvent(sessionId, {
        status: 'aborting',
        last_event_type: 'abort'
      });
      if (abortController) {
        try { abortController.abort(); } catch (_) {}
      }
      void client.post(`/api/sessions/${encodeURIComponent(sessionId)}/abort`, {
        reason: normalizeText(reason) || 'cancelled'
      }).catch(() => {});
      return reason;
    }
  };
}

module.exports = {
  createHapiBridgeCall,
  parseSseEvents,
  resolveMachineId,
  normalizeEventType,
  chooseFinalText
};
