'use strict';

const path = require('path');

const config = require('../config');
const { ALLOWED_DURATIONS } = require('../src/features/companion-room/parser');
const { escapeHtml } = require('./auth');

const ASSET_DIR = path.join(__dirname, 'companion-room');
const ACTIONS = new Set(['start', 'pause', 'resume', 'end', 'progress', 'density']);
const ACTIVITY_TYPES = new Set(['focus', 'relax']);
const CONTENT_TYPES = new Set(['', 'read', 'watch', 'listen']);
const DENSITIES = new Set(['quiet', 'occasional', 'chatty']);

function normalizeActionInput(body = {}) {
  const action = String(body.action || '').trim();
  if (!ACTIONS.has(action)) return { error: '不支持的房间操作' };
  if (['pause', 'resume', 'end'].includes(action)) return { value: { action } };
  if (action === 'progress') {
    const progress = String(body.progress || '').replace(/\s+/g, ' ').trim();
    if (!progress) return { error: '进度不能为空' };
    return { value: { action, progress: progress.slice(0, 200) } };
  }
  if (action === 'density') {
    const density = String(body.density || '').trim();
    if (!DENSITIES.has(density)) return { error: '陪伴密度无效' };
    return { value: { action, density } };
  }

  const activityType = String(body.activity_type || body.activityType || '').trim();
  const contentType = String(body.content_type || body.contentType || '').trim();
  const contentTitle = String(body.content_title || body.contentTitle || '').replace(/\s+/g, ' ').trim();
  const durationMinutes = Number(body.duration_minutes || body.durationMinutes);
  if (!ACTIVITY_TYPES.has(activityType)) return { error: '活动类型无效' };
  if (!CONTENT_TYPES.has(contentType)) return { error: '内容类型无效' };
  if (!ALLOWED_DURATIONS.includes(durationMinutes)) return { error: '时长无效' };
  if (contentType && !contentTitle) return { error: '内容标题不能为空' };
  return {
    value: {
      action,
      activityType,
      contentType,
      contentTitle: contentType ? contentTitle.slice(0, 120) : '',
      durationMinutes
    }
  };
}

function maskUserId(userId) {
  const value = String(userId || '').trim();
  return value ? `QQ 尾号 ${value.slice(-4)}` : '';
}

function serializeRoom(room, now) {
  if (!room) return null;
  const durationMs = Math.max(1, Number(room.durationMs) || Number(room.durationMinutes) * 60000);
  const elapsedMs = Math.min(durationMs, Math.max(0, Number(room.elapsedMs) || 0));
  return {
    id: String(room.id || ''),
    activity_type: room.activityType,
    content_type: room.contentType || '',
    content_title: room.contentTitle || '',
    content_progress: room.contentProgress || '',
    density: room.density,
    duration_minutes: room.durationMinutes,
    status: room.status,
    started_at: room.startedAt,
    elapsed_ms: elapsedMs,
    remaining_ms: Math.max(0, durationMs - elapsedMs),
    progress_percent: Math.round((elapsedMs / durationMs) * 1000) / 10,
    fetched_at: now
  };
}

function serializeMemory(memory = {}) {
  return {
    id: String(memory.id || ''),
    activity_type: memory.activityType,
    content_type: memory.contentType || '',
    content_title: memory.contentTitle || '',
    progress: memory.progress || '',
    started_at: Number(memory.startedAt || 0),
    ended_at: Number(memory.endedAt || 0),
    duration_minutes: Number(memory.durationMinutes || 0),
    user_note: memory.userNote || '',
    bot_note: memory.botNote || '',
    completion: memory.completion
  };
}

function buildState(runtime, userId, now = Date.now()) {
  const configured = Boolean(userId);
  if (!configured || !runtime?.getUserSnapshot) {
    return {
      configured,
      enabled: false,
      running: false,
      bound_user_label: '',
      room: null,
      memories: [],
      fetched_at: now
    };
  }
  const snapshot = runtime.getUserSnapshot(userId, 12) || {};
  return {
    configured: true,
    enabled: snapshot.status?.enabled === true,
    running: snapshot.status?.running === true,
    bound_user_label: maskUserId(userId),
    room: serializeRoom(snapshot.room, now),
    memories: (snapshot.memories || []).map(serializeMemory),
    fetched_at: now
  };
}

function renderCompanionRoomPage(nonce) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <meta name="theme-color" content="#f65f79">
  <meta name="description" content="瑞希的陪伴房间">
  <link rel="manifest" href="/companion-room/manifest.webmanifest">
  <link rel="icon" href="/companion-room/icon-192.png">
  <link rel="apple-touch-icon" href="/companion-room/icon-192.png">
  <link rel="stylesheet" href="/companion-room/app.css">
  <title>瑞希的陪伴房间</title>
</head>
<body>
  <div id="offline-banner" class="offline-banner" hidden>当前离线，正在显示最近保存的房间状态。</div>
  <header class="app-header">
    <a class="brand" href="/companion-room" aria-label="瑞希的陪伴房间首页">
      <img src="/companion-room/icon-192.png" alt="" width="42" height="42">
      <span><strong>瑞希的陪伴房间</strong><small id="bound-user">正在连接</small></span>
    </a>
    <div class="header-actions">
      <button id="install-button" class="command-button" type="button" hidden>安装</button>
      <a class="command-button secondary" href="/">控制台</a>
    </div>
  </header>

  <main class="app-shell">
    <section class="room-stage" aria-labelledby="room-heading">
      <div class="room-copy">
        <div class="status-line"><span id="status-dot" class="status-dot"></span><span id="room-status">载入中</span></div>
        <h1 id="room-heading">给彼此留一段完整的时间</h1>
        <p id="room-subtitle">选好想做的事，我就在这里陪你。</p>

        <div id="timer-panel" class="timer-panel" hidden>
          <div id="timer" class="timer">45:00</div>
          <div class="progress-track" aria-hidden="true"><span id="timer-progress"></span></div>
          <div class="timer-meta"><span id="room-label">专注</span><span id="room-duration">45 分钟</span></div>
          <div class="room-actions">
            <button id="pause-button" class="icon-button" type="button" title="暂停" aria-label="暂停">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5v14M15 5v14"></path></svg>
            </button>
            <button id="resume-button" class="icon-button" type="button" title="继续" aria-label="继续" hidden>
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"></path></svg>
            </button>
            <button id="end-button" class="icon-button danger" type="button" title="结束" aria-label="结束">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"></rect></svg>
            </button>
          </div>
        </div>

        <div id="unavailable-panel" class="unavailable-panel" hidden>
          <strong id="unavailable-title">尚未完成绑定</strong>
          <p id="unavailable-text"></p>
        </div>
      </div>
      <figure class="portrait"><img src="/companion-room/portrait.webp" alt="瑞希" width="960" height="720"></figure>
    </section>

    <section id="start-section" class="workspace-section" aria-labelledby="start-heading">
      <div class="section-heading"><div><h2 id="start-heading">开始一段陪伴</h2><p>把时间交给眼前这一件事。</p></div></div>
      <form id="start-form" class="start-form">
        <fieldset>
          <legend>状态</legend>
          <div class="segmented-control">
            <label><input type="radio" name="activity" value="focus" checked><span>专注</span></label>
            <label><input type="radio" name="activity" value="relax"><span>放松</span></label>
          </div>
        </fieldset>
        <fieldset>
          <legend>一起做</legend>
          <div class="segmented-control four-up">
            <label><input type="radio" name="content" value="" checked><span>普通</span></label>
            <label><input type="radio" name="content" value="read"><span>共读</span></label>
            <label><input type="radio" name="content" value="watch"><span>共看</span></label>
            <label><input type="radio" name="content" value="listen"><span>共听</span></label>
          </div>
        </fieldset>
        <label id="title-field" class="field" hidden><span>标题</span><input id="content-title" type="text" maxlength="120" placeholder="我们要一起读、看或听什么"></label>
        <label class="field"><span>时长</span><select id="duration"><option value="15">15 分钟</option><option value="30">30 分钟</option><option value="45" selected>45 分钟</option><option value="60">60 分钟</option><option value="120">120 分钟</option></select></label>
        <button id="start-button" class="primary-button" type="submit">进入房间</button>
      </form>
    </section>

    <section id="active-section" class="workspace-section active-tools" aria-labelledby="active-heading" hidden>
      <div class="section-heading"><div><h2 id="active-heading">房间节奏</h2><p id="activity-detail">我们慢慢来。</p></div></div>
      <div class="tool-grid">
        <form id="density-form" class="tool-block">
          <h3>陪伴密度</h3>
          <div class="segmented-control three-up">
            <label><input type="radio" name="density" value="quiet"><span>安静</span></label>
            <label><input type="radio" name="density" value="occasional"><span>偶尔</span></label>
            <label><input type="radio" name="density" value="chatty"><span>多聊</span></label>
          </div>
        </form>
        <form id="progress-form" class="tool-block">
          <h3>内容进度</h3>
          <div class="inline-field"><input id="content-progress" type="text" maxlength="200" placeholder="例如：看到第 3 章"><button class="icon-button compact" type="submit" title="记录进度" aria-label="记录进度"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"></path></svg></button></div>
        </form>
      </div>
    </section>

    <section class="workspace-section memories-section" aria-labelledby="memories-heading">
      <div class="section-heading"><div><h2 id="memories-heading">最近共同回忆</h2><p>结束的房间会留在这里。</p></div><button id="refresh-button" class="icon-button compact" type="button" title="刷新" aria-label="刷新"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6v5h-5M4 18v-5h5M6.1 9a7 7 0 0 1 11.6-2.6L20 9M4 15l2.3 2.6A7 7 0 0 0 17.9 15"></path></svg></button></div>
      <div id="memory-list" class="memory-list"><p class="empty-state">还没有共同回忆。</p></div>
    </section>
  </main>

  <div id="toast" class="toast" role="status" aria-live="polite" hidden></div>
  <script nonce="${escapeHtml(nonce)}" src="/companion-room/app.js" defer></script>
</body>
</html>`;
}

function registerCompanionRoomRoutes(app, options = {}) {
  const runtime = options.companionRoomRuntime;
  const getUserId = () => String(options.userId ?? config.COMPANION_ROOM_WEB_USER_ID ?? '').trim();

  app.get(['/companion-room', '/companion-room/'], (req, res) => {
    if (String(req.originalUrl || '').split('?')[0] === '/companion-room') {
      return res.redirect('/companion-room/');
    }
    return res.type('html').send(renderCompanionRoomPage(res.locals.cspNonce));
  });
  app.get('/companion-room/manifest.webmanifest', (_req, res) => {
    return res.type('application/manifest+json').sendFile(path.join(ASSET_DIR, 'manifest.webmanifest'));
  });
  app.get('/companion-room/sw.js', (_req, res) => {
    res.setHeader('Service-Worker-Allowed', '/companion-room/');
    return res.type('application/javascript').sendFile(path.join(ASSET_DIR, 'sw.js'));
  });
  for (const asset of ['app.css', 'app.js', 'icon-192.png', 'icon-512.png', 'portrait.webp']) {
    app.get(`/companion-room/${asset}`, (_req, res) => res.sendFile(path.join(ASSET_DIR, asset)));
  }

  app.get('/api/companion-room/state', (_req, res) => {
    return res.json({ ok: true, ...buildState(runtime, getUserId()) });
  });

  app.post('/api/companion-room/action', async (req, res) => {
    const userId = getUserId();
    if (!userId) return res.status(409).json({ ok: false, error: '尚未配置陪伴房间绑定用户' });
    if (!runtime?.handleAction || !runtime?.getUserSnapshot) {
      return res.status(503).json({ ok: false, error: '陪伴房间运行时不可用' });
    }
    const normalized = normalizeActionInput(req.body);
    if (normalized.error) return res.status(400).json({ ok: false, error: normalized.error });
    const status = runtime.getStatus?.() || runtime.getUserSnapshot(userId, 0)?.status || {};
    if (!status.running || !status.enabled) {
      return res.status(409).json({ ok: false, error: '陪伴房间当前未启用' });
    }
    try {
      const result = await runtime.handleAction(userId, normalized.value);
      if (!result?.handled) return res.status(400).json({ ok: false, error: '房间操作未执行' });
      const memory = typeof result.afterReplySent === 'function' ? await result.afterReplySent() : null;
      return res.json({
        ok: true,
        code: result.code,
        message: result.replyText || '',
        memory: memory ? serializeMemory(memory) : null,
        state: buildState(runtime, userId)
      });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message || '房间操作失败' });
    }
  });
}

module.exports = {
  buildState,
  normalizeActionInput,
  registerCompanionRoomRoutes,
  renderCompanionRoomPage,
  serializeRoom
};
