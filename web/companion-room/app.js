/* global document, location, localStorage, navigator, window */

'use strict';

(function () {
  const CACHE_KEY = 'mizuki-companion-room-state-v1';
  const labels = {
    activity: { focus: '专注', relax: '放松' },
    content: { read: '共读', watch: '共看', listen: '共听' },
    density: { quiet: '安静陪伴', occasional: '偶尔说话', chatty: '多聊几句' }
  };
  const elements = {
    activeSection: document.getElementById('active-section'),
    activityDetail: document.getElementById('activity-detail'),
    boundUser: document.getElementById('bound-user'),
    contentProgress: document.getElementById('content-progress'),
    contentTitle: document.getElementById('content-title'),
    densityForm: document.getElementById('density-form'),
    duration: document.getElementById('duration'),
    endButton: document.getElementById('end-button'),
    installButton: document.getElementById('install-button'),
    memoryList: document.getElementById('memory-list'),
    offlineBanner: document.getElementById('offline-banner'),
    pauseButton: document.getElementById('pause-button'),
    progressForm: document.getElementById('progress-form'),
    refreshButton: document.getElementById('refresh-button'),
    resumeButton: document.getElementById('resume-button'),
    roomDuration: document.getElementById('room-duration'),
    roomHeading: document.getElementById('room-heading'),
    roomLabel: document.getElementById('room-label'),
    roomStatus: document.getElementById('room-status'),
    roomSubtitle: document.getElementById('room-subtitle'),
    startButton: document.getElementById('start-button'),
    startForm: document.getElementById('start-form'),
    startSection: document.getElementById('start-section'),
    statusDot: document.getElementById('status-dot'),
    timer: document.getElementById('timer'),
    timerPanel: document.getElementById('timer-panel'),
    timerProgress: document.getElementById('timer-progress'),
    titleField: document.getElementById('title-field'),
    toast: document.getElementById('toast'),
    unavailablePanel: document.getElementById('unavailable-panel'),
    unavailableText: document.getElementById('unavailable-text'),
    unavailableTitle: document.getElementById('unavailable-title')
  };
  let currentState = null;
  let installPrompt = null;
  let toastTimer = null;

  function saveCachedState(value) {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  }

  function readCachedState() {
    try {
      return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
    } catch (_) {
      return null;
    }
  }

  function showToast(message) {
    clearTimeout(toastTimer);
    elements.toast.textContent = message;
    elements.toast.hidden = false;
    toastTimer = setTimeout(function () { elements.toast.hidden = true; }, 3200);
  }

  function setBusy(busy) {
    for (const control of document.querySelectorAll('button, input, select')) {
      control.disabled = busy;
    }
  }

  async function requestJson(url, options) {
    const response = await fetch(url, Object.assign({ credentials: 'same-origin' }, options || {}));
    if (response.status === 401) {
      location.replace('/login?next=%2Fcompanion-room');
      throw new Error('登录状态已失效');
    }
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '请求失败');
    return data;
  }

  function formatClock(milliseconds) {
    const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0');
  }

  function roomElapsed(room) {
    if (!room) return 0;
    const durationMs = room.duration_minutes * 60000;
    const liveOffset = room.status === 'active' ? Math.max(0, Date.now() - Number(room.fetched_at || Date.now())) : 0;
    return Math.min(durationMs, Number(room.elapsed_ms || 0) + liveOffset);
  }

  function contentDescription(room) {
    if (!room.content_type || !room.content_title) return labels.activity[room.activity_type] || '陪伴';
    return (labels.content[room.content_type] || '一起') + '《' + room.content_title + '》';
  }

  function updateTimer() {
    const room = currentState && currentState.room;
    if (!room) return;
    const durationMs = room.duration_minutes * 60000;
    const elapsedMs = roomElapsed(room);
    elements.timer.textContent = formatClock(durationMs - elapsedMs);
    elements.timerProgress.style.width = Math.min(100, elapsedMs / durationMs * 100) + '%';
  }

  function setUnavailable(title, text) {
    elements.unavailableTitle.textContent = title;
    elements.unavailableText.textContent = text;
    elements.unavailablePanel.hidden = false;
  }

  function renderMemories(memories) {
    elements.memoryList.replaceChildren();
    if (!memories.length) {
      const empty = document.createElement('p');
      empty.className = 'empty-state';
      empty.textContent = '还没有共同回忆。';
      elements.memoryList.appendChild(empty);
      return;
    }
    for (const memory of memories) {
      const item = document.createElement('article');
      item.className = 'memory-item';
      const time = document.createElement('time');
      time.className = 'memory-time';
      time.dateTime = new Date(memory.ended_at).toISOString();
      time.textContent = new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(memory.ended_at);
      const main = document.createElement('div');
      main.className = 'memory-main';
      const title = document.createElement('strong');
      const content = memory.content_type && memory.content_title
        ? (labels.content[memory.content_type] || '一起') + '《' + memory.content_title + '》'
        : (labels.activity[memory.activity_type] || '陪伴');
      title.textContent = content;
      const note = document.createElement('p');
      note.textContent = [memory.progress, memory.user_note, memory.bot_note].filter(Boolean).join(' · ');
      const duration = document.createElement('span');
      duration.className = 'memory-duration';
      duration.textContent = memory.duration_minutes + ' 分钟';
      main.append(title, note);
      item.append(time, main, duration);
      elements.memoryList.appendChild(item);
    }
  }

  function renderState(state, options) {
    currentState = state;
    const cached = options && options.cached;
    elements.offlineBanner.hidden = !cached && navigator.onLine;
    elements.boundUser.textContent = state.bound_user_label || (state.configured ? '已绑定' : '等待绑定');
    elements.timerPanel.hidden = true;
    elements.activeSection.hidden = true;
    elements.startSection.hidden = true;
    elements.unavailablePanel.hidden = true;
    elements.statusDot.className = 'status-dot';

    if (!state.configured) {
      elements.roomStatus.textContent = '尚未绑定用户';
      elements.roomHeading.textContent = '先把这个房间交给一个人';
      elements.roomSubtitle.textContent = '完成绑定后，网页与 QQ 会共享同一个房间状态。';
      setUnavailable('缺少绑定用户', '请在环境配置中设置 COMPANION_ROOM_WEB_USER_ID。');
    } else if (!state.enabled || !state.running) {
      elements.roomStatus.textContent = '房间功能未启用';
      elements.roomHeading.textContent = '房间已经准备好了';
      elements.roomSubtitle.textContent = '启用陪伴插件后，就能从这里进入房间。';
      setUnavailable('等待启用', '在 QQ 私聊中发送“/陪伴插件 开启”，然后刷新当前页面。');
    } else if (!state.room) {
      elements.roomStatus.textContent = '现在没有进行中的房间';
      elements.roomHeading.textContent = '给彼此留一段完整的时间';
      elements.roomSubtitle.textContent = '选好想做的事，我就在这里陪你。';
      elements.startSection.hidden = false;
    } else {
      const room = state.room;
      const paused = room.status === 'paused';
      elements.statusDot.classList.add(paused ? 'paused' : 'active');
      elements.roomStatus.textContent = paused ? '房间已暂停' : '房间进行中';
      elements.roomHeading.textContent = contentDescription(room);
      elements.roomSubtitle.textContent = room.content_progress || labels.density[room.density] || '我们慢慢来。';
      elements.roomLabel.textContent = (labels.activity[room.activity_type] || '陪伴') + ' · ' + (labels.density[room.density] || '偶尔说话');
      elements.roomDuration.textContent = room.duration_minutes + ' 分钟';
      elements.pauseButton.hidden = paused;
      elements.resumeButton.hidden = !paused;
      elements.timerPanel.hidden = false;
      elements.activeSection.hidden = false;
      elements.activityDetail.textContent = contentDescription(room) + (room.content_progress ? ' · ' + room.content_progress : '');
      elements.progressForm.hidden = !room.content_type;
      elements.contentProgress.value = room.content_progress || '';
      const densityInput = elements.densityForm.querySelector('input[value="' + room.density + '"]');
      if (densityInput) densityInput.checked = true;
      updateTimer();
    }
    renderMemories(state.memories || []);
  }

  async function loadState(options) {
    try {
      const data = await requestJson('/api/companion-room/state');
      saveCachedState(data);
      renderState(data);
      return data;
    } catch (error) {
      const cached = readCachedState();
      if (cached) {
        renderState(cached, { cached: true });
      } else {
        renderState({ configured: false, enabled: false, running: false, room: null, memories: [], bound_user_label: '' }, { cached: true });
      }
      if (!options || !options.quiet) showToast(error.message);
      return null;
    }
  }

  async function performAction(payload) {
    setBusy(true);
    try {
      const data = await requestJson('/api/companion-room/action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      saveCachedState(data.state);
      renderState(data.state);
      if (data.message) showToast(data.message);
    } catch (error) {
      showToast(error.message);
    } finally {
      setBusy(false);
    }
  }

  elements.startForm.addEventListener('submit', function (event) {
    event.preventDefault();
    const activity = elements.startForm.querySelector('input[name="activity"]:checked').value;
    const content = elements.startForm.querySelector('input[name="content"]:checked').value;
    performAction({
      action: 'start',
      activity_type: activity,
      content_type: content,
      content_title: content ? elements.contentTitle.value : '',
      duration_minutes: Number(elements.duration.value)
    });
  });

  elements.startForm.addEventListener('change', function (event) {
    if (event.target.name !== 'content') return;
    const content = event.target.value;
    elements.titleField.hidden = !content;
    elements.contentTitle.required = Boolean(content);
    if (content === 'read') elements.startForm.querySelector('input[name="activity"][value="focus"]').checked = true;
    if (content === 'watch' || content === 'listen') elements.startForm.querySelector('input[name="activity"][value="relax"]').checked = true;
  });

  elements.pauseButton.addEventListener('click', function () { performAction({ action: 'pause' }); });
  elements.resumeButton.addEventListener('click', function () { performAction({ action: 'resume' }); });
  elements.endButton.addEventListener('click', function () { performAction({ action: 'end' }); });
  elements.progressForm.addEventListener('submit', function (event) {
    event.preventDefault();
    performAction({ action: 'progress', progress: elements.contentProgress.value });
  });
  elements.densityForm.addEventListener('change', function (event) {
    if (event.target.name === 'density') performAction({ action: 'density', density: event.target.value });
  });
  elements.refreshButton.addEventListener('click', function () { loadState(); });

  window.addEventListener('online', function () { loadState({ quiet: true }); });
  window.addEventListener('offline', function () { elements.offlineBanner.hidden = false; });
  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    installPrompt = event;
    elements.installButton.hidden = false;
  });
  window.addEventListener('appinstalled', function () {
    installPrompt = null;
    elements.installButton.hidden = true;
  });
  elements.installButton.addEventListener('click', async function () {
    if (!installPrompt) return;
    await installPrompt.prompt();
    installPrompt = null;
    elements.installButton.hidden = true;
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/companion-room/sw.js').catch(function () {});
  }
  loadState();
  setInterval(updateTimer, 1000);
  setInterval(function () {
    if (!document.hidden && navigator.onLine) loadState({ quiet: true });
  }, 5000);
}());
