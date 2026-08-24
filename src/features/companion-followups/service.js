const path = require('path');
const config = require('../../../config');
const { normalizeWhenExpression } = require('../../../utils/scheduledTaskTime');
const { getDatePartsInTz } = require('../../../utils/time');
const { createFollowupStateStore, STATUSES } = require('./store');

const ACTIONS = new Set(['add', 'list', 'complete', 'snooze', 'abandon', 'delete']);

function normalizeText(value) {
  return String(value || '').trim();
}

function createCompanionFollowupService(options = {}) {
  const runtimeConfig = options.config || config;
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const store = options.store || createFollowupStateStore(
    runtimeConfig.COMPANION_FOLLOWUP_STATE_FILE || path.join(runtimeConfig.DATA_DIR, 'companion-followups.json'),
    { now }
  );

  function requireUserId(userId) {
    const id = normalizeText(userId);
    if (!id) throw new Error('companion follow-up requires a private userId');
    return id;
  }

  function normalizeDueAt(value) {
    const raw = normalizeText(value);
    if (!raw) return { dueAt: '', summary: '' };
    const parsed = normalizeWhenExpression(raw, {
      now: new Date(now()),
      timezone: runtimeConfig.TIMEZONE
    });
    if (parsed.kind !== 'once') throw new Error('follow-up dueAt 只支持一次性时间');
    return { dueAt: parsed.executeAt, summary: parsed.summary };
  }

  function add(userId, input = {}) {
    const ownerId = requireUserId(userId);
    const title = normalizeText(input.title);
    if (!title) throw new Error('follow-up title 不能为空');
    const { dueAt, summary } = normalizeDueAt(input.dueAt || input.due_at || input.when);
    const item = store.create(ownerId, {
      title,
      note: normalizeText(input.note).slice(0, 500),
      dueAt,
      now: now()
    });
    return { item, dueSummary: summary };
  }

  function list(userId, options = {}) {
    const ownerId = requireUserId(userId);
    const includeClosed = options.includeClosed === true;
    return store.list(ownerId, {
      statuses: includeClosed ? [] : ['open', 'snoozed']
    });
  }

  function updateStatus(userId, itemId, status, patch = {}) {
    const ownerId = requireUserId(userId);
    if (!STATUSES.has(status)) throw new Error('unsupported follow-up status');
    const item = store.update(ownerId, itemId, (current) => ({
      ...current,
      ...patch,
      status,
      completedAt: status === 'completed' ? now() : 0
    }), { now: now() });
    if (!item) throw new Error('follow-up not found');
    return item;
  }

  function execute(userId, args = {}) {
    const action = normalizeText(args.action).toLowerCase();
    if (!ACTIONS.has(action)) throw new Error('companion_followup action 不支持');
    if (action === 'add') return { action, ...add(userId, args) };
    if (action === 'list') return {
      action,
      items: list(userId, { includeClosed: args.include_closed === true || args.includeClosed === true })
    };
    if (action === 'complete') return { action, item: updateStatus(userId, args.id, 'completed') };
    if (action === 'abandon') return { action, item: updateStatus(userId, args.id, 'abandoned') };
    if (action === 'delete') {
      const removed = store.remove(requireUserId(userId), args.id);
      if (!removed) throw new Error('follow-up not found');
      return { action, id: normalizeText(args.id), removed: true };
    }
    const { dueAt, summary } = normalizeDueAt(args.dueAt || args.due_at || args.when);
    return {
      action,
      dueSummary: summary,
      item: updateStatus(userId, args.id, 'snoozed', { dueAt })
    };
  }

  function getContext(userId, timestamp = now()) {
    const items = list(userId).map((item) => ({
      id: item.id,
      title: item.title,
      note: item.note,
      dueAt: item.dueAt,
      overdue: Boolean(item.dueAt && item.dueAt < formatNow(timestamp, runtimeConfig.TIMEZONE || 'Asia/Shanghai'))
    }));
    return items;
  }

  return { execute, getContext, list, store };
}

function formatNow(timestamp, timezone = config.TIMEZONE) {
  const date = new Date(Number(timestamp) || Date.now());
  const parts = getDatePartsInTz(date, timezone);
  const pad = (value) => String(value).padStart(2, '0');
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}

module.exports = {
  ACTIONS,
  createCompanionFollowupService,
  formatNow
};
