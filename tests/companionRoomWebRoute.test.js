const assert = require('assert');
const fs = require('fs');
const path = require('path');

const config = require('../config');
const { createWebApp } = require('../web/server');
const { buildState, normalizeActionInput, serializeRoom } = require('../web/companionRoomRoute');

async function listen(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

module.exports = (async () => {
  assert.deepStrictEqual(normalizeActionInput({ action: 'pause' }).value, { action: 'pause' });
  assert.deepStrictEqual(normalizeActionInput({ action: 'density', density: 'occasional' }).value, {
    action: 'density',
    density: 'occasional'
  });
  assert.strictEqual(normalizeActionInput({ action: 'start', activity_type: 'focus', content_type: 'read', duration_minutes: 45 }).error, '内容标题不能为空');
  assert.strictEqual(normalizeActionInput({ action: 'start', activity_type: 'focus', content_type: '', duration_minutes: 20 }).error, '时长无效');

  const room = serializeRoom({
    id: 'room-1',
    activityType: 'focus',
    contentType: 'read',
    contentTitle: '三体',
    contentProgress: '第 3 章',
    density: 'quiet',
    durationMinutes: 30,
    durationMs: 1800000,
    elapsedMs: 600000,
    status: 'active',
    startedAt: 1
  }, 1000);
  assert.strictEqual(room.remaining_ms, 1200000);
  assert.strictEqual(room.progress_percent, 33.3);

  const calls = [];
  let currentRoom = null;
  const memories = [];
  const runtime = {
    getStatus: () => ({ running: true, enabled: true }),
    getUserSnapshot(userId) {
      calls.push({ type: 'snapshot', userId });
      return {
        status: { running: true, enabled: true },
        room: currentRoom,
        memories
      };
    },
    async handleAction(userId, action) {
      calls.push({ type: 'action', userId, action });
      if (action.action === 'start') {
        currentRoom = {
          id: 'room-web',
          activityType: action.activityType,
          contentType: action.contentType,
          contentTitle: action.contentTitle,
          contentProgress: '',
          density: 'occasional',
          durationMinutes: action.durationMinutes,
          durationMs: action.durationMinutes * 60000,
          elapsedMs: 0,
          status: 'active',
          startedAt: Date.now()
        };
        return { handled: true, code: 'started', replyText: '房间开始了。', room: currentRoom };
      }
      if (action.action === 'end') {
        const completed = currentRoom;
        return {
          handled: true,
          code: 'ended',
          replyText: '房间结束了。',
          afterReplySent() {
            const memory = {
              id: completed.id,
              activityType: completed.activityType,
              contentType: completed.contentType,
              contentTitle: completed.contentTitle,
              durationMinutes: completed.durationMinutes,
              endedAt: Date.now(),
              botNote: '这段时间很安静。',
              completion: 'ended_early'
            };
            currentRoom = null;
            memories.push(memory);
            return memory;
          }
        };
      }
      return { handled: true, code: action.action, replyText: '已更新。', room: currentRoom };
    }
  };

  const empty = buildState(runtime, '');
  assert.strictEqual(empty.configured, false);
  const bound = buildState(runtime, '123456789');
  assert.strictEqual(bound.bound_user_label, 'QQ 尾号 6789');
  assert.deepStrictEqual(calls.at(-1), { type: 'snapshot', userId: '123456789' });

  const configSnapshot = {
    COMPANION_ROOM_WEB_USER_ID: config.COMPANION_ROOM_WEB_USER_ID,
    WEB_AUDIT_LOG_FILE: config.WEB_AUDIT_LOG_FILE,
    WEB_BIND_HOST: config.WEB_BIND_HOST,
    WEB_LOCAL_ONLY_WITHOUT_TOKEN: config.WEB_LOCAL_ONLY_WITHOUT_TOKEN,
    WEB_LOGIN_RATE_LIMIT_STATE_FILE: config.WEB_LOGIN_RATE_LIMIT_STATE_FILE,
    WEB_REQUIRE_HTTPS: config.WEB_REQUIRE_HTTPS,
    WEB_TOKEN: config.WEB_TOKEN,
    WEB_TRUST_PROXY_HOPS: config.WEB_TRUST_PROXY_HOPS,
    WEB_VIEWER_TOKEN: config.WEB_VIEWER_TOKEN
  };
  Object.assign(config, {
    COMPANION_ROOM_WEB_USER_ID: '123456789',
    WEB_AUDIT_LOG_FILE: '',
    WEB_BIND_HOST: '127.0.0.1',
    WEB_LOCAL_ONLY_WITHOUT_TOKEN: false,
    WEB_LOGIN_RATE_LIMIT_STATE_FILE: '',
    WEB_REQUIRE_HTTPS: false,
    WEB_TOKEN: 'companion-room-admin',
    WEB_TRUST_PROXY_HOPS: 0,
    WEB_VIEWER_TOKEN: 'companion-room-viewer'
  });

  const web = createWebApp({ companionRoomRuntime: runtime });
  const server = await listen(web.app);
  try {
    const redirected = await fetch(`${server.baseUrl}/companion-room`, { redirect: 'manual' });
    assert.strictEqual(redirected.status, 302);
    assert.strictEqual(redirected.headers.get('location'), '/login?next=%2Fcompanion-room');

    const login = await fetch(`${server.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ token: 'companion-room-admin' })
    });
    assert.strictEqual(login.status, 201);
    await login.text();
    const cookie = login.headers.get('set-cookie').split(';')[0];

    const page = await fetch(`${server.baseUrl}/companion-room/`, { headers: { Cookie: cookie } });
    assert.strictEqual(page.status, 200);
    assert.strictEqual(page.url, `${server.baseUrl}/companion-room/`);
    assert.match(await page.text(), /瑞希的陪伴房间/);

    const manifest = await fetch(`${server.baseUrl}/companion-room/manifest.webmanifest`, { headers: { Cookie: cookie } });
    assert.strictEqual(manifest.status, 200);
    assert.strictEqual((await manifest.json()).start_url, '/companion-room/');

    const serviceWorker = await fetch(`${server.baseUrl}/companion-room/sw.js`, { headers: { Cookie: cookie } });
    assert.strictEqual(serviceWorker.status, 200);
    assert.strictEqual(serviceWorker.headers.get('service-worker-allowed'), '/companion-room/');
    assert.match(await serviceWorker.text(), /CACHE_NAME/);

    const state = await fetch(`${server.baseUrl}/api/companion-room/state`, { headers: { Cookie: cookie } });
    assert.strictEqual(state.status, 200);
    assert.strictEqual((await state.json()).bound_user_label, 'QQ 尾号 6789');

    const noOrigin = await fetch(`${server.baseUrl}/api/companion-room/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ action: 'pause' })
    });
    assert.strictEqual(noOrigin.status, 403);

    const started = await fetch(`${server.baseUrl}/api/companion-room/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: server.baseUrl },
      body: JSON.stringify({
        action: 'start',
        activity_type: 'focus',
        content_type: 'read',
        content_title: '三体',
        duration_minutes: 30
      })
    });
    assert.strictEqual(started.status, 200);
    assert.strictEqual((await started.json()).state.room.content_title, '三体');
    assert.strictEqual(calls.filter((entry) => entry.type === 'action').at(-1).userId, '123456789');

    const ended = await fetch(`${server.baseUrl}/api/companion-room/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: server.baseUrl },
      body: JSON.stringify({ action: 'end' })
    });
    const endedBody = await ended.json();
    assert.strictEqual(ended.status, 200);
    assert.strictEqual(endedBody.state.room, null);
    assert.strictEqual(endedBody.state.memories.length, 1);
    assert.strictEqual(calls.some((entry) => entry.userId && entry.userId !== '123456789'), false);

    const viewerLogin = await fetch(`${server.baseUrl}/api/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: server.baseUrl },
      body: JSON.stringify({ token: 'companion-room-viewer' })
    });
    assert.strictEqual(viewerLogin.status, 201);
    await viewerLogin.text();
    const viewerCookie = viewerLogin.headers.get('set-cookie').split(';')[0];
    const viewerWrite = await fetch(`${server.baseUrl}/api/companion-room/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: viewerCookie, Origin: server.baseUrl },
      body: JSON.stringify({ action: 'pause' })
    });
    assert.strictEqual(viewerWrite.status, 403);

    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'web', 'companion-room', 'icon-192.png')), true);
    assert.strictEqual(fs.existsSync(path.join(__dirname, '..', 'web', 'companion-room', 'icon-512.png')), true);
  } finally {
    await server.close();
    web.sessionManager.stop();
    Object.assign(config, configSnapshot);
  }

  console.log('companionRoomWebRoute.test.js passed');
})().catch((error) => {
  console.error(error && error.stack ? error.stack : String(error));
  process.exit(1);
});
